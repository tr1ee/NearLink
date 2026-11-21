import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteKeyAction, isModifier } from "../src/media/keyboard";
const event = (overrides: object = {}) => ({
  key: "v",
  code: "KeyV",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});
test("物理修饰键保留：Command / Windows 为 Meta，Option / Alt 为 Alt，Control 独立", () => {
  for (const platform of ["win32", "darwin"])
    for (const code of [
      "MetaLeft",
      "MetaRight",
      "AltLeft",
      "AltRight",
      "ControlLeft",
      "ControlRight",
    ])
      assert.equal(
        remoteKeyAction(event({ code, key: code }), platform),
        "key",
      );
  assert.equal(isModifier("MetaLeft"), true);
  assert.equal(isModifier("AltRight"), true);
  assert.equal(isModifier("KeyR"), false);
});
test("远程粘贴遵循被控平台；Win+V、Ctrl+Shift+V、Alt+V 保持原始组合键", () => {
  assert.equal(remoteKeyAction(event({ ctrlKey: true }), "win32"), "paste");
  assert.equal(remoteKeyAction(event({ metaKey: true }), "win32"), "key");
  assert.equal(remoteKeyAction(event({ metaKey: true }), "darwin"), "paste");
  assert.equal(remoteKeyAction(event({ ctrlKey: true }), "darwin"), "key");
  for (const override of [
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true },
    { ctrlKey: true, metaKey: true },
  ])
    assert.equal(remoteKeyAction(event(override), "win32"), "key");
});
test("普通文字与中文交给文本输入，Option 和 Command 组合保留物理按键", () => {
  assert.equal(remoteKeyAction(event(), "win32"), "text");
  assert.equal(remoteKeyAction(event({ key: "中" }), "win32"), "text");
  assert.equal(
    remoteKeyAction(event({ key: "®", code: "KeyR", altKey: true }), "win32"),
    "key",
  );
  assert.equal(
    remoteKeyAction(event({ code: "KeyR", metaKey: true }), "win32"),
    "key",
  );
});
