// readReply is the one reply parser; matchReply is readReply narrowed to one id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalEnd, matchReply, readReply } from "../lib/operator.ts";

const ID = "0123456789ab";
const OTHER = "fedcba987654";
const skipEnd = approvalEnd({ peer: "operator", wire: "envelope" }, ID, "skipped");
const agentEnd = approvalEnd({ peer: "claude", wire: "envelope" }, ID, "skipped");

const cases = [
  ["reply", { id: "ev-1", message: `reply ${ID} ship it` }, { skipped: false, id: ID, answer: "ship it", messageId: "ev-1" }],
  ["operator skip", { id: "ev-2", message: skipEnd }, { skipped: true, id: ID }],
  ["non-operator approval-end", { id: "ev-3", message: agentEnd }, null],
  ["blank reply", { id: "ev-4", message: `reply ${ID}   ` }, null],
  ["plain text", { id: "ev-5", message: "just talking" }, null],
];

// What matchReply must give for an id: readReply's result when the ids match, else null.
const expectedFor = (expected, id) => expected && expected.id === id ? expected : null;

for (const [name, event, expected] of cases) {
  test(`readReply: ${name}`, () => {
    assert.deepEqual(readReply(event), expected);
  });

  test(`matchReply: ${name} equals readReply for its own id and null for another`, () => {
    assert.deepEqual(matchReply(event, { id: ID }), expectedFor(expected, ID));
    assert.deepEqual(matchReply(event, { id: OTHER }), expectedFor(expected, OTHER));
  });
}
