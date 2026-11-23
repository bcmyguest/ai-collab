import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { createFileBackend, reviewPacket, taskStoreFile } from "../lib/tasks.mjs";
import { loadProjects } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { merge } from "../lib/merge-cli.mjs";

// Real git against a temp bare origin; only npm is stubbed.
function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "merge-start-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (cwd, file, text) => writeFileSync(join(cwd, file), text);
  const commit = (cwd, file, text) => {
    write(cwd, file, text);
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", `edit ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  };
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "seed");
  commit(join(root, "seed"), "shared.txt", "base\n");
  git(join(root, "seed"), "push", "-q", "origin", "main");
  git(root, "clone", "-q", "origin.git", "ai-collab");
  const host = join(root, "ai-collab");
  // Origin moves after the host cloned, so local main is stale: the merge must start from origin/main.
  const originTip = commit(join(root, "seed"), "other.txt", "landed elsewhere\n");
  git(join(root, "seed"), "push", "-q", "origin", "main");
  const remoteMain = () => git(root, "ls-remote", join(root, "origin.git"), "refs/heads/main").split("\t")[0];

  function start(branches, { gate = 0, run, expected } = {}) {
    let output = "";
    let errors = "";
    const npm = [];
    const status = merge(["start", ...(expected ? ["--expect-tip", expected] : []), ...branches], {
      env, hostCheckout: host, tempRoot: root,
      out: { write: (message) => { output += message; } },
      err: { write: (message) => { errors += message; } },
      run(file, argv, options) {
        if (file !== "git") {
          npm.push(argv.at(-1));
          return { status: argv.at(-1) === "test" ? gate : 0, stdout: "" };
        }
        return (run ?? spawnSync)(file, argv, options);
      },
    });
    const lines = output.trim().split("\n");
    return { status, output, errors, npm, result: lines.find((line) => line.startsWith("merge: ")) };
  }
  const worktrees = () => readdirSync(root).filter((name) => name.startsWith("ai-collab-wt-merge-"));
  return { root, host, git, write, commit, originTip, remoteMain, start, worktrees };
}

test("merge start lands a branch on origin/main, verifies the push, pulls the host and cleans up", (t) => {
  const { host, git, commit, originTip, remoteMain, start, worktrees } = sandbox(t);
  git(host, "switch", "-q", "-c", "builder/a");
  const builder = commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/a"]);
  assert.equal(run.status, 0, run.errors);
  assert.deepEqual(run.npm, ["ci", "test"]);
  const merged = remoteMain();
  assert.equal(run.result, `merge: merged ${merged} (builder/a); host pulled`);
  assert.deepEqual(git(host, "rev-list", "--parents", "-n1", merged).split(" ").slice(1), [originTip, builder]);
  assert.equal(git(host, "rev-parse", "main"), merged);
  assert.deepEqual(worktrees(), []);
  assert.equal(git(host, "branch", "--list", "merge/*"), "");
});

test("merge start merges several branches in order", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  for (const name of ["a", "b"]) {
    git(host, "switch", "-q", "-c", `builder/${name}`, "main");
    commit(host, `${name}.txt`, `${name}\n`);
  }
  git(host, "switch", "-q", "main");
  const run = start(["builder/a", "builder/b"]);
  assert.equal(run.status, 0, run.errors);
  assert.match(run.result, /^merge: merged [0-9a-f]{40} \(builder\/a builder\/b\); host pulled$/);
  assert.equal(git(host, "show", `${remoteMain()}:b.txt`), "b");
});

test("a conflict pushes nothing and reports the refusal", (t) => {
  const { host, git, commit, remoteMain, start, worktrees } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/clash");
  commit(host, "other.txt", "conflicting\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/clash"]);
  assert.equal(run.status, 1);
  assert.match(run.result, /^merge: refused: builder\/clash does not merge cleanly onto origin\/main/);
  assert.deepEqual(run.npm, []);
  assert.equal(remoteMain(), before);
  assert.equal(worktrees().length, 1);
});

