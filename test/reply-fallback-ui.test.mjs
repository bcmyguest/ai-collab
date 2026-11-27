import { parseWireEnvelope } from "../lib/agui.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const LONG = Array.from({ length: 20 }, (_, i) => "word" + i).join(" ");

function ui(t, fake) {
  const env = peerEnv(fake, { peer: "operator" });
  const server = createUi({ cfg: loadConfig(env), env });
  t.after(() => server.close());
  return (body) => server.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "send");
}

const lastEnvelope = (fake) => parseWireEnvelope(fake.state.publishes.at(-1).message);

test("a reply id the server cannot carry goes out as plain text quoting the original's ends", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const post = ui(t, fake);
  const response = await post({ target: "all", body: "yes, do that", replyTo: "not a valid id!", quote: { sender: "PM", body: LONG } });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.quoted, true);
  const sent = lastEnvelope(fake);
  assert.equal(sent.replyTo, undefined, "no unusable id reaches the envelope");
  assert.equal(sent.body, "Replying to PM: “word0 word1 word2 word3 word4 word5 … word14 word15 word16 word17 word18 word19”\n\nyes, do that");
});

test("a long but well-formed id still links the reply, and no quote is added", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const post = ui(t, fake);
  const response = await post({ target: "all", body: "linked", replyTo: "m00000001", quote: { sender: "PM", body: LONG } });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).quoted, undefined);
  const sent = lastEnvelope(fake);
  assert.deepEqual([sent.replyTo, sent.body], ["m00000001", "linked"]);
});

test("a reply with no original body still sends, naming the sender only", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const post = ui(t, fake);
  const response = await post({ target: "all", body: "ok", replyTo: "x".repeat(65) });
  assert.equal(response.status, 201);
  assert.equal(lastEnvelope(fake).body, "ok");
});
