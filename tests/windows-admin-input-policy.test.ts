import { test } from "node:test";
import assert from "node:assert/strict";
import { InputState } from "../electron/input-state";
import {
  WINDOWS_ADMIN_INPUT_AVAILABLE,
  WindowsAdminInputPolicy,
  type WindowsAdminInputEnvironment,
} from "../electron/windows-admin-input-policy";
import {
  approval,
  command,
  environment,
  key,
  source,
} from "./fixtures/windows-admin-input-cases";

const mediumReleased = () => true;
function decide(
  policy: WindowsAdminInputPolicy,
  command: unknown,
  source: Parameters<WindowsAdminInputPolicy["decide"]>[1],
  env: WindowsAdminInputEnvironment,
) {
  return policy.decide(command, source, env, () => env);
}

test("管理员输入默认禁用，回落仍由现有 Medium 输入授权决定", () => {
  const policy = new WindowsAdminInputPolicy();
  const env = environment();
  let injected = 0;
  const medium = new InputState((event) => {
    if (event.type === "key") injected++;
    return true;
  });
  medium.configure({
    allowed: true,
    sessionId: source.sessionId,
    display: { x: 0, y: 0, width: 1920, height: 1080 },
  });
  assert.equal(WINDOWS_ADMIN_INPUT_AVAILABLE, false);
  assert.deepEqual(decide(policy, command(), source, env), { route: "medium" });
  assert.equal(medium.applyResult(source.sessionId, key), "applied");
  assert.equal(medium.applyResult("other-session", key), "unauthorized");
  assert.equal(injected, 1);
});

const deniedEnvironments: Record<
  string,
  (env: WindowsAdminInputEnvironment) => void
> = {
  签名未核实: (env) => {
    env.trust.signature = "unverified";
  },
  安装路径或依赖可写: (env) => {
    env.trust.imageAndDependenciesProtected = false;
  },
  本地通道未认证: (env) => {
    env.channel.authenticated = false;
  },
  "不同 Windows 用户": (env) => {
    env.channel.owner.userSid = "other-user";
  },
  "不同 Windows 登录": (env) => {
    env.channel.owner.logonId = "other-logon";
  },
  不同控制台会话: (env) => {
    env.channel.owner.consoleSession++;
  },
  设备取消配对: (env) => {
    env.session.paired = false;
  },
  远控连接未认证: (env) => {
    env.session.authenticated = false;
  },
  仅查看或已断开: (env) => {
    env.session.activeHostControl = false;
  },
  原连接已换代: (env) => {
    env.session.linkId = "replacement-link";
  },
  屏幕锁定: (env) => {
    env.console.desktop = "locked";
  },
  "UAC 安全桌面": (env) => {
    env.console.desktop = "secure";
  },
  桌面状态未知: (env) => {
    env.console.desktop = "unknown";
  },
  显示布局变更: (env) => {
    env.console.displayLayoutId = "new-layout";
  },
  目标不明: (env) => {
    env.target = null;
  },
  危险目标: (env) => {
    env.target!.kind = "denied";
  },
  窗口实例变更: (env) => {
    env.target!.instance = "replacement-window";
  },
  目标失焦: (env) => {
    env.target!.foreground = false;
  },
  目标属于另一个用户: (env) => {
    env.target!.owner.userSid = "other-user";
  },
};

for (const [reason, change] of Object.entries(deniedEnvironments)) {
  test(`管理员输入拒绝${reason}，已启用时撤权并要求松键`, () => {
    const env = environment();
    const policy = new WindowsAdminInputPolicy();
    assert.equal(policy.begin(approval, env, mediumReleased), approval.serial);
    assert.equal(decide(policy, command(), source, env).route, "helper");
    change(env);
    assert.deepEqual(decide(policy, command(1), source, env), {
      route: "reject",
      releaseGrant: approval.serial,
    });
    assert.equal(
      new WindowsAdminInputPolicy().begin(approval, env, mediumReleased),
      null,
    );
  });
}

test("开启要求本次主机确认和 Medium 松键成功，拒绝重复授权", () => {
  const policy = new WindowsAdminInputPolicy();
  const env = environment();
  assert.equal(
    policy.begin(
      { ...approval, confirmedOnConsole: false },
      env,
      mediumReleased,
    ),
    null,
  );
  const unknownConsole = environment();
  unknownConsole.console.owner.consoleSession = 0;
  unknownConsole.channel.owner.consoleSession = 0;
  unknownConsole.target!.owner.consoleSession = 0;
  assert.equal(
    new WindowsAdminInputPolicy().begin(
      approval,
      unknownConsole,
      mediumReleased,
    ),
    null,
  );
  assert.equal(
    policy.begin(approval, env, () => false),
    null,
  );
  assert.equal(policy.begin(approval, env, mediumReleased), null);
  assert.equal(
    policy.begin({ ...approval, serial: 2 }, env, mediumReleased),
    2,
  );
});

