// A bus that cannot start exits non-zero, so systemd's Restart=on-failure brings it back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmp.mjs";

const BUS = fileURLToPath(new URL("../scripts/ai-collab-bus.mjs", import.meta.url));

test("the bus script exits 1 when main refuses to start", (t) => {
  const dir = tempDir(t, "bus-exit-");
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), AI_COLLAB_STATE_DIR: path.join(dir, "state") };
  const run = spawnSync(process.execPath, [BUS], { env, encoding: "utf8", timeout: 15000 });
  assert.match(run.stderr, /no token/);
  assert.equal(run.status, 1);
});
