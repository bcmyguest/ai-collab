import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnv } from "../lib/start.mjs";
import { summaryLine } from "../lib/prune.mjs";
import { loadSchedules, runCommand } from "../runner/schedules.mjs";

const CLI = fileURLToPath(new URL("../scripts/ai-collab.mjs", import.meta.url));
const OLD = Date.parse("2026-01-01T00:00:00Z") / 1000;
const MB = 1_000_000;
const COMMAND = ["ai-collab", "prune", "--older-than", "7d", "--apply", "--json"];

function gitEnv() {
  return { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e" };
}

// A temp HOME with a registered project, one settled builder with a staged tree, and a fake systemctl on PATH.
function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-prune-sched-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  symlinkSync(CLI, path.join(bin, "ai-collab"));
  writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\necho inactive\n");
  chmodSync(path.join(bin, "systemctl"), 0o755);
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  const git = (args, extra = {}) => execFileSync("git", ["-C", repo, ...args], { env: { ...gitEnv(), ...extra }, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "notes.md"), "# notes\n");
  git(["add", "notes.md"]);
  git(["commit", "-q", "-m", "init"], { GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" });
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ project: "fixture", root: repo }]));
  const dir = path.join(home, ".local", "state", "ai-collab", "builders", "old1");
  mkdirSync(path.join(dir, "stage", "ai-collab-wt-old1"), { recursive: true });
  writeFileSync(path.join(dir, "stage", "ai-collab-wt-old1", "big.bin"), Buffer.alloc(MB, 1));
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ id: "old1", phase: "finished", root: repo, worktree: path.join(home, "ai-collab-wt-old1"), unit: "builder-old1" }));
  utimesSync(path.join(dir, "state.json"), OLD, OLD);
  const schedules = path.join(home, "schedules.json");
  writeFileSync(schedules, JSON.stringify([{ name: "prune", everyMinutes: 1440, cwd: repo, command: COMMAND, timeoutSec: 600 }]));
  return { home, bin, repo, dir, schedules };
}

test("summaryLine reports bytes, counts and the top three skip reasons on one line", () => {
  const line = summaryLine({
    mode: "apply", reclaimedBytes: 21_520_000_000, categories: { clone: { count: 13, bytes: 19.96e9 }, staged: { count: 1, bytes: 1.57e9 } },
    builders: Array.from({ length: 13 }, () => ({})), worktrees: [{ action: "remove" }], archives: Array.from({ length: 13 }, () => ({})),
    skipped: Array.from({ length: 9 }, () => ({})), skipReasons: { "newer than cutoff": 5, "task open": 3, dirty: 1, locked: 0 },
  });
  assert.equal(line, "prune applied: reclaimed 21.52 GB; builders 13 (clone 13, staged 1); worktrees 1; archives 13; skipped 9 (newer than cutoff 5, task open 3, dirty 1)");
  assert.ok(!line.includes("\n"));
});

test("a schedule entry for prune loads and its command applies in the project it names", async (t) => {
  const f = fixture(t);
  const { entries, errors } = loadSchedules({ AI_COLLAB_SCHEDULES: f.schedules });
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].command, COMMAND);
  const env = childEnv({ HOME: f.home, PATH: `${f.bin}${delimiter}${process.env.PATH}` });
  const result = await runCommand(entries[0].command, { cwd: entries[0].cwd, env, timeoutMs: entries[0].timeoutMs });
  assert.equal(result.exitCode, 0, result.tail);
  assert.match(result.tail, /prune applied: reclaimed 1\.01 MB; builders 1 \(staged 1\); worktrees 0; archives 0; skipped 1 \(main worktree 1\)\n$/);
  assert.ok(!existsSync(path.join(f.dir, "stage")));
  assert.ok(existsSync(path.join(f.dir, "state.json")));
});