test("a red gate pushes nothing", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/red");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/red"], { gate: 1 });
  assert.equal(run.status, 1);
  assert.match(run.result, /^merge: refused: npm test failed/);
  assert.equal(remoteMain(), before);
});

test("a push that origin does not show is reported as refused, not merged", (t) => {
  const { host, git, commit, remoteMain, start } = sandbox(t);
  const before = remoteMain();
  git(host, "switch", "-q", "-c", "builder/a");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const run = start(["builder/a"], {
    run: (file, argv, options) => argv.includes("push") ? { status: 0, stdout: "" } : spawnSync(file, argv, options),
  });
  assert.equal(run.status, 1);
  assert.match(run.result, new RegExp(`^merge: refused: origin main is ${before}, not the pushed [0-9a-f]{40}`));
});

test("local edits that block the host pull are reported and left alone", (t) => {
  const { host, git, write, commit, remoteMain, start, worktrees } = sandbox(t);
  git(host, "switch", "-q", "-c", "builder/a");
  commit(host, "a.txt", "a\n");
  git(host, "switch", "-q", "main");
  const stale = git(host, "rev-parse", "main");
  write(host, "other.txt", "someone else's uncommitted edit\n");
  const run = start(["builder/a"]);
  assert.equal(run.status, 0, run.errors);
  const merged = remoteMain();
  assert.match(run.result, new RegExp(`^merge: merged ${merged} \\(builder/a\\); host pull skipped: `));
  assert.equal(git(host, "rev-parse", "main"), stale);
  assert.equal(readFileSync(join(host, "other.txt"), "utf8"), "someone else's uncommitted edit\n");
  assert.deepEqual(worktrees(), []);
  assert.equal(existsSync(join(host, ".git", "MERGE_HEAD")), false);
});

