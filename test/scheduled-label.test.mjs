import assert from "node:assert/strict";
import { test } from "node:test";
import { commandLabel } from "../web/lib/scheduled.js";

test("a scheduled job's row cuts absolute paths to their last part and keeps other arguments", () => {
  assert.equal(commandLabel(["/home/u/.local/share/mise/installs/node/26/bin/node", "/home/u/ai-collab/bin/ai-collab.mjs", "resume", "--cwd", "rel/dir", "a b"]),
    "node ai-collab.mjs resume --cwd rel/dir a b");
  assert.equal(commandLabel(undefined), "");
});
