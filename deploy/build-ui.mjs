import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = path.join(root, "web");
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");

// Use this option from the checkout served by the ai-collab-ui user unit.
const options = process.argv.slice(2);
const deployAndVerify = options.includes("--deploy-and-verify");
const args = [next, "build", web, ...options.filter(arg => arg !== "--deploy-and-verify")];

if (process.env.AI_COLLAB_NEXT_DIST) {
  if (deployAndVerify) throw new Error("--deploy-and-verify requires publishing the default UI build");
  const build = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (build.error) throw build.error;
  process.exit(build.status ?? 1);
}

const builds = path.join(web, ".next-builds");
mkdirSync(builds, { recursive: true });
const output = mkdtempSync(path.join(builds, "build-"));
const distDir = path.relative(web, output);
let published = false;
try {
  const build = spawnSync(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, AI_COLLAB_NEXT_DIST: distDir },
  });
  if (build.error) throw build.error;
  process.exitCode = build.status ?? 1;
  if (process.exitCode === 0) {
    if (!readFileSync(path.join(output, "BUILD_ID"), "utf8").trim()) throw new Error("Next.js produced an empty BUILD_ID");
    const pointer = path.join(output, "current.tmp");
    writeFileSync(pointer, path.basename(output) + "\n");
    renameSync(pointer, path.join(builds, "current"));
    published = true;
  }
} finally {
  if (!published) rmSync(output, { recursive: true, force: true });
}

if (published && deployAndVerify) {
  const restart = spawnSync("systemctl", ["--user", "restart", "ai-collab-ui.service"], {
    stdio: "inherit",
  });
  if (restart.error) throw restart.error;
  process.exitCode = restart.status ?? 1;
  if (process.exitCode === 0) {
    const verify = fileURLToPath(new URL("./verify-ui.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [verify], { stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