test("one Home request lands authorized reviews in order and streams individual receipts", { timeout: 10_000 }, async (t) => {
  const { root, host, git, write, commit, remoteMain, start, originTip } = sandbox(t);
  const ntfy = await startFakeNtfy();
  t.after(() => ntfy.close());
  mkdirSync(join(root, ".config", "ai-collab"), { recursive: true });
  write(root, ".config/ai-collab/projects.json", JSON.stringify([{ root: host, project: "demo", url: ntfy.url, peers: "claude" }]));
  const env = { HOME: root, PATH: process.env.PATH, XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, "data"), AI_COLLAB_STATE_DIR: join(root, "state") };
  const tasks = createFileBackend(taskStoreFile("demo", env));
  const tips = {};
  for (const [at, id] of ["stale", "ordinary", "answer-sync", "pm-merge-gate", "unanswered"].entries()) {
    const branch = "builder/" + id;
    git(host, "switch", "-q", "-c", branch, "main");
    tips[id] = commit(host, id, id);
    await tasks.add({ id, title: id });
    await tasks.update(id, { ask: { text: "When should this land?", by: "pm" } });
    if (id !== "unanswered") await tasks.update(id, { answer: { text: "Merge when green", by: "operator:tester" } });
    await tasks.submitReview(id, reviewPacket({ branch, commit: tips[id], base: originTip, check: { code: 0 }, submission: id, at }));
    if (id === "stale") commit(host, id, "new tip");
  }
  git(host, "switch", "-q", "main");

  const origin = "https://operator.example";
  const ui = createUi({
    projects: loadProjects(env, { host: "operator" }), env, allowedOrigin: origin, landingCheckout: host,
    runMergeReview(review) {
      const run = start([review.branch], { expected: review.commit });
      return { landed: run.status === 0, detail: run.result };
    },
  });
  t.after(() => ui.close());
  const post = (payload, from = origin) => ui.handle(new Request(origin + "/api/land-reviews", {
    method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }), "land-reviews");
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const updates = sse(ui.events(new Request(origin + "/api/events?view=home", { signal: ctrl.signal })));
  try {
    const initial = await updates.next();
    assert.deepEqual(initial.value.data.landing, { running: false, receipts: [] });
    assert.equal((await post({}, "https://other.example")).status, 403);
    await swc.loadBindings();
    const { code } = await swc.transform(readFileSync(new URL("../web/app/land-reviews.jsx", import.meta.url), "utf8"), {
      jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
      module: { type: "commonjs" },
    });
    const require = createRequire(import.meta.url);
    const components = {};
    new Function("require", "exports", code)(id => id === "@/components/ui/button" ? { Button: "button" } : require(id), components);
    const { LandReviews } = components;
    const control = LandReviews({ landing: initial.value.data.landing, onLand: () => post({}) });
    assert.match(renderToStaticMarkup(control), /<button[^>]*>Land green reviews<\/button>/);
    assert.equal((await control.props.children[0].props.onClick()).status, 202);
    assert.equal((await post({ project: "demo" })).status, 409);
    for await (const { data } of updates) {
      if (!data.landing?.finished) continue;
      const receipts = data.landing.receipts;
      assert.deepEqual(receipts.map(({ id, landed }) => [id, landed]), [
        ["pm-merge-gate", true], ["answer-sync", true], ["stale", false], ["ordinary", true],
      ]);
      const html = renderToStaticMarkup(createElement(LandReviews, { landing: data.landing }));
      assert.match(html, /demo\/stale · Failed · merge: refused: the build branch moved/);
      assert.match(html, /demo\/ordinary · Landed/);
      break;
    }
    const history = git(host, "rev-list", "--first-parent", originTip + ".." + remoteMain()).split("\n");
    assert.deepEqual(history.map(sha => git(host, "rev-parse", sha + "^2")), [tips.ordinary, tips["answer-sync"], tips["pm-merge-gate"]]);
    assert.equal(tasks.get("ordinary").status, "done");
    assert.equal(tasks.get("ordinary").question, undefined);
    assert.equal(tasks.get("stale").status, "review");
    assert.equal(tasks.get("unanswered").status, "review");
  } finally {
    await updates.return();
  }
});

test("merge start resolves mise's Node before isolating HOME when the caller has no npm", (t) => {
  const { root, host, git, commit, remoteMain } = sandbox(t);
  const runtime = join(root, "cursor", "node");
  const installed = join(root, "installed", "bin", "node");
  const npmCli = join(root, "installed", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const tools = join(root, "tools");
  for (const dir of [join(root, "cursor"), join(root, "installed", "bin"),
    join(root, "installed", "lib", "node_modules", "npm", "bin"), tools]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(runtime, "");
  writeFileSync(npmCli, "");
  writeFileSync(join(root, "node-location"), installed + "\n");
  writeFileSync(join(tools, "mise"), '#!/bin/sh\ntest "$*" = "which node" && cat "$HOME/node-location"\n', { mode: 0o755 });
  writeFileSync(installed, '#!/bin/sh\ntest ! -e "$HOME/node-location" || exit 1\nprintf "%s\\n" "$2" >> "$1"\n', { mode: 0o755 });
  git(host, "switch", "-q", "-c", "builder/quota");
  const tip = commit(host, "quota.txt", "quota\n");
  git(host, "switch", "-q", "main");
  let output = "";
  const stream = { write: (message) => { output += message; } };
  const status = merge(["start", "builder/quota"], {
    env: {
      HOME: root, PATH: `${tools}:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    },
    hostCheckout: host, tempRoot: root, nodePath: runtime, out: stream, err: stream,
  });
  assert.equal(status, 0, output);
  assert.equal(readFileSync(npmCli, "utf8"), "ci\ntest\n");
  assert.equal(git(host, "merge-base", "--is-ancestor", tip, remoteMain()), "");
});
