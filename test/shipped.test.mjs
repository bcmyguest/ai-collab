import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shippedTasks } from "../web/server/shipped.mjs";

test("a reviewed task can ship after it was marked done", t => {
  const root = mkdtempSync(join(tmpdir(), "shipped-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = title => {
    git("-c", "user.name=Builder", "-c", "user.email=builder@example.test", "commit", "--allow-empty", "-m", title);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  const ref = "refs/remotes/origin/main";
  git("update-ref", ref, commit("base"));
  const tip = commit("reviewed change");
  const task = { id: "change", title: "Reviewed change", status: "done", review: { commit: tip, at: 1 } };
  const backend = { list: () => [task, { id: "other", status: "done" }] };
  t.mock.method(Date, "now", () => 1000);
  assert.deepEqual(shippedTasks(backend, "project", root), []);
  git("update-ref", ref, tip);
  Date.now.mock.mockImplementation(() => 3001);
  assert.deepEqual(shippedTasks(backend, "project", root), [
    { project: "project", id: "change", title: "Reviewed change", commit: tip, at: 1 },
  ]);
});
