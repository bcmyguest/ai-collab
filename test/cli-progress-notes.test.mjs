import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { runCli } from "../lib/cli.mjs";

function io(env) {
  const o = { out: "", err: "" };
  return { o, io: { env, stdout: { write: (s) => { o.out += s; } }, stderr: { write: (s) => { o.err += s; } }, readStdin: async () => "" } };
}

// Same notes as the MCP send_to_all progress path (lib/surfaces/channel-post.ts).
test("send all --progress reports the clip and no-owned-task notes like send_to_all", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const r = io(env);
  assert.equal(await runCli(["send", "all", "x".repeat(2000), "--progress"], r.io), 0);
  const text = `${r.o.out}${r.o.err}`;
  assert.match(text, /no building task is owned by this session/);
  assert.match(text, /progress clipped to \d+ characters/);
});
