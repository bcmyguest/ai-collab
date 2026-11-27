import assert from "node:assert/strict";
import { test } from "node:test";
import { activityEvents } from "../lib/activity.ts";

test("a StopFailure that is a plan limit adds no error row; the limit row carries it", () => {
  assert.deepEqual(activityEvents("claude", "stopfailure", { error: "rate_limit", error_details: "5-hour limit reached" }), []);
});

test("a StopFailure that is not a limit keeps its error row", () => {
  assert.deepEqual(activityEvents("claude", "stopfailure", { error: "billing_error" }), [{ type: "error", output: "billing_error" }]);
});
