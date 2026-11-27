import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects } from "../lib/config.mjs";
import { checkBranchName, checkWorktreePath, filterRefs, gitRunner, listBranches, listWorktrees, parseRefs, refInputError, resolveBase, worktreeTarget } from "../lib/sessions/git-refs.ts";
import { createUi } from "../web/server/ui.mjs";
import { EMPTY_PICK, createOption, envChoice, envOptions, envPayload, looksLikeBranch, markSegments, prNumber, shortSha, triggerLabel, worktreeMarks } from "../web/lib/branch-picker.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8796";
const ID = "44444444-2222-4333-8444-666666666666";
const GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const FAKE = (name) => `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_RECORD + "/${name}.jsonl", JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
console.log("Started background session ${ID}");
`;

// A git repo with main, feat/login, fix/login-typo, an origin/release remote ref and one linked worktree.
function repo(home) {
  const root = path.join(home, "project");
  mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync(GIT, args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "one");
  const first = git("rev-parse", "HEAD").trim();
  git("branch", "feat/login");
  git("branch", "fix/login-typo");
  git("commit", "-q", "--allow-empty", "-m", "two");
  git("update-ref", "refs/remotes/origin/release", first);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release");
  const linked = path.join(home, "linked");
  git("worktree", "add", "-q", linked, "feat/login");
  writeFileSync(path.join(linked, "dirty.txt"), "x");
  return { root: realpathSync(root), linked: realpathSync(linked), first, git };
}

