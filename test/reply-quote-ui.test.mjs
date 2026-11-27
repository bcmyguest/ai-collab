import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";

test("a reply to a project message carries its quote; a plain message carries none", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "operator" });
  const ui = createUi({ cfg: loadConfig(env), env });
  t.after(() => ui.close());
  const post = (body) => ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "send");
  async function messages() {
    const ctrl = new AbortController();
    const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
    const first = (await stream.next()).value;
    ctrl.abort();
    return first.data.messages;
  }

  assert.equal((await post({ target: "all", body: "first line of the project" })).status, 201);
  const [original] = await messages();
  assert.equal((await post({ target: "all", body: "a reply", replyTo: original.id })).status, 201);
  let after = await messages();
  for (let i = 0; i < 50 && !after.some(item => item.body === "a reply"); i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    after = await messages();
  }
  const reply = after.find(item => item.body === "a reply");
  assert.equal(reply.replyOf, original.id);
  assert.deepEqual(reply.quote, { id: original.id, sender: "operator", body: "first line of the project" });
  assert.equal(after.find(item => item.body === "first line of the project").quote, undefined);
});
