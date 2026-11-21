import { test } from "node:test";
import assert from "node:assert/strict";
import { developmentInputHelper } from "../electron/development-input-helper";
test("正式包及默认开发实例不能通过临时输入通道提权", () => {
  assert.equal(developmentInputHelper(false, true, {}), undefined);
  assert.equal(developmentInputHelper(true, true, {}), undefined);
  const enabled = { NEARLINK_DEV_ADMIN_INPUT: "1" };
  assert.throws(
    () => developmentInputHelper(true, true, enabled),
    /正式包保持禁用/,
  );
  assert.throws(
    () => developmentInputHelper(false, false, enabled),
    /独立开发身份/,
  );
});
