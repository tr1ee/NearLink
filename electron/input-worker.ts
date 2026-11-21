import { InputState, type InputScope } from "./input-state";
// No Electron UI APIs here: this process owns native input independently of
// the browser process and Windows' nested non-client mouse tracking loop.
const parent = process.parentPort!;
let state: InputState | undefined;
let port: Electron.MessagePortMain | undefined;
let takeMouseDiagnostics: (() => unknown) | undefined;
let native: any;
let helperOptions: { path: string; sha256: string } | undefined;
let latestScope: InputScope | null = null;
let pendingApproval = false;
let helperAuthority = "";
let attemptedAuthority = "";
let lastHelperDiagnostic = "";
let installedService = false;
let serviceAuthority = "";
let serviceFailed = false;
let proofReply:
  | { authority: string; resolve: (v: any) => void; reject: (e: Error) => void }
  | undefined;

async function configureService(scope: InputScope | null) {
  latestScope = scope;
  if (pendingApproval) {
    if (!scope?.serviceActive || scope.authority !== attemptedAuthority) {
      proofReply?.reject(Error("会话已撤销"));
      proofReply = undefined;
      native.stopDesktopService();
    }
    return;
  }
  if (serviceFailed) {
    state?.configure(null);
    return;
  }
  if (
    serviceAuthority &&
    (!scope?.serviceActive || scope.authority !== serviceAuthority)
  ) {
    state?.configure(null);
    if (!native.stopDesktopService()) {
      serviceFailed = true;
      helperStatus(false, "service-cleanup-unconfirmed");
      return;
    }
    serviceAuthority = "";
    helperStatus(false, "service-stopped");
  }
  if (!scope?.serviceActive || !scope.authority) {
    state?.configure(null);
    return;
  }
  if (!serviceAuthority && scope.authority !== attemptedAuthority) {
    state?.configure(null);
    pendingApproval = true;
    attemptedAuthority = scope.authority;
    helperStatus(false, "awaiting-peer-proof");
    try {
      const challenge = native.beginDesktopService({
        authority: scope.authority,
        allowed: scope.allowed,
      });
      if (typeof challenge !== "string") throw Error("服务不可用或安装不匹配");
      const proof = await new Promise<any>((resolve, reject) => {
        proofReply = { authority: scope.authority!, resolve, reject };
        parent.postMessage({
          type: "service-proof-request",
          authority: scope.authority,
          challenge,
        });
      });
      if (
        latestScope?.authority !== scope.authority ||
        !latestScope?.serviceActive ||
        !native.authenticateDesktopService(proof)
      )
        throw Error("服务认证失败");
      serviceAuthority = scope.authority;
      helperStatus(true, "service-ready");
    } catch {
      native.stopDesktopService();
      helperStatus(false, "service-authentication-failed");
    } finally {
      pendingApproval = false;
      proofReply = undefined;
    }
    await configureService(latestScope);
    return;
  }
  if (!serviceAuthority) {
    state?.configure(null);
    return;
  }
  if (
    !native.configureDesktopService({
      allowed: scope.allowed,
      ...scope.display,
    })
  ) {
    state?.configure(null);
    helperStatus(false, "service-configure-failed");
    return;
  }
  state?.configure(scope);
}

function helperStatus(active: boolean, status: string) {
  parent.postMessage({
    type: "helper-status",
    active,
    state: status,
    authority: attemptedAuthority,
    pid: active
      ? installedService
        ? native.desktopServiceStatus?.().pid
        : native.inputHelperPid?.()
      : undefined,
    mapping:
      active && installedService
        ? native.desktopServiceStatus?.().mapping
        : undefined,
  });
}

async function configureScope(scope: InputScope | null) {
  if (installedService) return configureService(scope);
  latestScope = scope;
  if (pendingApproval) {
    if (!scope?.allowed || scope.authority !== attemptedAuthority)
      native.cancelInputHelper?.();
    return;
  }
  state?.configure(scope);
  if (!helperOptions) return;
  if (
    helperAuthority &&
    native.inputHelperPid?.() === 0 &&
    native.stopInputHelper()
  ) {
    helperAuthority = "";
    helperStatus(false, "stopped-after-confirmed-cleanup");
  }
  if (
    helperAuthority &&
    (!scope?.allowed || scope.authority !== helperAuthority)
  ) {
    if (!native.stopInputHelper()) {
      state?.configure(null);
      helperStatus(
        true,
        "release-pending:" + (native.inputHelperFailure?.() || "unconfirmed"),
      );
      return;
    }
    helperAuthority = "";
    helperStatus(false, "stopped");
  }
  const authority = scope?.allowed ? scope.authority : undefined;
  if (authority && !helperAuthority && authority !== attemptedAuthority) {
    // Keep processing MessagePort/parent events while Windows awaits local
    // approval. No input queued during approval is replayed after approval.
    state?.configure(null);
    pendingApproval = true;
    attemptedAuthority = authority;
    helperStatus(false, "awaiting-local-approval");
    try {
      const ready = await native.startInputHelper({
        ...helperOptions,
        authority,
      });
      if (ready) helperAuthority = authority;
      helperStatus(
        ready === true,
        ready
          ? "ready"
          : native.inputHelperFailure?.() || "declined-or-untrusted",
      );
    } catch {
      helperStatus(false, "unavailable");
    } finally {
      pendingApproval = false;
    }
    // Scope, connection or port may have been revoked while UAC was open.
    await configureScope(latestScope);
    return;
  }
  if (helperAuthority) {
    if (
      !native.configureInputHelper({ allowed: !!scope?.allowed, authority })
    ) {
      state?.configure(null);
      helperStatus(
        true,
        "release-pending:" + (native.inputHelperFailure?.() || "unconfirmed"),
      );
    }
  }
}

