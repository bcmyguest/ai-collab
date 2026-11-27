import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after as afterAll } from "node:test";
import { attachmentOf, cacheAttachments, cachedAttachment, ensureAttachment, pruneAttachments } from "../lib/attachment-cache.ts";
import { loadConfig } from "../lib/config.ts";
import { formatInbox } from "../lib/format.ts";
import { claimInbox, channelHistory, sendMessage } from "../lib/messaging.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function tempPng() {
  const dir = tempDir({ after: afterAll }, "ai-collab-cache-");
  const file = path.join(dir, "shot.png");
  writeFileSync(file, PNG);
  return file;
}

async function nextMessage(stream, match) {
  for await (const { data } of stream) {
    const found = (data.messages || []).find(match);
    if (found) return found;
  }
  throw new Error("stream ended");
}

test("attachmentOf keeps only files the UI can show and names the type from the extension", () => {
  const png = { attachment: { url: "http://ntfy/file/abc.png", name: "shot.png", type: "image/png", size: 12 } };
  assert.deepEqual(attachmentOf(png), { file: "abc.png", name: "shot.png", type: "image/png", size: 12 });
  assert.equal(attachmentOf({ attachment: { url: "http://ntfy/file/abc.txt", name: "out.txt", type: "text/plain" } }), undefined, "chat topics are images only");
  assert.equal(attachmentOf({ attachment: { url: "http://ntfy/file/abc.txt", name: "out.txt", type: "text/plain" } }, { text: true })?.file, "abc.txt");
  assert.equal(attachmentOf({ attachment: { url: "http://ntfy/file/abc.png", type: "text/plain" } }, { text: true }), undefined, "a .png is not a text file");
  assert.equal(attachmentOf({ attachment: { url: "http://ntfy/file/../../etc/passwd", type: "image/png" } }), undefined, "a traversing name is not an attachment");
  assert.equal(attachmentOf({ attachment: { url: "http://ntfy/file/abc.png", type: "image/png" } }, { text: true }), undefined);
  assert.equal(attachmentOf({}), undefined);
});

test("the UI downloads an attachment once and every later read, and every agent, reads the local copy", async (t) => {
  const fake = await startFakeNtfy();
  const ctrl = new AbortController();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const agent = { ...loadConfig(peerEnv(fake, { peer: "claude" })), session: "aabbccddeeff0123" };
  // The UI and the agent share one state dir, as they do on a real machine; the reader is a second session.
  const shared = { ...agent, session: "ffffffffffffffff", stateDir: cfg.stateDir };
  const ui = createUi({ cfg });
  t.after(() => { ctrl.abort(); ui.close(); fake.close(); });

  const stream = sse(ui.events(new Request("http://127.0.0.1:8795/api/events", { signal: ctrl.signal })));
  await stream.next();
  await sendMessage(agent, "all", "@claude Here is the screenshot", { attachment: tempPng() });
  const message = await nextMessage(stream, (item) => Boolean(item.attachment));

  const first = await ui.file(message.attachment.file);
  assert.equal(first.status, 200);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), PNG);
  assert.deepEqual(fake.state.fileReads, [message.attachment.file], "one download for the first read");

  for (let i = 0; i < 3; i += 1) {
    const again = await ui.file(message.attachment.file);
    assert.equal(again.status, 200);
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), PNG);
  }
  assert.deepEqual(fake.state.fileReads, [message.attachment.file], "no reload or re-render downloads the file again");

  // The UI's copy is the one the agent reads: a claim carries its path and downloads nothing.
  const [claimed] = (await claimInbox(shared)).filter((m) => m.body === "@claude Here is the screenshot");
  assert.ok(claimed.attachment?.local_path, "the delivered message names the cached file");
  assert.equal(readFileSync(claimed.attachment.local_path).length, PNG.length);
  assert.deepEqual(fake.state.fileReads, [message.attachment.file], "the agent reused the UI's copy");
  assert.match(formatInbox([claimed]), /local_path=/);
});

test("an agent that sees a screenshot first downloads it once, and the UI then serves that copy", async (t) => {
  const fake = await startFakeNtfy();
  const ctrl = new AbortController();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const agent = { ...loadConfig(peerEnv(fake, { peer: "claude", stateDir: cfg.stateDir })), session: "00000000000000aa" };
  const ui = createUi({ cfg });
  t.after(() => { ctrl.abort(); ui.close(); fake.close(); });

  const stream = sse(ui.events(new Request("http://127.0.0.1:8795/api/events", { signal: ctrl.signal })));
  await stream.next();
  await sendMessage(loadConfig(peerEnv(fake, { peer: "bob" })), "all", "@claude from bob", { attachment: tempPng() });

  const [claimed] = (await claimInbox(agent)).filter((m) => m.body === "@claude from bob");
  assert.ok(claimed.attachment?.local_path, "the agent cached the file it was handed");
  assert.equal(fake.state.fileReads.length, 1);

  const message = await nextMessage(stream, (item) => Boolean(item.attachment));
  const served = await ui.file(message.attachment.file);
  assert.equal(served.status, 200);
  assert.equal(fake.state.fileReads.length, 1, "the UI served the agent's copy with no second download");
});

