// A finished compaction drops the on-demand instruction files, so the next compaction counts only files loaded since.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test, after } from "node:test";
import { dropOnDemandFiles, readContext, recordInstructions } from "../lib/usage.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const dir = tempDir({ after }, "ai-collab-dropped-");
const cfg = { enabled: true, stateDir: join(dir, "state"), project: "demo", peer: "alice", session: "aabbccddeeff0011" };

test("dropOnDemandFiles removes nested and glob loads and keeps the session files", async () => {
  await recordInstructions(cfg, { file_path: "/w/CLAUDE.md", memory_type: "Project", load_reason: "session_start" });
  await recordInstructions(cfg, { file_path: "/w/sub/AGENTS.md", memory_type: "Local", load_reason: "nested_traversal" });
  await recordInstructions(cfg, { file_path: "/w/rules.md", memory_type: "Project", load_reason: "path_glob_match" });
  assert.equal(await dropOnDemandFiles(cfg), true);
  assert.deepEqual(readContext(cfg).files.map(f => f.path), ["/w/CLAUDE.md"]);
});

test("dropOnDemandFiles with nothing to drop changes nothing and reports false", async () => {
  assert.equal(await dropOnDemandFiles(cfg), false);
  assert.deepEqual(readContext(cfg).files.map(f => f.path), ["/w/CLAUDE.md"]);
  assert.equal(await dropOnDemandFiles({ ...cfg, session: "" }), false);
});
