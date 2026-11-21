import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
const version = JSON.parse(readFileSync("package.json","utf8")).version;
const destination = path.resolve(`outputs/NearLink-source-${version}.zip`);
mkdirSync("outputs", { recursive: true });
rmSync(destination, { force: true });
const files = [
  "src",
  "electron",
  "native",
  "scripts",
  "tests",
  "resources",
  "docs",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "playwright.config.ts",
  "index.html",
  ".gitignore",
  ".npmrc",
  "README.md",
].filter(existsSync);
execFileSync(
  "zip",
  ["-rq", destination, ...files, "-x", "*.obj", "*.exp", "*.lib", "*.pdb"],
  { stdio: "inherit" },
);
console.log(destination);