test("two concurrent first reads share one download", async (t) => {
  const fake = await startFakeNtfy();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  t.after(() => fake.close());
  const source = { ...loadConfig(peerEnv(fake, { peer: "alice" })), session: "00000000000000bb" };

  await sendMessage(source, "all", "concurrent", { attachment: tempPng() });
  const [upload] = fake.state.publishes;
  assert.ok(upload.attachment);

  const results = await Promise.all([ensureAttachment(cfg, "f1.png"), ensureAttachment(cfg, "f1.png"), ensureAttachment(cfg, "f1.png")]);
  assert.equal(results.filter((r) => r.cached === false).length, 1, "exactly one call downloaded");
  for (const r of results) assert.equal(readFileSync(r.path).length, PNG.length);
  assert.deepEqual(fake.state.fileReads, ["f1.png"]);
});

test("a missing or oversized file is not cached, and a retry starts clean", async (t) => {
  const fake = await startFakeNtfy();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  t.after(() => fake.close());

  await assert.rejects(ensureAttachment(cfg, "f404.png"), /unavailable/);
  assert.equal(cachedAttachment(cfg, "f404.png"), null);

  fake.state.files.set("big.png", { data: Buffer.alloc(20 * 1024 * 1024), type: "image/png" });
  await assert.rejects(ensureAttachment(cfg, "big.png"), /size limit/);
  assert.equal(cachedAttachment(cfg, "big.png"), null, "a partial download leaves no cache entry");

  // The same name then arrives in full: the retry stores it and later reads hit the cache.
  fake.state.files.set("big.png", { data: PNG, type: "image/png" });
  const got = await ensureAttachment(cfg, "big.png");
  assert.equal(got.cached, false);
  assert.equal((await ensureAttachment(cfg, "big.png")).cached, true);
});

test("cache names are validated so a path can never leave the cache directory", async (t) => {
  const fake = await startFakeNtfy();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  t.after(() => fake.close());
  for (const name of ["../token", "/etc/passwd", "a.png/../../x", "f1.svg", ""]) {
    await assert.rejects(ensureAttachment(cfg, name), /invalid attachment name/);
    assert.equal(cachedAttachment(cfg, name), null);
  }
});

test("pruning drops old files and keeps the newest within the cap", async (t) => {
  const fake = await startFakeNtfy();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  t.after(() => fake.close());
  const dir = path.join(cfg.stateDir, cfg.project, "attachments");
  mkdirSync(dir, { recursive: true });
  const old = path.join(dir, "aaaaaaaa.png");
  writeFileSync(old, PNG);
  const longAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
  assert.equal(pruneAttachments(cfg, Date.now()), 0, "a fresh file stays");
  // Ageing the file past the limit drops it on the next prune.
  const { utimesSync } = await import("node:fs");
  utimesSync(old, longAgo, longAgo);
  assert.equal(pruneAttachments(cfg, Date.now()), 1);
  assert.equal(cachedAttachment(cfg, "aaaaaaaa.png"), null);
});

test("channel history names a screenshot's local copy once this machine has it, and reads no file for it", async (t) => {
  const fake = await startFakeNtfy();
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  t.after(() => fake.close());
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "00000000000000cc" };
  await sendMessage(bob, "all", "look at this", { attachment: tempPng() });
  const [upload] = fake.state.publishes;
  assert.ok(upload.attachment);

  const before = await channelHistory(cfg);
  assert.equal(before.at(-1).attachment?.local_path, undefined, "history does not download on its own");
  assert.equal(fake.state.fileReads.length, 0);

  const cached = await ensureAttachment(cfg, "f1.png");
  const after = await channelHistory(cfg);
  assert.equal(after.at(-1).attachment?.local_path, cached.path, "history names the copy the UI or an agent already has");
  assert.equal(fake.state.fileReads.length, 1);
});

test("cacheAttachments never throws for an unavailable file and keeps the metadata", async () => {
  const fake = await startFakeNtfy();
  try {
    const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
    const messages = await cacheAttachments(cfg, [{ id: "m1", body: "x", attachment: { file: "gone.png", name: "gone.png", type: "image/png", size: 10 } }]);
    assert.deepEqual(messages[0].attachment, { file: "gone.png", name: "gone.png", type: "image/png", size: 10 });
    assert.equal(messages[0].attachment.local_path, undefined);
  } finally {
    await fake.close();
  }
});
