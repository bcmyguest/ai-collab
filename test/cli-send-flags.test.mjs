import { parseWireEnvelope } from "../lib/agui.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { runCli } from "../lib/cli.ts";

function io(env) {
  const o = { out: "", err: "" };
  return { o, io: { env, stdout: { write: (s) => { o.out += s; } }, stderr: { write: (s) => { o.err += s; } }, readStdin: async () => "" } };
}

test("send --reply-to links the post and never lands in the body; an unknown flag is refused", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice", AI_COLLAB_PEERS: "alice,bob" });
  let r = io(env);
  assert.equal(await runCli(["send", "all", "the answer", "--reply-to", "abc123"], r.io), 0);
  const post = fake.state.publishes.map((p) => parseWireEnvelope(p.message)).find((m) => m.body?.startsWith("the answer"));
  assert.equal(post.body, "the answer");
  assert.equal(post.replyTo, "abc123");

  r = io(env);
  assert.equal(await runCli(["send", "all", "hello", "--bogus"], r.io), 1);
  assert.match(r.o.err, /unknown option --bogus/);
  r = io(env);
  assert.equal(await runCli(["send", "bob", "hi", "--progress"], r.io), 1, "--progress is for all only");
  r = io(env);
  assert.equal(await runCli(["send", "all", "hi", "--reply-to", "bad id!"], r.io), 1);
});
