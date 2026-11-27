import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadConfig, inboxTopic } from "../lib/config.ts";
import { claimInbox, parseEnvelope } from "../lib/messaging.ts";
import { createUi } from "../web/server/ui.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const address = "claude#aabbccddeeff0123";
const origin = "http://127.0.0.1:8795";

test("the phone sends image bytes to the agent and rejects an invalid image before publishing", async t => {
  const fake = await startFakeNtfy();
  const env = peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude" });
  const cfg = loadConfig(env);
  const ui = createUi({ cfg, env });
  t.after(async () => { ui.close(); await fake.close(); });
  const send = (bytes, body = "", headerOrigin = origin, filename = "phone.png") => {
    const form = new FormData();
    form.set("message", JSON.stringify({ project: cfg.project, target: address, body }));
    form.set("image", new File([bytes], filename, { type: "image/png" }));
    return ui.handle(new Request(origin + "/api/send", { method: "POST", body: form, headers: { origin: headerOrigin } }), "send");
  };

  assert.equal((await send(PNG, "", "https://other.test")).status, 403);
  const invalid = await send(Buffer.from("plain text"));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /not a png image/);
  const wrongRiff = await send(Buffer.from("RIFF\0\0\0\0WAVE"), "", origin, "audio.webp");
  assert.equal(wrongRiff.status, 400);
  assert.equal(fake.state.publishes.length, 0);

  assert.equal((await send(PNG)).status, 201);
  const [upload] = fake.state.publishes;
  assert.equal(upload.topic, inboxTopic(cfg.project, "claude"));
  assert.equal(parseEnvelope(upload.message).body, "");
  const [received] = await claimInbox({ ...cfg, peer: "claude", session: address.split("#")[1] }, { strict: true });
  assert.equal(received.attachment.name, "phone.png");
  assert.deepEqual(readFileSync(received.attachment.local_path), PNG);
});