// A project on that repo with fake claude/cursor-agent on PATH, real git, and a recording runner client.
async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-picker-");
  const bin = path.join(home, "bin");
  const record = path.join(home, "record");
  for (const dir of [bin, record, path.join(home, ".config", "ai-collab")]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "cursor-agent"]) {
    writeFileSync(path.join(bin, name), FAKE(name));
    chmodSync(path.join(bin, name), 0o755);
  }
  symlinkSync(GIT, path.join(bin, "git"));
  const made = repo(home);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: made.root, project: "demo", url: fake.url, peers: "claude,cursor" }]));
  const env = { HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath), FAKE_RECORD: record, XDG_RUNTIME_DIR: path.join(home, "run"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const starts = [];
  const runner = () => ({ start: async (input) => { starts.push(input); return { status: 201, body: { status: "started" } }; } });
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env, runner });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/start`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", prompt: "fix it", ...body }),
  }), "start");
  const refs = (query) => ui.refs(new Request(`${base}/api/refs?` + new URLSearchParams(query)));
  return { ...made, env, post, refs, starts, record };
}

async function recorded(record, name) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, name + ".jsonl");
    if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await delay(20);
  }
  throw new Error("fake " + name + " never ran");
}

test("parseRefs names local and remote branches and skips a remote HEAD", () => {
  const text = ["refs/heads/feat/x\x00100\x00abc1234", "refs/remotes/origin/HEAD\x00100\x00abc1234", "refs/remotes/origin/main\x00bad\x00def5678", ""].join("\n");
  assert.deepEqual(parseRefs(text), [
    { name: "feat/x", remote: false, date: 100, sha: "abc1234" },
    { name: "origin/main", remote: true, date: 0, sha: "def5678" },
  ]);
});

test("filterRefs ranks exact, prefix, last-segment prefix, then contains, and caps the list", () => {
  const refs = ["a/old-login", "fix/login", "login-page", "login", "LOGINX"].map((name) => ({ name }));
  assert.deepEqual(filterRefs(refs, "Login").items.map((ref) => ref.name), ["login", "login-page", "LOGINX", "fix/login", "a/old-login"]);
  assert.deepEqual(filterRefs(refs, "  ").items, refs);
  assert.deepEqual(filterRefs(refs, "login", 2), { items: [{ name: "login" }, { name: "login-page" }], truncated: true });
});

test("refInputError refuses flags, whitespace, control characters, @{ and long names", () => {
  for (const bad of [undefined, 3, "", "  ", "-x", "--all", "a b", "a\tb", "a\x01b", "@{-1}", "x".repeat(201)]) assert.notEqual(refInputError(bad, "base"), "", String(bad));
  assert.equal(refInputError("feat/ok", "base"), "");
});

test("git helpers list branches and worktrees and check names, bases and paths against the repo", async (t) => {
  const home = tempDir(t, "ai-collab-refs-");
  const { root, linked, first } = repo(home);
  const run = gitRunner(GIT, process.env);
  const listed = await listBranches(run, root);
  assert.equal(listed.current, "main");
  assert.deepEqual(listed.branches.map((ref) => ref.name).sort(), ["feat/login", "fix/login-typo", "main", "origin/release"]);
  assert.deepEqual((await listBranches(run, root, { query: "login" })).branches.map((ref) => ref.name), ["feat/login", "fix/login-typo"]);
  assert.deepEqual(await listWorktrees(run, root), { worktrees: [{ path: linked, branch: "feat/login", head: first, locked: false, dirty: true }], truncated: false });
  assert.equal(await checkBranchName(run, root, "feat/new"), "");
  assert.match(await checkBranchName(run, root, "feat/login"), /already exists/);
  assert.notEqual(await checkBranchName(run, root, "a..b"), "");
  assert.deepEqual(await resolveBase(run, root, "feat/login"), { sha: first });
  for (const bad of ["--all", "nope", "HEAD;rm"]) assert.ok((await resolveBase(run, root, bad)).error, bad);
  assert.deepEqual(await checkWorktreePath(run, root, linked + "/"), { path: linked });
  for (const bad of [root, path.join(home, "elsewhere"), "linked", 7]) assert.ok((await checkWorktreePath(run, root, bad)).error, String(bad));
  assert.ok((await worktreeTarget(run, root, { worktreePath: linked, base: "main" })).error);
  assert.deepEqual(await worktreeTarget(run, root, { base: "feat/login", branch: " feat/new " }), { base: first, branch: "feat/new" });
});

test("GET /api/refs lists branches filtered server-side and worktrees with marks; a bad kind is refused", async (t) => {
  const { refs, linked } = await setup(t);
  const branches = await (await refs({ project: "demo", kind: "branches", q: "login" })).json();
  assert.deepEqual(branches.branches.map((ref) => ref.name), ["feat/login", "fix/login-typo"]);
  assert.equal(branches.current, "main");
  assert.equal(branches.gh, false);
  assert.equal(branches.pr, null);
  const worktrees = await (await refs({ project: "demo", kind: "worktrees" })).json();
  assert.deepEqual(worktrees.worktrees.map((row) => [row.path, row.branch, row.dirty]), [[linked, "feat/login", true]]);
  assert.equal((await refs({ project: "demo", kind: "tags" })).status, 400);
  assert.equal((await refs({ project: "demo", q: "x".repeat(201) })).status, 400);
});

test("a claude start from a picked base gets a git worktree on that commit and no --worktree flag", async (t) => {
  const { post, record, root, first, git } = await setup(t);
  const result = await (await post({ harness: "claude", place: "worktree", base: "feat/login", branch: "feat/new" })).json();
  assert.equal(result.status, "started", JSON.stringify(result));
  const [call] = await recorded(record, "claude");
  assert.equal(call.argv.includes("--worktree"), false);
  assert.ok(call.cwd.startsWith(path.join(root, ".claude", "worktrees") + path.sep), call.cwd);
  assert.equal(git("rev-parse", "feat/new").trim(), first);
});

test("a start in an existing worktree runs there; bad refs and foreign paths are refused before anything runs", async (t) => {
  const { post, record, root, linked } = await setup(t);
  for (const [body, pattern] of [
    [{ base: "--all" }, /base/],
    [{ base: "nope" }, /not a commit/],
    [{ branch: "main" }, /already exists/],
    [{ branch: "a..b" }, /branch/],
    [{ worktreePath: root }, /not one of this project's worktrees/],
    [{ worktreePath: "/tmp" }, /not one of this project's worktrees/],
    [{ worktreePath: linked, base: "main" }, /not both/],
  ]) {
    const response = await post({ harness: "cursor", place: "worktree", ...body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, pattern);
  }
  const folder = await post({ harness: "cursor", place: "folder", base: "main" });
  assert.equal(folder.status, 400);
  assert.equal(existsSync(path.join(record, "cursor-agent.jsonl")), false);
  const result = await (await post({ harness: "cursor", place: "worktree", worktreePath: linked })).json();
  assert.equal(result.status, "started", JSON.stringify(result));
  assert.equal((await recorded(record, "cursor-agent"))[0].cwd, linked);
});

test("a claude code-mode start passes the picked base to the runner", async (t) => {
  const { post, starts } = await setup(t);
  const response = await post({ harness: "claude", place: "worktree", codeMode: true, base: "feat/login" });
  assert.equal(response.status, 201);
  assert.equal(starts[0].base, "feat/login");
  assert.equal(starts[0].place, "worktree");
});

test("envOptions splits a worktree place into new and existing; envPayload sends only what the env needs", () => {
  assert.deepEqual(envOptions(["folder", "worktree", "openshell"]).map((option) => option.id), ["folder", "worktree", "existing", "openshell"]);
  assert.deepEqual(envOptions(["folder"]).map((option) => option.id), ["folder"]);
  assert.equal(envChoice("existing", envOptions(["folder"]), "worktree"), "folder");
  assert.equal(envChoice("", envOptions(["folder", "worktree"]), "worktree"), "worktree");
  const pick = { base: "main", branch: "feat/x", worktreePath: "/w" };
  assert.deepEqual(envPayload("folder", pick), { place: "folder" });
  assert.deepEqual(envPayload("worktree", { ...pick, worktreePath: "" }), { place: "worktree", base: "main", branch: "feat/x" });
  assert.deepEqual(envPayload("worktree", EMPTY_PICK), { place: "worktree" });
  assert.deepEqual(envPayload("existing", pick), { place: "worktree", worktreePath: "/w" });
});

test("createOption offers a new branch for a valid unused name, never for a PR number or an existing local branch", () => {
  const refs = [{ name: "main", remote: false, date: 0, sha: "" }, { name: "origin/feat", remote: true, date: 0, sha: "" }];
  assert.deepEqual(createOption(" feat/new ", refs, "main"), { name: "feat/new", base: "main" });
  assert.deepEqual(createOption("origin/feat", refs, "main"), { name: "origin/feat", base: "main" });
  for (const query of ["", "main", "#12", "a..b", "-x", "a b", "x.lock", "@", "a/.b", "x~1"]) assert.equal(createOption(query, refs, "main"), null, query);
  assert.equal(looksLikeBranch("feat/ok-1"), true);
  assert.equal(prNumber(" #123 "), 123);
  for (const query of ["#0", "#012", "123", "#12345678"]) assert.equal(prNumber(query), null, query);
});

test("triggerLabel says where the session starts; marks and short shas describe worktrees", () => {
  assert.equal(triggerLabel("folder", EMPTY_PICK, "main"), "main");
  assert.equal(triggerLabel("worktree", EMPTY_PICK, ""), "from HEAD");
  assert.equal(triggerLabel("worktree", { ...EMPTY_PICK, base: "dev", branch: "feat/x" }, "main"), "feat/x from dev");
  assert.equal(triggerLabel("existing", EMPTY_PICK, "main"), "Choose a worktree");
  assert.equal(triggerLabel("existing", { ...EMPTY_PICK, worktreePath: "/a/b/tree-1" }, "main"), "tree-1");
  assert.deepEqual(worktreeMarks({ path: "/w", branch: null, head: "", locked: true, dirty: true }), ["dirty", "locked", "detached"]);
  assert.equal(shortSha("0123456789abcdef"), "0123456");
  assert.equal(shortSha("xyz"), "");
});

test("markSegments marks every case-insensitive match and keeps the whole label", () => {
  assert.deepEqual(markSegments("feat/Login-login", "login"), [
    { at: 0, text: "feat/", match: false }, { at: 5, text: "Login", match: true }, { at: 10, text: "-", match: false }, { at: 11, text: "login", match: true },
  ]);
  assert.deepEqual(markSegments("main", " "), [{ at: 0, text: "main", match: false }]);
  assert.equal(markSegments("a/b/c", "x").map(segment => segment.text).join(""), "a/b/c");
});
