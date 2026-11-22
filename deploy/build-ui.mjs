import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = path.join(root, "web");
const next = path.join(root, "node_modules", "next", "dist", "bin", "next");

const args = [next, "build", web, ...process.argv.slice(2)];

if (process.env.AI_COLLAB_NEXT_DIST) {
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
