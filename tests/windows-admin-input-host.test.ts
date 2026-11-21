import { test } from "node:test";
import assert from "node:assert/strict";
import { InputState } from "../electron/input-state";
import { WindowsAdminInputPolicy } from "../electron/windows-admin-input-policy";
import {
  checkWindowsAdminInputTrust,
  type WindowsAdminInputTrustEvidence,
} from "../electron/windows-admin-input-trust";
import {
  approval,
  command,
  environment,
  key,
  source,
} from "./fixtures/windows-admin-input-cases";
import {
  WindowsAdminInputHostFixture,
  type HostObservation,
} from "./fixtures/windows-admin-input-host";

const publisher = "9".repeat(64);
const publishers = new Set([publisher]);

function verifiedCandidate(): WindowsAdminInputTrustEvidence {
  return {
    authenticode: {
      status: "valid",
      publisherKeySha256: publisher,
      imageIdentity: "fixture-image",
    },
    install: {
      imageIdentity: "fixture-image",
      underApprovedRoot: true,
      imageAndParentsProtected: true,
      dependenciesProtected: true,
      pathResolutionVerified: true,
    },
  };
}

function fixture(allowlist: ReadonlySet<string> = publishers) {
  const localEvents: string[] = [];
  const diagnostics: string[] = [];
  let releaseAllowed = true;
  const medium = new InputState((event) => {
    localEvents.push(event.type);
    return event.type !== "release" || releaseAllowed;
  });
  medium.configure({
    allowed: true,
    sessionId: source.sessionId,
    display: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  localEvents.length = 0;
  const env: HostObservation = {
    ...environment(),
    trustEvidence: verifiedCandidate(),
    inputDesktopVerified: true,
  };
  const host = new WindowsAdminInputHostFixture(medium, allowlist, (event) =>
    diagnostics.push(event),
  );
  return {
    host,
    env,
    medium,
    localEvents,
    diagnostics,
    refuseRelease: () => {
      releaseAllowed = false;
    },
  };
}

test("缺少生产发行者策略时拒绝管理员入口，普通已授权输入继续工作", () => {
  const { host, env, localEvents, diagnostics } = fixture(new Set());
  assert.equal(host.approveLocally(approval, env), null);
  assert.deepEqual(host.candidateInput(command(), source, env), {
    route: "reject",
  });
  assert.equal(host.ordinaryInput("wrong-session", key, env), "unauthorized");
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "applied");
  assert.deepEqual(localEvents, ["key"]);
  assert.deepEqual(diagnostics, ["publisher-policy-missing"]);
});

test("发行信任同时要求 Authenticode、固定发布者和同一受保护镜像", () => {
  const evidence = verifiedCandidate();
  assert.equal(checkWindowsAdminInputTrust(evidence, publishers).allowed, true);
  const cases = [
    [null, "authenticode-unverified"],
    [
      {
        ...evidence,
        authenticode: { ...evidence.authenticode, status: "invalid" },
      },
      "authenticode-unverified",
    ],
    [
      {
        ...evidence,
        authenticode: {
          ...evidence.authenticode,
          publisherKeySha256: "8".repeat(64),
        },
      },
      "publisher-mismatch",
    ],
    [
      {
        ...evidence,
        install: { ...evidence.install, imageIdentity: "replacement-image" },
      },
      "verified-image-mismatch",
    ],
    ...(
      [
        "underApprovedRoot",
        "imageAndParentsProtected",
        "dependenciesProtected",
        "pathResolutionVerified",
      ] as const
    ).map(
      (property) =>
        [
          { ...evidence, install: { ...evidence.install, [property]: false } },
          "installation-unprotected",
        ] as const,
    ),
  ] as const;
  for (const [candidate, reason] of cases) {
    assert.deepEqual(checkWindowsAdminInputTrust(candidate, publishers), {
      allowed: false,
      reason,
    });
    const { host, env, localEvents, diagnostics } = fixture();
    env.trustEvidence = candidate;
    assert.equal(host.approveLocally(approval, env), null);
    assert.deepEqual(localEvents, []);
    assert.deepEqual(diagnostics, [reason]);
  }
});

test("同一输入桌面及本机批准通过后才尝试从 Medium 交接", () => {
  const { host, env, localEvents, diagnostics, refuseRelease } = fixture();
  assert.equal(
    host.approveLocally({ ...approval, confirmedOnConsole: false }, env),
    null,
  );
  assert.equal(
    host.approveLocally(approval, { ...env, inputDesktopVerified: false }),
    null,
  );
  assert.deepEqual(localEvents, []);
  refuseRelease();
  assert.equal(host.approveLocally({ ...approval, serial: 2 }, env), null);
  assert.deepEqual(localEvents, ["release"]);
  assert.deepEqual(diagnostics, Array(3).fill("local-approval-refused"));
});

test("普通按下经原 InputState 交接，释放确认前不会由两个输入路径执行", () => {
  const { host, env, localEvents, diagnostics } = fixture();
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "applied");
  assert.equal(host.approveLocally(approval, env), approval.serial);
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "unauthorized");
  assert.deepEqual(localEvents, ["key", "release"]);
  assert.deepEqual(host.candidateInput(command(), source, env), {
    route: "helper",
    grant: approval.serial,
    event: key,
  });
  assert.deepEqual(host.stopLocally(), {
    route: "reject",
    releaseGrant: approval.serial,
  });
  assert.equal(host.acknowledgeCleanup(approval.serial, env, false), false);
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "unauthorized");
  assert.equal(host.acknowledgeCleanup(approval.serial, env, true), true);
  assert.deepEqual(host.candidateInput(command(1), source, env), {
    route: "reject",
  });
  assert.deepEqual(localEvents, ["key", "release"]);
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "applied");
  assert.deepEqual(localEvents, ["key", "release", "key"]);
  assert.deepEqual(diagnostics, [
    "grant-active",
    "release-required",
    "medium-restored",
  ]);
});

