import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { runCli } from "../lib/cli.ts";
import { claimInbox, sendMessage } from "../lib/messaging.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";

const TOPIC = "ai-collab-demo--to--all";

function run(argv, env) {
  let out = "";
  let err = "";
  return runCli(argv, { env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } })
    .then((code) => ({ code, out, err }));
}

test("history lists the newest channel messages oldest first and leaves the inbox cursor alone", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "alice" });
  const cfg = loadConfig(env);

  assert.equal((await run(["history"], env)).out, "no messages on the project channel\n");

  await sendMessage(loadConfig(peerEnv(fake, { peer: "bob" })), "all", "first from bob");
  fake.inject(TOPIC, JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", body: "second from operator", by: "someone" }));
  await sendMessage(cfg, "all", "third from alice");

  const all = await run(["history"], env);
  assert.equal(all.code, 0);
  assert.equal(all.err, "");
  const lines = all.out.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /from=bob .*body="first from bob"/);
  assert.match(lines[1], /from=operator .*body="second from operator"/);
  assert.match(lines[2], /from=alice .*body="third from alice"/);
  assert.match(all.out, /^\[ai-collab\] 3 message\(s\) on the project channel, oldest first; read-only, not new\./);
  assert.equal(all.out.includes("reply_to_operator"), false, "history prints no reply hints");

  const last = await run(["history", "--limit", "2"], env);
  assert.equal(last.code, 0);
  const tail = last.out.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(tail.length, 2);
  assert.match(tail[0], /body="second from operator"/);
  assert.match(tail[1], /body="third from alice"/);

  for (const bad of ["0", "101", "x"]) {
    const result = await run(["history", "--limit", bad], env);
    assert.equal(result.code, 1, bad);
    assert.match(result.err, /usage: history \[--limit N\]/);
  }

  // Reading history advances no cursor: a claim after it still returns the other peers' messages.
  const claimed = await claimInbox(cfg, { strict: true });
  assert.deepEqual(claimed.map((m) => m.from), ["bob", "operator"]);
});
