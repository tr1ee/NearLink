import { readFileSync } from "node:fs";
import path from "node:path";
export type DevelopmentInputHelper = { path: string; sha256: string };

// This is an explicit local acceptance path, not a production trust-policy
// exception. Packaged builds can never enable it through an environment flag.
export function developmentInputHelper(
  packaged: boolean,
  isolatedProfile: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentInputHelper | undefined {
  if (environment.NEARLINK_DEV_ADMIN_INPUT !== "1") return;
  if (packaged || !isolatedProfile)
    throw Error("临时高权限输入仅支持独立开发身份，正式包保持禁用。");
  const filename =
    environment.NEARLINK_DEV_INPUT_MANIFEST ||
    path.resolve("work/development-input-helper.json");
  const value = JSON.parse(readFileSync(filename, "utf8"));
  if (
    !value ||
    typeof value.path !== "string" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw Error("高权限输入组件安装记录无效。");
  return { path: value.path, sha256: value.sha256 };
}
