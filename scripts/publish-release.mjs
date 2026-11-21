import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, verify } from "node:crypto";
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
if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim())
  throw Error("Release source must be committed.");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
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
  win.sourceCommit !== sourceCommit ||
  win.installerSha256 !== checksums.get(basename(winInstaller)).sha256
)
  throw Error("Windows install validation must match this exact installer");
const mac = JSON.parse(
  readFileSync(`outputs/mac-build-validation-${version}.json`, "utf8"),
);
if (
  mac.status !== "passed" ||
  mac.version !== version ||
  mac.sourceCommit !== sourceCommit
)
  throw Error("Mac build must match this source commit.");
for (const [name, digest] of Object.entries(mac.hashes ?? {}))
  if (checksums.get(name)?.sha256 !== digest)
    throw Error(`Mac artifact digest differs: ${name}`);
for (const arch of ["arm64", "x64"])
  for (const ext of ["zip", "dmg"])
    if (!mac.hashes?.[`NearLink-${version}-mac-${arch}.${ext}`])
      throw Error("Mac architecture report incomplete.");
const envelope = JSON.parse(
  readFileSync("outputs/nearlink-update.json", "utf8"),
);
const payload = Buffer.from(envelope.payload, "base64");
if (
  !verify(
    null,
    payload,
    readFileSync("resources/update-public.pem"),
    Buffer.from(envelope.signature, "base64"),
  )
)
  throw Error("Update manifest signature is invalid.");
const manifest = JSON.parse(payload.toString("utf8"));
if (manifest.version !== version || manifest.sourceCommit !== sourceCommit)
  throw Error("Signed manifest does not match release source.");
for (const [platform, suffix] of [
  ["darwin-arm64", "mac-arm64.zip"],
  ["darwin-x64", "mac-x64.zip"],
  ["win32-x64", "win-x64.exe"],
]) {
  const name = `NearLink-${version}-${suffix}`,
    artifact = manifest.artifacts?.[platform],
    expected = checksums.get(name);
  if (
    !artifact ||
    artifact.url !==
      `https://github.com/${repository}/releases/download/${tag}/${name}` ||
    artifact.sha256 !== expected?.sha256 ||
    artifact.size !== expected?.size
  )
    throw Error(`Signed artifact does not match ${name}`);
}

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
if (existing) {
  const remoteCommit = execFileSync(
    "gh",
    ["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"],
    { encoding: "utf8" },
  ).trim();
  if (remoteCommit !== sourceCommit)
    throw Error(
      "Existing release tag points to different source; never overwrite it.",
    );
}
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
      "--target",
      sourceCommit,
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
