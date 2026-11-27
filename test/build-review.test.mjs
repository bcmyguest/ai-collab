// A completed build's review packet: what the builder submits, the board card that shows it, and the operator's verdict.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { readStore, reviewPacket, taskStoreFile, writeStore } from "../lib/tasks.ts";
import { loadProjects } from "../lib/config.ts";
import { createUi } from "../web/server/ui.mjs";
import { forgetBranchTips } from "../lib/build-review.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const baseUrl = "http://127.0.0.1:8795";

// A checkout with a builder branch one commit ahead of main, which is where a review packet points.
function checkout(home) {
  const root = path.join(home, "project");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "notes.md"), "# notes\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "builder/smoke-task");
  writeFileSync(path.join(root, "notes.md"), "# notes\na line from the builder\n");
  git("add", "-A");
  git("commit", "-qm", "docs: add a line");
  return { root, base, commit: git("rev-parse", "HEAD").trim(), git };
}

async function lab(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-build-review-");
  const { root, base, commit, git } = checkout(home);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { HOME: home, PATH: process.env.PATH, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const packet = reviewPacket({
    submission: "sub-1", commit, base, branch: "builder/smoke-task", criteria: "Add one line to notes.md.",
    check: { code: 0, text: "" }, numstat: "1\t0\tnotes.md\n",
  });
  writeStore(taskStoreFile("demo", env), {
    v: 1,
    tasks: [{ id: "smoke-task", title: "Smoke task", status: "review", blockers: [], progress: [{ at: 1, by: "builder-smoke-task", text: "1 commit(s)" }], review: packet, created: 1, updated: 1 }],
  });
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = (action, body) => ui.handle(new Request(`${baseUrl}/api/${action}`, {
    method: "POST", headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ project: "demo", ...body }),
  }), action);
  const stored = () => readStore(taskStoreFile("demo", env)).tasks[0];
  return { home, root, base, commit, packet, git, ui, post, stored };
}

test("a review packet from the settlement carries the commit, the criteria and a phone-sized file list", async () => {
  const packet = reviewPacket({
    submission: "sub", commit: "a".repeat(40), base: "b".repeat(40), branch: "builder/x", criteria: "Do the thing.",
    check: { code: 0, text: "" }, numstat: "12\t3\tsrc/a.mjs\n0\t9\tsrc/b.mjs\n-\t-\tlogo.png\n",
  });
  assert.deepEqual([packet.commit, packet.base, packet.branch, packet.submission], ["a".repeat(40), "b".repeat(40), "builder/x", "sub"]);
  assert.equal(packet.criteria, "Do the thing.");
  assert.deepEqual(packet.files, [
    { path: "src/a.mjs", insertions: 12, deletions: 3 },
    { path: "src/b.mjs", insertions: 0, deletions: 9 },
    { path: "logo.png", insertions: 0, deletions: 0 },
  ]);
  // Totals count the binary file as changed but with no lines, and `more` stays 0 under the cap.
  assert.deepEqual([packet.insertions, packet.deletions, packet.more], [12, 12, 0]);
});

test("a task's review packet rides in the same patch that moves it to review", async (t) => {
  const l = await lab(t);
  // The packet the store holds is the one the settlement wrote; the board adds `stale` and the diff link.
  const state = await l.post("move-task", { id: "smoke-task", status: "review" });
  assert.equal(state.status, 200);
  assert.equal(l.stored().status, "review");
  assert.equal(l.stored().review.commit, l.commit);
  assert.equal(l.stored().review.decision, undefined);
});

test("the diff route serves the submitted range as plain text and refuses another packet", async (t) => {
  const l = await lab(t);
  const url = `${baseUrl}/api/review-diff?project=demo&id=smoke-task&submission=sub-1`;
  const res = await l.ui.reviewDiff(new Request(url));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(await res.text(), /\+a line from the builder/);
  // The submission is the only key a request may name; anything else is not this task's packet.
  assert.equal((await l.ui.reviewDiff(new Request(url.replace("sub-1", "other")))).status, 404);
  assert.equal((await l.ui.reviewDiff(new Request(url.replace("smoke-task", "nope")))).status, 404);
});

test("accept finishes the task at the submitted commit", async (t) => {
  const l = await lab(t);
  forgetBranchTips(l.root);
  const res = await l.post("review", { id: "smoke-task", commit: l.commit, submission: "sub-1", decision: "accept" });
  assert.equal(res.status, 201);
  const task = l.stored();
  assert.equal(task.status, "done");
  assert.deepEqual([task.review.decision.action, task.review.decision.by], ["accept", "operator"]);
  assert.match(task.progress.at(-1).text, /^Build accepted at [0-9a-f]{12}$/);
});

test("return queues the task again with the operator's note, and a second decision is refused", async (t) => {
  const l = await lab(t);
  forgetBranchTips(l.root);
  const res = await l.post("review", { id: "smoke-task", commit: l.commit, submission: "sub-1", decision: "return", note: "Cover the empty case too." });
  assert.equal(res.status, 201);
  const task = l.stored();
  assert.equal(task.status, "decided");
  assert.equal(task.review.decision.note, "Cover the empty case too.");
  assert.match(task.progress.at(-1).text, /^Build returned: Cover the empty case too\.$/);
  assert.equal((await l.post("review", { id: "smoke-task", commit: l.commit, submission: "sub-1", decision: "accept" })).status, 409);
});

test("a decision on a commit the branch has left is refused as stale", async (t) => {
  const l = await lab(t);
  l.git("commit", "-q", "--allow-empty", "-m", "a later commit moves the branch");
  forgetBranchTips(l.root);
  const res = await l.post("review", { id: "smoke-task", commit: l.commit, submission: "sub-1", decision: "accept" });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /moved past the submitted commit/);
  assert.equal(l.stored().status, "review");
});

test("a decision for another submission cannot land on this packet", async (t) => {
  const l = await lab(t);
  forgetBranchTips(l.root);
  assert.equal((await l.post("review", { id: "smoke-task", commit: l.commit, submission: "other", decision: "accept" })).status, 409);
  assert.equal((await l.post("review", { id: "smoke-task", commit: "b".repeat(40), submission: "sub-1", decision: "accept" })).status, 409);
  assert.equal((await l.post("review", { id: "smoke-task", commit: l.commit, submission: "sub-1", decision: "maybe" })).status, 400);
  assert.equal(l.stored().status, "review");
});
