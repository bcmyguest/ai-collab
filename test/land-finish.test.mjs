import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LandRefused, finishBranch } from "../lib/land.ts";
import { createFileBackend } from "../lib/tasks.ts";
import { tempDir } from "./helpers/tmp.mjs";

const TIP = "c".repeat(40);
const BASE = "d".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom\n", status = 1) => ({ status, stdout: "", stderr });
const PROOF = "$ npm test\nℹ pass 12\nℹ fail 0\n";

// A repo whose origin is `remote` and whose gh login answers `auth`; every call is recorded.
function repo({ remote = "git@github.com:o/r.git", auth = ok(), open = "[]" } = {}) {
  const calls = [];
  const run = async (file, argv) => {
    calls.push({ file, argv });
    if (file === "gh" && argv[0] === "auth") return auth;
    if (file === "gh" && argv[1] === "list") return ok(open);
    if (file === "gh" && argv[1] === "create") return ok("https://github.com/o/r/pull/12\n");
    if (argv[0] === "remote") return remote ? ok(`${remote}\n`) : fail("error: No such remote 'origin'\n", 2);
    if (argv[0] === "rev-parse") return ok(`${TIP}\n`);
    if (argv[0] === "merge-base") return ok(`${BASE}\n`);
    if (argv[0] === "log") return ok("Add the widget\n");
    if (argv[0] === "diff") return ok("3\t1\tlib/widget.mjs\n");
    return ok();
  };
  run.calls = calls;
  return run;
}

const pushes = (run) => run.calls.filter((c) => c.file === "git" && c.argv[0] === "push");
const created = (run) => run.calls.filter((c) => c.file === "gh" && c.argv[1] === "create");

function store(t) {
  return createFileBackend(join(tempDir(t, "land-finish-"), "demo.json"));
}

test("finish opens a draft PR with the proof in its body when origin is GitHub and gh is signed in", async (t) => {
  const run = repo();
  const result = await finishBranch("feat/widget", { run, cwd: "/work", proof: PROOF, tasks: store(t) });
  assert.deepEqual(result, { landing: "pr", url: "https://github.com/o/r/pull/12", created: true });
  assert.deepEqual(pushes(run).map((c) => c.argv), [["push", "origin", "refs/heads/feat/widget:refs/heads/feat/widget"]]);
  const argv = created(run)[0].argv;
  assert.deepEqual(argv.slice(0, 8), ["pr", "create", "--draft", "--base", "main", "--head", "feat/widget", "--title"]);
  assert.equal(argv[8], "Add the widget");
  const body = argv[argv.indexOf("--body") + 1];
  assert.match(body, /## Proof/);
  assert.ok(body.includes(PROOF.trim()), body);
});

test("finish reuses the branch's open PR", async (t) => {
  const run = repo({ open: JSON.stringify([{ url: "https://github.com/o/r/pull/4" }]) });
  assert.deepEqual(await finishBranch("feat/widget", { run, cwd: "/work", proof: PROOF, tasks: store(t) }),
    { landing: "pr", url: "https://github.com/o/r/pull/4", created: false });
  assert.equal(created(run).length, 0);
});

for (const [label, options] of [
  ["origin is not on GitHub", { remote: "git@gitlab.com:o/r.git" }],
  ["there is no origin", { remote: "" }],
  ["gh is not signed in", { auth: fail("You are not logged into any GitHub hosts\n") }],
]) {
  test(`finish writes a review packet and pushes nothing when ${label}`, async (t) => {
    const run = repo(options);
    const tasks = store(t);
    const result = await finishBranch("feat/widget", { run, cwd: "/work", proof: PROOF, tasks, by: "claude#s1" });
    assert.equal(result.landing, "packet");
    const task = tasks.get(result.task);
    assert.equal(task.status, "review");
    assert.equal(task.review.branch, "feat/widget");
    assert.equal(task.review.commit, TIP);
    assert.equal(task.review.base, BASE);
    assert.deepEqual(task.review.files, [{ path: "lib/widget.mjs", insertions: 3, deletions: 1 }]);
    // The host never ran a check on this branch, so the packet must not read as green.
    assert.notEqual(task.review.check.code, 0);
    assert.match(task.review.check.text, /pass 12/);
    assert.deepEqual(pushes(run), []);
    assert.equal(run.calls.some((c) => c.file === "gh" && c.argv[0] === "pr"), false);
  });
}

test("finish puts the packet on a named task", async (t) => {
  const tasks = store(t);
  await tasks.add({ id: "widget", title: "Build the widget" });
  const result = await finishBranch("feat/widget", { run: repo(), cwd: "/work", proof: PROOF, tasks, task: "widget", landing: "packet" });
  assert.deepEqual(result, { landing: "packet", task: "widget" });
  assert.equal(tasks.get("widget").status, "review");
});

test("finish with landing=branch pushes the branch and opens nothing", async (t) => {
  const run = repo();
  assert.deepEqual(await finishBranch("feat/widget", { run, cwd: "/work", landing: "branch", tasks: store(t) }), { landing: "branch", branch: "feat/widget" });
  assert.equal(pushes(run).length, 1);
  assert.equal(created(run).length, 0);
});

test("finish with landing=pr refuses without GitHub instead of falling back", async (t) => {
  const run = repo({ remote: "git@gitlab.com:o/r.git" });
  await assert.rejects(finishBranch("feat/widget", { run, cwd: "/work", proof: PROOF, landing: "pr", tasks: store(t) }), LandRefused);
  assert.deepEqual(pushes(run), []);
});

test("finish never pushes main and refuses an unknown policy", async (t) => {
  for (const [branch, landing] of [["main", undefined], ["main", "branch"], ["feat/x", "merge"]]) {
    const run = repo();
    await assert.rejects(finishBranch(branch, { run, cwd: "/work", proof: PROOF, landing, tasks: store(t) }), LandRefused);
    assert.deepEqual(run.calls, []);
  }
});
