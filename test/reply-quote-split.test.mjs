import assert from "node:assert/strict";
import { test } from "node:test";
import { quotedReply, splitQuotedReply } from "../web/lib/reply-quote.js";

test("a quoted reply splits back into its quote and its reply text", () => {
  const long = Array.from({ length: 20 }, (_, i) => "word" + i).join(" ");
  assert.deepEqual(splitQuotedReply(quotedReply("yes\n\nand more", { sender: "claude#77f66303d04fef9d", body: long })), {
    quote: { sender: "claude#77f66303d04fef9d", body: "word0 word1 word2 word3 word4 word5 … word14 word15 word16 word17 word18 word19" },
    body: "yes\n\nand more",
  });
  assert.deepEqual(splitQuotedReply(quotedReply("ok", { sender: "PM", body: "" })), { quote: { sender: "PM", body: "" }, body: "ok" });
});

test("a body that is not a quoted reply stays whole", () => {
  for (const body of ["Replying to PM: inline text", "hello", "", undefined]) assert.equal(splitQuotedReply(body), null, String(body));
});
