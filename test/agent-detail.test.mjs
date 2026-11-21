import assert from "node:assert/strict";
import test from "node:test";
import { agentDetail } from "../web/lib/agent-detail.js";

test("agentDetail joins the model and place with a middle dot", () => {
  assert.equal(agentDetail({ model: "composer-2.5", where: "cursor-teams" }), "composer-2.5 · cursor-teams");
  assert.equal(agentDetail({ where: "folder" }), "folder");
  assert.equal(agentDetail({ model: "opus" }), "opus");
  assert.equal(agentDetail({}), "");
  assert.equal(agentDetail(undefined), "");
});
