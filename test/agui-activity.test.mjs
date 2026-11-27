import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEvent, parseEvent } from "../lib/agui.ts";

test("ACTIVITY_SNAPSHOT round-trips through the codec and rejects a missing content object", () => {
  const event = buildEvent("ACTIVITY_SNAPSHOT", { messageId: "approval-0123456789ab", activityType: "a2ui-surface", content: { a2ui_operations: [] }, replace: true });
  assert.deepEqual(parseEvent(JSON.stringify(event)), event);
  assert.throws(() => buildEvent("ACTIVITY_SNAPSHOT", { messageId: "x", activityType: "a2ui-surface" }), TypeError);
  assert.equal(parseEvent(JSON.stringify({ type: "ACTIVITY_SNAPSHOT", messageId: "x", activityType: "a2ui-surface", content: "text" })), null);
});
