import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const notices = [
  "NearLink third-party notices\nElectron runtime includes LICENSE and LICENSES.chromium.html in its distribution.\n",
];
for (const [dir, pkg] of Object.entries(lock.packages)) {
  if (!dir || pkg.dev || !dir.startsWith("node_modules/")) continue;
  try {
    const meta = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf8"),
    );
    const names = await readdir(dir);
    const license = names.find((n) =>
      /^(license|licence|copying)(\.|$)/i.test(n),
    );
    notices.push(
      `\n${meta.name} ${meta.version} — ${meta.license ?? "see package license"}\n${license ? await readFile(path.join(dir, license), "utf8") : "See " + (meta.homepage ?? JSON.stringify(meta.repository ?? "")) + " for full license terms."}`,
    );
  } catch {}
}
await writeFile("resources/THIRD_PARTY_NOTICES.txt", notices.join("\n"));
