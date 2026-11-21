import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { createHash, sign, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const { repository } = JSON.parse(
  readFileSync("resources/update-config.json", "utf8"),
);
const notesFile = `docs/release-notes-${version}.md`;
if (existsSync(notesFile)) copyFileSync(notesFile, "outputs/发布说明.txt");
if (existsSync("docs/service-user-guide-zh.md"))
  copyFileSync("docs/service-user-guide-zh.md", "outputs/使用说明.txt");
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw Error("Release source must be committed.");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const privateKey = readFileSync(
  process.env.NEARLINK_SIGNING_KEY_FILE || ".release/update-private.pem",
);
const publicKey = readFileSync("resources/update-public.pem", "utf8");
if (
  createPublicKey(privateKey).export({ type: "spki", format: "pem" }) !==
  publicKey
)
  throw Error("Release key does not match bundled update publisher key");
const artifacts = {};
for (const [key, suffix, format] of [
  ["darwin-arm64", "mac-arm64.zip", "zip"],
  ["darwin-x64", "mac-x64.zip", "zip"],
  ["win32-x64", "win-x64.exe", "nsis"],
]) {
  const name = `NearLink-${version}-${suffix}`,
    file = `outputs/installers/${name}`;
  if (!existsSync(file))
    throw Error(`Missing ${file}; build all three targets before publishing`);
  const bytes = readFileSync(file);
  artifacts[key] = {
    url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    format,
  };
}
const payload = Buffer.from(
  JSON.stringify({
    version,
    sourceCommit,
    notes:
      process.env.NEARLINK_RELEASE_NOTES ||
      readFileSync("outputs/发布说明.txt", "utf8"),
    artifacts,
  }),
);
writeFileSync(
  "outputs/nearlink-update.json",
  JSON.stringify(
    {
      payload: payload.toString("base64"),
      signature: sign(null, payload, privateKey).toString("base64"),
    },
    null,
    2,
  ) + "\n",
);
copyFileSync("outputs/使用说明.txt", "outputs/user-guide-zh.txt");
const checksumFiles = [
  ...["arm64", "x64"].flatMap((arch) =>
    ["zip", "dmg"].map(
      (ext) => `outputs/installers/NearLink-${version}-mac-${arch}.${ext}`,
    ),
  ),
  `outputs/installers/NearLink-${version}-win-x64.exe`,
  "outputs/nearlink-update.json",
  "outputs/user-guide-zh.txt",
];
writeFileSync(
  "outputs/SHA256SUMS.txt",
  checksumFiles
    .map(
      (file) =>
        `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${file.split("/").at(-1)}`,
    )
    .join("\n") + "\n",
);
console.log(
  `Signed update manifest for ${version}; private key was not included.`,
);
