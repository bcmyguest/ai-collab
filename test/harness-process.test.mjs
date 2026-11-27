// harnessProcess finds a harness by its script or executable, not only argv[0], so a nested harness is a new process.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harnessProcess } from "../lib/process.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const linux = existsSync("/proc/self/stat");

function tmp(t) {
  const dir = tempDir({ after }, "ai-collab-harness-proc-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(t, file, args, options = {}) {
  const child = spawn(file, args, { stdio: "ignore", ...options });
  t.after(() => child.kill());
  return new Promise((resolve) => setTimeout(() => resolve(child), 200));
}

test("a harness run as `node …/cli.js` is found by its script", { skip: !linux }, async (t) => {
  const dir = join(tmp(t), "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cli.js"), "setTimeout(() => {}, 30_000);\n");
  const child = await run(t, process.execPath, [join(dir, "cli.js")]);
  assert.equal(harnessProcess("claude", child.pid)?.pid, child.pid);
});

test("a harness started under another argv[0] (exec -a) is found by its executable", { skip: !linux }, async (t) => {
  const codex = join(tmp(t), "codex");
  copyFileSync("/bin/sleep", codex);
  chmodSync(codex, 0o755);
  const child = await run(t, codex, ["30"], { argv0: "worker" });
  assert.equal(harnessProcess("codex", child.pid)?.pid, child.pid);
});

test("a JS-entry harness started through its bin symlink is found by the script name", { skip: !linux }, async (t) => {
  const bin = join(tmp(t), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), "setTimeout(() => {}, 30_000);\n");
  const child = await run(t, process.execPath, [join(bin, "claude")]);
  assert.equal(harnessProcess("claude", child.pid)?.pid, child.pid);
});

test("a non-node process with a harness name in argv[1] is not a harness", { skip: !linux }, async (t) => {
  const dir = tmp(t);
  writeFileSync(join(dir, "codex"), "");
  const child = await run(t, "tail", [join(dir, "codex"), "-f"]);
  assert.notEqual(harnessProcess("codex", child.pid)?.pid, child.pid);
});

test("a plain node process is not a harness", { skip: !linux }, async (t) => {
  const child = await run(t, process.execPath, ["-e", "setTimeout(() => {}, 30_000)"]);
  assert.notEqual(harnessProcess("claude", child.pid)?.pid, child.pid);
  assert.notEqual(harnessProcess("codex", child.pid)?.pid, child.pid);
});
