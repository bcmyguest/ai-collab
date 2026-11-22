import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLY_QUOTE_WORDS, quoteEnds, quotedReply, usableReplyId } from "../web/lib/reply-quote.js";

test("a quote keeps the original's first and last words, one line, with … between", () => {
  assert.equal(quoteEnds("short  reply\nwith   breaks"), "short reply with breaks");
  const long = Array.from({ length: 30 }, (_, i) => "w" + i).join(" ");
  const clipped = quoteEnds(long);
  assert.equal(REPLY_QUOTE_WORDS, 6);
  assert.ok(clipped.startsWith("w0 w1 w2 w3 w4 w5 …"));
  assert.ok(clipped.endsWith("w24 w25 w26 w27 w28 w29"));
  assert.equal(quoteEnds(""), "");
  assert.equal(quoteEnds(undefined), "");
});

test("a quoted reply names the sender above the body; an original with no words adds no empty quotes", () => {
  const long = Array.from({ length: 20 }, (_, i) => "word" + i).join(" ");
  assert.equal(quotedReply("yes", { sender: "PM", body: long }), "Replying to PM: “word0 word1 word2 word3 word4 word5 … word14 word15 word16 word17 word18 word19”\n\nyes");
  assert.equal(quotedReply("yes", { sender: "PM", body: "" }), "Replying to PM:\n\nyes");
  assert.equal(quotedReply("yes", {}), "yes", "nothing known about the original: the body alone");
});

test("only ids the server's replyTo check accepts count as usable", () => {
  for (const id of ["abc123", "m00000001", "A-b-9", "a".repeat(64)]) assert.equal(usableReplyId(id), true, id);
  for (const id of ["", "bad id!", "x".repeat(65), "id#1", undefined, null, 7, {}, ["a"]]) assert.equal(usableReplyId(id), false, String(id));
});
