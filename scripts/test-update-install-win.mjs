import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  copyFile,
  access,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import * as asar from "@electron/asar";
const run = promisify(execFile);
const pwsh =
  process.env.NEARLINK_TEST_PWSH ||
  path.resolve("work/powershell.noindex/runtime/pwsh");
const powershellVersion = (
  await run(pwsh, [
    "-NoProfile",
    "-Command",
    "$PSVersionTable.PSVersion.ToString()",
  ])
).stdout.trim();
const root = await mkdtemp(path.resolve("work/win-helper-test-"));
const script = path.resolve("resources/install-update-win.ps1");
const expected = JSON.parse(await readFile("package.json", "utf8")).version;
async function archive(dir, version, name = "nearlink") {
  const source = path.join(dir, "source");
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ name, version }),
  );
  await asar.createPackageFromFiles(source, path.join(dir, "app.asar"), [
    path.join(source, "package.json"),
  ]);
  return path.join(dir, "app.asar");
}
const cases = [];
for (const scenario of [
  "success",
  "bad-hash",
  "installer-failure",
  "unchanged-version",
]) {
  const dir = path.join(root, scenario),
    target = path.join(dir, "Target User 空格 & O'Neil");
  await mkdir(path.join(target, "resources"), { recursive: true });
  await writeFile(
    path.join(target, "NearLink.exe"),
    "fixture executable; never executed",
  );
  const old = await archive(path.join(dir, "old"), "0.1.1");
  await copyFile(old, path.join(target, "resources/app.asar"));
  const next = process.env.NEARLINK_TEST_ASAR
    ? path.resolve(process.env.NEARLINK_TEST_ASAR)
    : await archive(path.join(dir, "new"), expected);
  const installer = path.join(dir, "downloaded installer.exe");
  await writeFile(
    installer,
    "installer fixture; mocked by PowerShell function",
  );
  const bytes = await readFile(installer),
    token = randomUUID();
  const request = {
    version: expected,
    installer,
    size: bytes.length,
    sha256:
      scenario === "bad-hash"
        ? "0".repeat(64)
        : createHash("sha256").update(bytes).digest("hex"),
    parentPid: 12345,
    installDirectory: target,
    logFile: path.join(dir, "install.log"),
    resultFile: path.join(dir, "result.json"),
    statusFile: path.join(dir, "status.json"),
    startupFile: path.join(dir, "started.json"),
    token,
  };
  const requestFile = path.join(dir, "request.json");
  await writeFile(requestFile, JSON.stringify(request));
  const harness = path.join(dir, "harness.ps1");
  await writeFile(
    harness,
    `param([string]$Helper,[string]$RequestFile,[string]$NextAsar,[string]$Scenario)
$ErrorActionPreference='Stop'
$global:fixtureRequest=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$global:processChecks=0
function Get-FileHash { throw 'Regression: legacy hash cmdlet must not be required.' }
function Get-Process { param($Id,$ErrorAction) $global:processChecks++; if($global:processChecks -lt 3){return [pscustomobject]@{StartTime=[datetime]'2020-01-01'}} return $null }
function Start-Process {
 param($FilePath,$ArgumentList,$WorkingDirectory,[switch]$Wait,[switch]$PassThru)
 if($FilePath -eq $global:fixtureRequest.installer){
  if($global:processChecks -lt 3){throw 'Installer launched before parent exit.'}
  if($ArgumentList -ne ('--updated /S /D='+$global:fixtureRequest.installDirectory)){throw 'Wrong NSIS arguments.'}
  if($WorkingDirectory -ne (Split-Path -Parent $global:fixtureRequest.installer)){throw 'Wrong working directory.'}
  if($Scenario -eq 'installer-failure'){return [pscustomobject]@{ExitCode=23}}
  if($Scenario -eq 'success'){Copy-Item -LiteralPath $NextAsar -Destination (Join-Path $global:fixtureRequest.installDirectory 'resources/app.asar') -Force}
  return [pscustomobject]@{ExitCode=0}
 }
 if($FilePath -ne (Join-Path $global:fixtureRequest.installDirectory 'NearLink.exe')){throw 'Unexpected application path.'}
 if($Scenario -eq 'success'){
  [IO.File]::WriteAllText($global:fixtureRequest.startupFile,(@{token=$global:fixtureRequest.token;version=$global:fixtureRequest.version}|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 }
 [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $RequestFile) 'launch-requested.txt'),$FilePath)
}
& $Helper -RequestFile $RequestFile
exit $LASTEXITCODE
`,
  );
  let code = 0,
    stderr = "";
  try {
    await run(
      pwsh,
      [
        "-NoLogo",
        "-NoProfile",
        "-File",
        harness,
        "-Helper",
        script,
        "-RequestFile",
        requestFile,
        "-NextAsar",
        next,
        "-Scenario",
        scenario,
      ],
      { timeout: 10000 },
    );
  } catch (e) {
    code = e.code;
    stderr = e.stderr ?? "";
  }
  const result = JSON.parse(await readFile(request.resultFile, "utf8"));
  if (scenario === "success") {
    assert.equal(code, 0, stderr);
    assert.equal(result.stage, "completed");
    await assert.rejects(access(installer), { code: "ENOENT" });
    assert.equal(
      JSON.parse(
        asar.extractFile(
          path.join(target, "resources/app.asar"),
          "package.json",
        ),
      ).version,
      expected,
    );
  } else {
    assert.equal(code, 1, stderr);
    assert.equal(result.stage, "failed");
    await access(installer); // Failed installation keeps the verified file for retry.
    assert.equal(
      JSON.parse(
        asar.extractFile(
          path.join(target, "resources/app.asar"),
          "package.json",
        ),
      ).version,
      "0.1.1",
    );
  }
  if (scenario === "unchanged-version")
    assert.match(result.message, /version was not replaced/);
  cases.push({
    scenario,
    exitCode: code,
    stage: result.stage,
    message: result.message,
  });
}
const report = {
  at: new Date().toISOString(),
  status: "passed",
  powershellVersion,
  actualPackagedAsar: !!process.env.NEARLINK_TEST_ASAR,
  scope:
    "Real PowerShell parser and production helper with isolated ASAR packages; installer/process commands mocked on macOS. Does not validate Windows NSIS/UAC/Defender or real startup.",
  cases,
};
await writeFile(
  "outputs/windows-install-validation.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
