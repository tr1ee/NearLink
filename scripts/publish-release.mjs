import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const args = process.argv.slice(2);
const stable = args[0] === "--stable" && args.length === 1;
if (args.length && !stable)
  throw Error("Use release:publish or release:publish -- --stable");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const { repository } = JSON.parse(
  readFileSync("resources/update-config.json", "utf8"),
);
const tag = `v${version}`;
const repo = ["--repo", repository];
const winInstaller = `outputs/installers/NearLink-${version}-win-x64.exe`;
const notes = "outputs/发布说明.txt";
const artifacts = [
  winInstaller,
  ...["arm64", "x64"].flatMap((arch) =>
    ["dmg", "zip"].map(
      (ext) => `outputs/installers/NearLink-${version}-mac-${arch}.${ext}`,
    ),
  ),
  "outputs/nearlink-update.json",
  "outputs/SHA256SUMS.txt",
  "outputs/user-guide-zh.txt",
];
copyFileSync("outputs/使用说明.txt", "outputs/user-guide-zh.txt");
for (const filename of [...artifacts, notes])
  if (!existsSync(filename)) throw Error(`Missing ${filename}`);

const checksums = new Map(
  artifacts.map((filename) => {
    const bytes = readFileSync(filename);
    return [
      basename(filename),
      {
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  }),
);
const versionedReport = `outputs/windows-real-install-validation-${version}.json`;
const win = JSON.parse(
  readFileSync(
    existsSync(versionedReport)
      ? versionedReport
      : "outputs/windows-real-install-validation.json",
    "utf8",
  ),
);
if (
  win.status !== "passed" ||
  win.version !== version ||
  win.installerSha256 !== checksums.get(basename(winInstaller)).sha256
)
  throw Error("Windows install validation must match this exact installer");

function github(...params) {
  execFileSync("gh", ["release", ...params, ...repo], { stdio: "inherit" });
}

function releaseInfo() {
  const result = spawnSync(
    "gh",
    ["release", "view", tag, ...repo, "--json", "isDraft,isPrerelease,assets"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/release not found/i.test(result.stderr)) return null;
  throw Error(result.stderr.trim() || `Could not read ${tag}`);
}

function verifyUploadedAssets(release) {
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const [name, expected] of checksums) {
    const actual = assets.get(name);
    if (
      actual?.size !== expected.size ||
      actual.digest !== `sha256:${expected.sha256}`
    )
      throw Error(`Uploaded asset does not match ${name}`);
  }
}

const existing = releaseInfo();
if (stable) {
  if (!existing || existing.isDraft || !existing.isPrerelease)
    throw Error(`${tag} must be a published prerelease before promotion`);
  verifyUploadedAssets(existing);
  github("edit", tag, "--prerelease=false", "--latest");
} else {
  if (existing && !existing.isDraft) throw Error(`${tag} is already published`);
  if (existing) {
    github(
      "edit",
      tag,
      "--title",
      `NearLink ${version}`,
      "--notes-file",
      notes,
    );
    github("upload", tag, "--clobber", ...artifacts);
  } else {
    github(
      "create",
      tag,
      "--draft",
      "--title",
      `NearLink ${version}`,
      "--notes-file",
      notes,
      ...artifacts,
    );
  }
  const draft = releaseInfo();
  if (!draft?.isDraft) throw Error(`${tag} is not a draft`);
  verifyUploadedAssets(draft);
  github("edit", tag, "--draft=false", "--prerelease", "--latest=false");
}
