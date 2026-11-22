import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteText, QUOTE_CHARS } from "../web/lib/quote.js";

test("a quote keeps up to 80 characters on one line", () => {
  assert.equal(quoteText("short  reply\nwith   breaks"), "short reply with breaks");
  const long = "word ".repeat(30);
  const clipped = quoteText(long);
  assert.equal(QUOTE_CHARS, 80);
  assert.ok(clipped.endsWith("…"));
  assert.ok([...clipped].length <= 80);
});

test("an empty or missing body quotes as an empty string", () => {
  assert.equal(quoteText(""), "");
  assert.equal(quoteText(undefined), "");
});
