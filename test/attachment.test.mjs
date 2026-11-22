import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAttachment } from "../lib/attachment.mjs";
import { loadConfig } from "../lib/config.mjs";
import { parseEnvelope, sendMessage } from "../lib/inbox.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const dir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-attach-"));
const png = path.join(dir, "shot.png");
writeFileSync(png, PNG);

test("attachments must be absolute image files whose bytes match the extension", () => {
  assert.equal(readAttachment(png).data.length, PNG.length);
  assert.equal(readAttachment(png).filename, "shot.png");
  const secret = path.join(dir, "id_rsa.png");
  writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.throws(() => readAttachment(secret), /not a png image/);
  assert.throws(() => readAttachment("shot.png"), /absolute/);
  assert.throws(() => readAttachment(path.join(dir, "notes.txt")), /\.png, \.jpg/);
  assert.throws(() => readAttachment(path.join(dir, "missing.png")), /unreadable/);
  assert.throws(() => readAttachment(dir + "/"), /\.png, \.jpg/);
});

test("an agent's screenshot reaches the UI as an inline image served from history only", async (t) => {
  const fake = await startFakeNtfy();
  const ctrl = new AbortController();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const agent = { ...loadConfig(peerEnv(fake, { peer: "claude", stateDir: cfg.stateDir })), session: "aabbccddeeff0123" };
  const ui = createUi({ cfg });
  t.after(() => { ctrl.abort(); ui.close(); fake.close(); });

  const stream = sse(ui.events(new Request("http://127.0.0.1:8795/api/events", { signal: ctrl.signal })));
  await stream.next();
  const body = "Here is the screenshot\n[Details](https://example.test/report?build=2&view=full#summary)";
  const upper = path.join(dir, "shot.PNG");
  writeFileSync(upper, PNG);
  await sendMessage(agent, "all", body, { attachment: upper });
  const [upload] = fake.state.publishes;
  assert.deepEqual(upload.attachment, { name: "shot.PNG", size: PNG.length });
  assert.equal(parseEnvelope(upload.message).body, body);

  let message;
  for await (const { data } of stream) {
    message = data.messages.find(item => item.attachment);
    if (message) break;
  }
  assert.equal(message.body, body);
  assert.equal(message.attachment.name, "shot.PNG");
  assert.equal(message.attachment.type, "image/png");

  // The host can serve the upload even after the upstream bytes expire.
  assert.equal(fake.state.files.delete(message.attachment.file), true);
  const served = await ui.file(message.attachment.file);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.equal((await ui.file("f99.png")).status, 404);
  assert.equal((await ui.file("../token")).status, 404);
});