function flushMouseDiagnostics() {
  try {
    if (!pendingApproval && helperAuthority && native.inputHelperDiagnostics) {
      const sample = native.inputHelperDiagnostics();
      const key = JSON.stringify(sample);
      if (key !== lastHelperDiagnostic) {
        lastHelperDiagnostic = key;
        parent.postMessage({ type: "helper-diagnostic", sample });
      }
    }
    const samples = takeMouseDiagnostics?.();
    if (Array.isArray(samples) && samples.length)
      parent.postMessage({ type: "mouse-diagnostics", samples });
  } catch {
    // Diagnostics must not interrupt the input lease or native releases.
  }
}

parent.on("message", (event: any) => {
  const m = event.data;
  if (
    m?.type === "service-proof" &&
    proofReply &&
    proofReply.authority === m.authority
  ) {
    if (m.error) proofReply.reject(Error(m.error));
    else proofReply.resolve(m.proof);
    proofReply = undefined;
  } else if (m?.type === "init") {
    try {
      native = require(m.nativePath);
      if (native.watchInputOwner && !native.watchInputOwner(m.parentPid))
        throw Error("无法监视输入所属进程");
      helperOptions = m.helper;
      installedService = m.installedService === true;
      state = new InputState((input) => native.input(input));
      takeMouseDiagnostics =
        typeof native.takeMouseDiagnostics === "function"
          ? native.takeMouseDiagnostics
          : undefined;
      parent.postMessage({ type: "ready", pid: process.pid });
    } catch (error: any) {
      parent.postMessage({
        type: "failed",
        message: String(error.message).slice(0, 400),
      });
    }
  } else if (m?.type === "configure")
    void configureScope(m.scope as InputScope | null);
  else if (m?.type === "release") {
    if (!pendingApproval) state?.release();
  } else if (m?.type === "attach") {
    const previous = port;
    port = event.ports[0];
    previous?.close();
    if (!pendingApproval) state?.release();
    const current = port!;
    current.on("message", (e: any) => {
      if (port !== current || !state) return;
      const message = e.data;
      if (pendingApproval) {
        if (
          message?.type === "stop" &&
          message.sessionId === latestScope?.sessionId
        )
          void configureScope(null);
        if (message?.type === "input")
          current.postMessage({ id: message.id, result: "unauthorized" });
        return;
      }
      try {
        if (message?.type === "heartbeat") {
          if (
            installedService &&
            serviceAuthority &&
            latestScope?.serviceActive &&
            message.sessionId === latestScope.sessionId
          ) {
            state.heartbeat(message.sessionId);
            if (!native.heartbeatDesktopService()) void configureService(null);
            return;
          }
          if (
            state.heartbeat(message.sessionId) &&
            helperAuthority &&
            !native.heartbeatInputHelper()
          ) {
            if (native.stopInputHelper()) {
              helperAuthority = "";
              helperStatus(false, "transport-stopped-after-cleanup");
            }
          }
          return;
        }
        if (message?.type === "stop") {
          if (state.stop(message.sessionId)) void configureScope(null);
          return;
        }
        if (message?.type !== "input" || !Number.isSafeInteger(message.id))
          return;
        const result = state.applyResult(message.sessionId, message.input);
        current.postMessage({ id: message.id, result });
      } catch {
        current.postMessage({
          id: message?.id,
          error: "输入参数无效或系统拒绝注入",
        });
      }
    });
    current.on("close", () => {
      if (port === current) {
        void configureScope(null);
        port = undefined;
      }
    });
    current.start();
  } else if (m?.type === "shutdown") {
    if (installedService) {
      proofReply?.reject(Error("进程退出"));
      proofReply = undefined;
      state?.configure(null);
      native.stopDesktopService();
      process.exit(0);
    }
    if (pendingApproval) native.cancelInputHelper?.();
    else {
      state?.configure(null);
      native?.stopInputHelper?.();
    }
    flushMouseDiagnostics();
    process.exit(0);
  }
});
const timer = setInterval(() => {
  if (
    !pendingApproval &&
    helperAuthority &&
    native.inputHelperPid?.() === 0 &&
    native.stopInputHelper()
  ) {
    helperAuthority = "";
    helperStatus(false, "stopped-after-confirmed-cleanup");
  }
  if (native?.inputOwnerAlive && !native.inputOwnerAlive()) {
    if (installedService) {
      native.stopDesktopService();
      process.exit(0);
    }
    if (pendingApproval) native.cancelInputHelper?.();
    else {
      state?.configure(null);
      native.stopInputHelper?.();
    }
    process.exit(0);
  }
  if (!pendingApproval) state?.expire();
  flushMouseDiagnostics();
}, 500);
timer.unref();
process.on("exit", () => {
  if (!pendingApproval) state?.release();
});
