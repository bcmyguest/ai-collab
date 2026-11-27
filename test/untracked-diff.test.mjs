// The thread diff shows untracked, non-ignored files as additions without touching the index.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { untrackedDiff } from "../lib/sessions/git-refs.ts";
import { tempDir } from "./helpers/tmp.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

test("untracked files diff as new files; ignored, oversized and past-the-cap files stay out; the index is untouched", async (t) => {
  const repo = tempDir(t, "ai-collab-untracked-");
  writeFileSync(path.join(repo, ".gitignore"), "*.log\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  mkdirSync(path.join(repo, "test"));
  writeFileSync(path.join(repo, "test", "new.test.mjs"), "hello\nworld\n");
  writeFileSync(path.join(repo, "-dash.txt"), "dash\n");
  writeFileSync(path.join(repo, "debug.log"), "secret\n");
  writeFileSync(path.join(repo, "big.bin"), "x".repeat(2048));
  const index = git(repo, "ls-files", "--stage");

  const diff = await untrackedDiff("git", repo, process.env, { fileBytes: 1024, totalBytes: 1 << 20 });
  assert.match(diff, /^diff --git a\/test\/new\.test\.mjs b\/test\/new\.test\.mjs\nnew file mode 100644\n/m);
  assert.match(diff, /\+\+\+ b\/test\/new\.test\.mjs\n@@ -0,0 \+1,2 @@\n\+hello\n\+world\n/);
  assert.match(diff, /\+\+\+ b\/-dash\.txt\n/);
  assert.doesNotMatch(diff, /debug\.log|big\.bin/);
  assert.equal(git(repo, "ls-files", "--stage"), index);
  assert.match(git(repo, "status", "--porcelain"), /^\?\? test\/$/m);

  const capped = await untrackedDiff("git", repo, process.env, { fileBytes: 1024, totalBytes: 150 });
  assert.equal((capped.match(/^diff --git /gm) || []).length, 1, "the total cap keeps whole files only");
  assert.equal(await untrackedDiff("git", repo, process.env, { fileBytes: 1024, totalBytes: 0 }), "");
});
