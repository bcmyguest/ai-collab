import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, loadProjects, sessionLabel } from "../lib/config.mjs";
import { recordSession } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("two worktrees with the same origin publish one project in the UI snapshot", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const dir = tempDir(t, "ai-collab-origin-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, AI_COLLAB_STATE_DIR: path.join(dir, "state") };
  const config = path.join(dir, ".config", "ai-collab");
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, "defaults.json"), JSON.stringify({ url: fake.url, peers: "claude,codex" }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const origins = ["https://example.com/team/repo.git", "git@example.com:team/repo.git"];
  const configs = [];
  for (const [index, origin] of origins.entries()) {
    const repo = path.join(dir, `checkout-${index}`);
    const worktree = path.join(dir, `builder-${index}`);
    git(dir, "init", repo);
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "worktree", "add", "--detach", worktree);
    const id = `session-${index}`;
    const cfg = loadConfig(env, { cwd: worktree, host: "claude", session: sessionLabel(id) });
    await recordSession(cfg, { id, cwd: worktree, harness: "claude", event: "SessionStart" });
    configs.push(cfg);
  }
  assert.match(configs[0].project, /^repo-[a-f0-9]{12}$/);
  assert.equal(configs[1].project, configs[0].project);
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  const { data } = (await stream.next()).value;
  ctrl.abort();
  assert.deepEqual(data.autoProjects, [configs[0].project]);
  assert.equal(data.projects.length, 1);
});

test("a project with no projects.json entry is listed under autoProjects; a registered one is not", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const root = tempDir(t, "ai-collab-auto-root-");
  const xdg = tempDir(t, "ai-collab-auto-xdg-");
  const env = { ...peerEnv(fake, { peer: "alice" }), XDG_CONFIG_HOME: xdg };
  mkdirSync(path.join(xdg, "ai-collab"), { recursive: true });
  const ui = createUi({ cfg: loadConfig(env), env });
  t.after(() => ui.close());
  async function snapshot() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
    const first = (await stream.next()).value;
    ctrl.abort();
    return first.data;
  }

  assert.deepEqual((await snapshot()).autoProjects, ["demo"]);
  writeFileSync(path.join(xdg, "ai-collab", "projects.json"), JSON.stringify([{ project: "demo", root }]));
  assert.deepEqual((await snapshot()).autoProjects, []);
});
