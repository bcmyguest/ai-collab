// A Claude/Codex session sandbox gets the host's git, git-core, node and npm, and the worktree's node_modules, once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeSandbox, TOOL_ENV } from "../runner/adapters/cli-sandbox.ts";
import { harnessSandboxName } from "../lib/sandbox.ts";
import { fileEnd, tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(OPENSHELL, 0o755);
const BOX = harnessSandboxName("claude", "demo");

// A git worktree with a package-lock.json and node_modules, a fake node install with npm beside it, and a fake git-core.
function lab() {
  const home = tempDir(fileEnd, "ai-collab-toolchain-");
  const root = path.join(home, "repo");
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  const node = path.join(home, "node", "bin", "node");
  mkdirSync(path.dirname(node), { recursive: true });
  writeFileSync(node, "#!/bin/sh\necho fake-node\n", { mode: 0o755 });
  mkdirSync(path.join(home, "node", "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(path.join(home, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "// npm\n");
  mkdirSync(path.join(home, "git-core"), { recursive: true });
  writeFileSync(path.join(home, "git-core", "git-helper"), "#!/bin/sh\n", { mode: 0o755 });
  const claude = path.join(home, "claude-2.1.0");
  writeFileSync(claude, "#!/bin/sh\n", { mode: 0o755 });
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_CLAUDE_BIN: claude,
    AI_COLLAB_BUILDER_NODE: node, AI_COLLAB_BUILDER_GIT_CORE: path.join(home, "git-core"),
    FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
  };
  return { home, root, env };
}

const inBox = (t, ...rest) => path.join(t.home, "sandboxes", BOX, ...rest);
const uploads = (t) => readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[1] === "upload");

test("a session sandbox gets git, git-core, node, npm and node_modules, and a second start reuses them", async () => {
  const t = lab();
  const first = await createClaudeSandbox({ env: t.env }).open({ project: "demo", cwd: t.root, home: t.home, log: () => {} });
  for (const file of ["bin/git", "git-core/git-helper", "node/bin/node", "node/lib/node_modules/npm/bin/npm-cli.js", ".toolchain"]) {
    assert.ok(existsSync(inBox(t, "tools", file)), `tools/${file}`);
  }
  assert.equal(readlinkSync(inBox(t, "tools", "bin", "npm")), "/sandbox/tools/node/lib/node_modules/npm/bin/npm-cli.js");
  const workdir = inBox(t, "work", "repo");
  assert.equal(readFileSync(path.join(workdir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.match(readlinkSync(path.join(workdir, "node_modules")), /deps\/[0-9a-f]{16}\/node_modules$/);
  // The linked node_modules leaves the clone clean, so landing commits nothing for it.
  assert.equal(execFileSync(inBox(t, "tools", "bin", "git"), ["-C", workdir, "status", "--porcelain"], { encoding: "utf8" }), "");
  const argv = first.argv(["--version"], {});
  for (const [key, value] of Object.entries(TOOL_ENV)) assert.ok(argv.includes(`${key}=${value}`), key);
  assert.ok(TOOL_ENV.PATH.startsWith("/sandbox/tools/bin:/sandbox/tools/node/bin:"));

  const before = uploads(t).length;
  const second = await createClaudeSandbox({ env: t.env }).open({ project: "demo", cwd: t.root, home: t.home, log: () => {} });
  const again = uploads(t).slice(before).map((a) => a[3]);
  assert.ok(again.every((local) => !local.includes("node_modules") && !local.includes("-tools-")), `re-uploaded: ${again.join(", ")}`);
  assert.equal(second.workdir, first.workdir);
});
