import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptConfirms } from "../lib/claude-socket.mjs";

// One transcript line holding a user record whose content is the given string, as JSON.
const record = (content) => `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content })}\n`;
const envelope = (name, body) => `<cross-session-message from-name="${name}">\n${body}\n</cross-session-message>`;

// A transcript file under a new temp dir, cleaned up with the test.
function transcript(t, text = "") {
  const dir = mkdtempSync(join(tmpdir(), "cc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, text);
  return file;
}

test("an envelope from the named sender, written after the offset, confirms every id", (t) => {
  const file = transcript(t, record("earlier"));
  const from = statSync(file).size;
  appendFileSync(file, record(envelope("ai-collab", "- id=m00000001 from=bob body=\"hi\"\n- id=m00000002 from=bob body=\"yo\"")));
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001", "m00000002"], fromName: "ai-collab" }), true);
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001", "m00000003"], fromName: "ai-collab" }), false, "a missing id fails");
});

test("bytes before the offset never confirm, even when they hold the envelope", (t) => {
  const file = transcript(t, record(envelope("ai-collab", "- id=m00000001 from=bob")));
  const from = statSync(file).size;
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001"], fromName: "ai-collab" }), false);
});

test("quoting the id outside the envelope does not confirm", (t) => {
  const file = transcript(t);
  const from = statSync(file).size;
  appendFileSync(file, record("the inbox showed id=m00000001 from=bob, and cross-session-message is a tag name"));
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001"], fromName: "ai-collab" }), false);
});

test("another sender's envelope does not confirm", (t) => {
  const file = transcript(t);
  const from = statSync(file).size;
  appendFileSync(file, record(envelope("someone-else", "- id=m00000001 from=bob")));
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001"], fromName: "ai-collab" }), false);
});

test("an id is matched with its trailing space, so a longer id does not confirm a shorter one", (t) => {
  const file = transcript(t);
  const from = statSync(file).size;
  appendFileSync(file, record(envelope("ai-collab", "- id=m000000010 from=bob")));
  assert.equal(transcriptConfirms(file, from, { ids: ["m00000001"], fromName: "ai-collab" }), false);
});

test("a missing transcript does not confirm", (t) => {
  const file = transcript(t);
  const missing = join(file, "..", "absent.jsonl");
  assert.equal(transcriptConfirms(missing, 0, { ids: ["m00000001"], fromName: "ai-collab" }), false);
});
