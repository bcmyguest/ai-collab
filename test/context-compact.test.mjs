import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, after } from "node:test";
import { readContext, recordInstructions, reportContext } from "../lib/usage.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const dir = tempDir({ after }, "ai-collab-compact-");
const cfg = (session) => ({ enabled: true, stateDir: join(dir, "state"), project: "demo", peer: "alice", session });
const stateFile = (session) => join(dir, "state", "demo", "sessions", "alice", `${session}.context.json`);

test("a compaction drops the on-demand files and keeps the session-start ones", async () => {
  const c = cfg("aaaaaaaaaaaaaaaa");
  await recordInstructions(c, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "session_start" });
  await recordInstructions(c, { file_path: "/w/sub/AGENTS.md", memory_type: "Local", load_reason: "nested_traversal" });
  await recordInstructions(c, { file_path: "/w/rules/x.md", memory_type: "Project", load_reason: "path_glob_match" });
  assert.equal(readContext(c).files.length, 3);
  await recordInstructions(c, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "compact" });
  assert.deepEqual(readContext(c).files.map(f => [f.path, f.load]), [["/w/CLAUDE.md", "compact"]]);
});

test("a nested file loaded after a compaction is kept", async () => {
  const c = cfg("bbbbbbbbbbbbbbbb");
  await recordInstructions(c, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "compact" });
  await recordInstructions(c, { file_path: "/w/sub/AGENTS.md", memory_type: "Local", load_reason: "nested_traversal" });
  assert.deepEqual(readContext(c).files.map(f => f.load), ["compact", "nested_traversal"]);
});

test("the context file is written only when the tokens or window change", async () => {
  const session = "cccccccccccccccc";
  const c = cfg(session);
  await reportContext(c, 7_000, { window: 100_000 });
  const first = readContext(c).at;
  assert.ok(Number.isFinite(first));
  const mtime = statSync(stateFile(session)).mtimeMs;
  await new Promise(r => setTimeout(r, 15));
  await reportContext(c, 7_000, { window: 100_000 });
  assert.equal(readContext(c).at, first, "an unchanged sample keeps the time of the last change");
  assert.equal(statSync(stateFile(session)).mtimeMs, mtime, "an unchanged sample does not rewrite the file");
  await reportContext(c, 7_001, { window: 100_000 });
  assert.equal(readContext(c).tokens, 7_001);
  assert.ok(readContext(c).at >= first);
  assert.ok(JSON.parse(readFileSync(stateFile(session), "utf8")).contextAt >= first);
});
