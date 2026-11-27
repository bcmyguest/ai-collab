import test from "node:test";
import assert from "node:assert/strict";
import { attachmentOf } from "../lib/attachment-cache.ts";

test("attachmentOf returns undefined when the event has no attachment, or a null one", () => {
  assert.equal(attachmentOf(undefined), undefined);
  assert.equal(attachmentOf({}), undefined);
  assert.equal(attachmentOf({ attachment: null }), undefined);
  assert.equal(attachmentOf({ attachment: 0 }), undefined);
});

test("attachmentOf reads an image attachment's file, name, type and size", () => {
  const event = { attachment: { url: "https://ntfy.example/t/abc123.png?x=1", name: "shot.png", type: "image/png", size: "42" } };
  assert.deepEqual(attachmentOf(event), { file: "abc123.png", name: "shot.png", type: "image/png", size: 42 });
});
