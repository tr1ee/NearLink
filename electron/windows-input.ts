import {
  utilityProcess,
  MessageChannelMain,
  type WebContents,
  type UtilityProcess,
} from "electron";
import path from "node:path";
import type { InputScope } from "./input-state";
import type { DevelopmentInputHelper } from "./development-input-helper";
export class WindowsInputService {
  private child?: UtilityProcess;
  private scope: InputScope | null = null;
  ready = false;
  private helper: { active: boolean; pid?: number; state?: string } = {
    active: false,
  };
  private handledAuthority?: string;
  private serviceMapping?: string;
  constructor(
    private nativePath: string,
    private report: (event: string, details?: any) => void = () => {},
    private entry = path.join(__dirname, "input-worker.cjs"),
    private developmentHelper?: DevelopmentInputHelper,
    private authorizeService?: (
      authority: string,
      challenge: string,
    ) => Promise<{ certificate: string; proof: string }>,
  ) {}
  start() {
    return new Promise<void>((resolve, reject) => {
      const child = (this.child = utilityProcess.fork(
        this.entry.replace(/\.asar([\\/])/, ".asar.unpacked$1"),
        [],
        {
          serviceName: "NearLink Windows Input",
          stdio: "pipe",
        },
      ));
      let startupError = "";
      child.stderr?.on("data", (chunk) => {
        startupError = (startupError + String(chunk)).slice(-1200);
      });
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("Windows输入后台进程启动超时"));
      }, 10000);
      child.once("spawn", () =>
        child.postMessage({
          type: "init",
          parentPid: process.pid,
          nativePath: this.nativePath.replace(
            /\.asar([\\/])/,
            ".asar.unpacked$1",
          ),
          helper: this.developmentHelper,
          installedService: !!this.authorizeService,
        }),
      );
      child.on("message", (m) => {
        if (m?.type === "ready") {
          clearTimeout(timer);
          this.ready = true;
          this.report("ready", { pid: m.pid });
          resolve();
        } else if (m?.type === "failed") {
          clearTimeout(timer);
          child.kill();
          reject(Error(m.message));
        } else if (
          m?.type === "service-proof-request" &&
          this.authorizeService
        ) {
          const authority = m.authority;
          if (
            typeof authority !== "string" ||
            typeof m.challenge !== "string" ||
            m.challenge.length > 511
          )
            return;
          void this.authorizeService(authority, m.challenge).then(
            (proof) =>
              child.postMessage({ type: "service-proof", authority, proof }),
            () =>
              child.postMessage({
                type: "service-proof",
                authority,
                error: "对端需要同步支持安装式服务认证的版本",
              }),
          );
        } else if (m?.type === "helper-status") {
          this.serviceMapping =
            m.active && typeof m.mapping === "string" ? m.mapping : undefined;
          this.helper = {
            active: m.active === true,
            pid: m.pid,
            state: m.state,
          };
          if (
            !["awaiting-local-approval", "awaiting-peer-proof"].includes(
              m.state,
            )
          )
            this.handledAuthority = m.authority;
          this.report("helper-status", this.helper);
        } else if (m?.type === "helper-diagnostic") {
          this.report("helper-diagnostic", m.sample);
        } else if (
          m?.type === "mouse-diagnostics" &&
          Array.isArray(m.samples)
        ) {
          for (const sample of m.samples) this.report("mouse-gesture", sample);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        this.ready = false;
        this.report("exit", { exitCode: code });
        reject(Error(`Windows输入后台进程已退出 (${code}) ${startupError}`));
      });
    });
  }
  configure(scope: InputScope | null) {
    this.scope = scope;
    if (this.ready) this.child?.postMessage({ type: "configure", scope });
  }
  attach(contents: WebContents) {
    if (!this.ready || !this.child) throw Error("Windows输入后台进程尚未就绪");
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: "attach" }, [port1]);
    this.child.postMessage({ type: "configure", scope: this.scope });
    contents.postMessage("nearlink:input-port", null, [port2]);
    this.report("port-attached", { renderer: contents.id });
  }
  release() {
    if (this.ready) this.child?.postMessage({ type: "release" });
  }
  status() {
    return { ready: this.ready, pid: this.child?.pid, helper: this.helper };
  }
  captureMapping(sessionId: string) {
    if (
      !this.authorizeService ||
      this.scope?.sessionId !== sessionId ||
      !this.scope.serviceActive ||
      !this.helper.active ||
      !this.serviceMapping
    )
      throw Error("服务采集授权尚未就绪");
    return this.serviceMapping;
  }
  async waitForAuthorization(sessionId: string) {
    const deadline = Date.now() + 180000;
    while (
      (this.developmentHelper || this.authorizeService) &&
      (this.scope?.allowed || this.scope?.serviceActive) &&
      this.scope.sessionId === sessionId &&
      this.scope.authority &&
      this.handledAuthority !== this.scope.authority
    ) {
      if (!this.ready || Date.now() >= deadline)
        throw Error("本机输入授权尚未完成，请在 Windows 本机处理授权。");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  async stop() {
    this.configure(null);
    const child = this.child;
    if (!child || !this.ready) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "shutdown" });
    });
    this.ready = false;
  }
}
