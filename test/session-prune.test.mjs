// A session whose worktree folder was deleted has nothing to resume, so its card leaves Home and Sessions.
// The fold for dead cards is covered in session-prune-view.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, loadProjects, sessionLabel } from "../lib/config.ts";
import { recordSession, worktreeGone, worktreeRoot } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";

test("a worktree session's folder is checked, not the parent project", (t) => {
  const root = tempDir(t, "ai-collab-prune-root-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tree = path.join(root, ".claude", "worktrees", "gone");
  assert.equal(worktreeRoot(`${tree}/src/deep`, root), tree, "a subfolder names its worktree");
  assert.equal(worktreeRoot(`${root}/src`, root), "", "a folder in the project is not a worktree");
  assert.equal(worktreeGone({ cwd: `${tree}/src`, online: false }, root), true, "a deleted worktree is gone");
  assert.equal(worktreeGone({ cwd: `${tree}/src`, online: true }, root), false, "a running session stays");
  mkdirSync(tree, { recursive: true });
  assert.equal(worktreeGone({ cwd: `${tree}/src`, online: false }, root), false, "an existing worktree stays");
  assert.equal(worktreeGone({ cwd: "/tmp/elsewhere", online: false }, root), false, "a plain folder is not a worktree");
  assert.equal(worktreeGone({ cwd: `${tree}/src`, online: false, sandbox: "box" }, root), false, "a sandbox has no worktree");
  rmSync(tree, { recursive: true, force: true });
  writeFileSync(tree, "", "utf8");
  assert.equal(worktreeGone({ cwd: `${tree}/src`, online: false }, root), true, "a file where the worktree was counts as gone");
});

test("session cards drop a session whose worktree is gone, and keep the rest", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir(t, "ai-collab-prune-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const keepId = "44444444-0000-4000-8000-000000000001";
  const goneId = "44444444-0000-4000-8000-000000000002";
  const env = {
    HOME: home, PATH: process.env.PATH, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state"),
    AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude", AI_COLLAB_PEERS: "claude", AI_COLLAB_SESSION: sessionLabel(keepId),
  };
  const keep = loadConfig(env);
  const gone = { ...keep, session: sessionLabel(goneId) };
  await recordSession(keep, { id: keepId, cwd: root, harness: "claude", event: "SessionStart", name: "Keep me" });
  await recordSession(gone, { id: goneId, cwd: path.join(root, ".claude", "worktrees", "deleted"), harness: "claude", event: "SessionStart", name: "Gone worktree" });

  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const state = await firstUpdate(ui.events(new Request(`${base}/api/events?project=demo&view=sessions`, { signal: ctrl.signal })), "state");
  assert.deepEqual(state.sessions.map(card => card.id), [`claude#${keep.session}`], "the gone worktree's card is dropped");
  assert.deepEqual(state.projectCounts.demo, { running: 0, inactive: 1 }, "and it is not counted as inactive");
  assert.equal(state.harnesses.find(h => h.id === "claude").sessions, 1, "nor in the harness count");
  assert.ok(state.agents.some(agent => agent.id === `claude#${gone.session}`), "the registry entry is kept for its activity");
});