test("管理员输入拒绝非当前来源、旧授权、重放和超出白名单的负载", () => {
  const policy = new WindowsAdminInputPolicy();
  const env = environment();
  assert.equal(policy.begin(approval, env, mediumReleased), approval.serial);
  for (const field of [
    "peerFingerprint",
    "linkId",
    "channelId",
    "sessionId",
  ] as const)
    assert.equal(
      decide(policy, command(20), { ...source, [field]: "other" }, env).route,
      "reject",
    );
  assert.equal(
    decide(policy, { ...command(20), grant: 123 }, source, env).route,
    "reject",
  );
  assert.equal(
    decide(policy, { ...command(20), sessionId: "wrong-session" }, source, env)
      .route,
    "reject",
  );
  for (const event of [
    { type: "text", text: "test" },
    { type: "paste" },
    { type: "command" },
    { type: "key", code: "MetaLeft", down: true },
    { ...key, unexpected: true },
    { type: "move", x: 1.1, y: 0 },
  ])
    assert.equal(
      decide(policy, command(20, event), source, env).route,
      "reject",
    );
  assert.deepEqual(decide(policy, command(2), source, env), {
    route: "helper",
    grant: approval.serial,
    event: key,
  });
  for (const sequence of [1, 2, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      decide(policy, command(sequence), source, env).route,
      "reject",
    );
});

test("管理员输入点击命中由本机判断，目标外指针和系统组合键触发撤权", () => {
  for (const event of [
    key,
    { type: "button", x: 0.5, y: 0.5, button: 0, down: true },
  ]) {
    const env = environment();
    const policy = new WindowsAdminInputPolicy();
    assert.equal(policy.begin(approval, env, mediumReleased), approval.serial);
    assert.equal(
      decide(policy, command(0, event), source, env).route,
      "helper",
    );
    env.target!.pointerInTarget = false;
    env.target!.systemModifiersClear = false;
    assert.deepEqual(decide(policy, command(1, event), source, env), {
      route: "reject",
      releaseGrant: approval.serial,
    });
  }
});

test("本地停止、到期或时钟回退后，完成松键前阻止输入和回落", () => {
  for (const revoke of [
    (policy: WindowsAdminInputPolicy) => policy.stop(),
    (policy: WindowsAdminInputPolicy, env: WindowsAdminInputEnvironment) =>
      policy.reconcile({
        ...env,
        now: env.now + WindowsAdminInputPolicy.grantLifetimeMs,
      }),
    (policy: WindowsAdminInputPolicy, env: WindowsAdminInputEnvironment) =>
      policy.reconcile({ ...env, now: env.now - 1 }),
  ]) {
    const policy = new WindowsAdminInputPolicy();
    const env = environment();
    assert.equal(policy.begin(approval, env, mediumReleased), approval.serial);
    assert.equal(decide(policy, command(), source, env).route, "helper");
    const expected = { route: "reject", releaseGrant: approval.serial };
    assert.deepEqual(revoke(policy, env), expected);
    assert.deepEqual(decide(policy, command(1), source, env), expected);
    assert.equal(
      policy.begin({ ...approval, serial: 2 }, env, mediumReleased),
      null,
    );
    assert.equal(
      policy.completeRelease(approval.serial, env.channel, env.console, false),
      false,
    );
    assert.equal(
      policy.completeRelease(2, env.channel, env.console, true),
      false,
    );
    assert.equal(
      policy.completeRelease(
        approval.serial,
        { ...env.channel, id: "other" },
        env.console,
        true,
      ),
      false,
    );
    assert.equal(
      policy.completeRelease(
        approval.serial,
        { ...env.channel, authenticated: false },
        env.console,
        true,
      ),
      false,
    );
    assert.deepEqual(policy.reconcile(env), expected);
    assert.equal(
      policy.completeRelease(approval.serial, env.channel, env.console, true),
      true,
    );
    assert.deepEqual(decide(policy, command(2), source, env), {
      route: "medium",
    });
    assert.equal(
      policy.begin({ ...approval, serial: 2 }, env, mediumReleased),
      null,
    );
    assert.equal(
      policy.begin({ ...approval, serial: 3 }, env, mediumReleased),
      3,
    );
    assert.equal(decide(policy, command(3), source, env).route, "reject");
  }
});