const interruptions: Record<string, (env: HostObservation) => void> = {
  断开: (env) => {
    env.session.authenticated = false;
  },
  断开本机通道: (env) => {
    env.channel.authenticated = false;
  },
  锁屏: (env) => {
    env.console.desktop = "locked";
  },
  安全桌面: (env) => {
    env.console.desktop = "secure";
  },
  输入桌面变更: (env) => {
    env.console.desktopInstance = "other-desktop";
  },
  输入桌面无法验证: (env) => {
    env.inputDesktopVerified = false;
  },
  失焦: (env) => {
    env.target!.foreground = false;
  },
  窗口重建: (env) => {
    env.target!.instance = "new-window";
  },
  到期: (env) => {
    env.now += WindowsAdminInputPolicy.grantLifetimeMs;
  },
  签名不再可信: (env) => {
    env.trustEvidence = null;
  },
};
for (const [reason, interrupt] of Object.entries(interruptions)) {
  test(`${reason}时主动撤权，即使没有下一条输入`, () => {
    const { host, env, diagnostics, localEvents } = fixture();
    assert.equal(host.approveLocally(approval, env), approval.serial);
    assert.equal(host.candidateInput(command(), source, env)?.route, "helper");
    interrupt(env);
    const revoked = { route: "reject", releaseGrant: approval.serial };
    assert.deepEqual(host.observe(env), revoked);
    assert.deepEqual(host.candidateInput(command(1), source, env), revoked);
    assert.equal(
      host.ordinaryInput(source.sessionId, key, env),
      "unauthorized",
    );
    assert.deepEqual(localEvents, ["release"]);
    assert.deepEqual(diagnostics, ["grant-active", "release-required"]);
  });
}

test("切换到安全或另一桌面后不接受松键确认，原桌面恢复后才可回落", () => {
  const { host, env, medium } = fixture();
  assert.equal(host.approveLocally(approval, env), approval.serial);
  const locked = {
    ...env,
    console: { ...env.console, desktop: "locked" as const },
  };
  assert.deepEqual(host.observe(locked), {
    route: "reject",
    releaseGrant: approval.serial,
  });
  assert.equal(host.acknowledgeCleanup(approval.serial, locked, true), false);
  const wrongDesktop = {
    ...env,
    console: { ...env.console, desktopInstance: "other-desktop" },
  };
  assert.equal(
    host.acknowledgeCleanup(approval.serial, wrongDesktop, true),
    false,
  );
  medium.configure(null);
  assert.equal(host.acknowledgeCleanup(approval.serial, env, true), true);
  assert.equal(host.ordinaryInput(source.sessionId, key, env), "unauthorized");
});

test("只对解析后且未重放的命令做逐动作命中验证", () => {
  const { host, env } = fixture();
  assert.equal(host.approveLocally(approval, env), approval.serial);
  const button = { type: "button", button: 0, down: true, x: 0.75, y: 0.4 };
  let inspections = 0;
  const inspect = (
    event: Readonly<typeof button> | Readonly<{ type: string }>,
  ) => {
    inspections++;
    assert.deepEqual(event, button);
    assert.equal(Object.isFrozen(event), true);
    return env;
  };
  assert.equal(
    host.candidateInput(command(0, button), source, env, inspect)?.route,
    "helper",
  );
  assert.equal(
    host.candidateInput(command(0, button), source, env, inspect)?.route,
    "reject",
  );
  assert.equal(
    host.candidateInput(command(1, { ...button, x: 2 }), source, env, inspect)
      ?.route,
    "reject",
  );
  assert.equal(
    host.candidateInput(
      command(1, button),
      { ...source, linkId: "another-link" },
      env,
      inspect,
    )?.route,
    "reject",
  );
  assert.equal(inspections, 1);
});

for (const [reason, inspect] of [
  [
    "命中移出选定窗口",
    (env: HostObservation) => ({
      ...env,
      target: { ...env.target!, pointerInTarget: false },
    }),
  ],
  [
    "窗口已被替换",
    (env: HostObservation) => ({
      ...env,
      target: { ...env.target!, instance: "replaced" },
    }),
  ],
  [
    "已切到安全桌面",
    (env: HostObservation) => ({
      ...env,
      console: { ...env.console, desktop: "secure" as const },
    }),
  ],
  [
    "已到期",
    (env: HostObservation) => ({
      ...env,
      now: env.now + WindowsAdminInputPolicy.grantLifetimeMs,
    }),
  ],
  ["检查结果未知", () => null],
  [
    "检查失败",
    () => {
      throw new Error("test probe failed");
    },
  ],
] as const) {
  test(`逐动作检查发现${reason}时撤权，即使先前观察仍正常`, () => {
    const { host, env, localEvents } = fixture();
    assert.equal(host.approveLocally(approval, env), approval.serial);
    const candidate = command(0, { type: "move", x: 0.6, y: 0.3 });
    assert.deepEqual(
      host.candidateInput(candidate, source, env, () => inspect(env)),
      {
        route: "reject",
        releaseGrant: approval.serial,
      },
    );
    assert.equal(
      host.ordinaryInput(source.sessionId, key, env),
      "unauthorized",
    );
    assert.deepEqual(localEvents, ["release"]);
  });
}
