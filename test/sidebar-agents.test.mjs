import assert from "node:assert/strict";
import { test } from "node:test";
import { agentName, namedAgents, unnamedAgents } from "../web/lib/sidebar.js";

const agent = (id, identityName) => ({ id, peer: id.split("#")[0], identityName });

test("only a set_identity name makes a session an agent; a harness title or fallback does not", () => {
  assert.equal(agentName(agent("cursor#1", "PM")), "PM");
  assert.equal(agentName(agent("cursor#1", "  PM  ")), "PM");
  assert.equal(agentName({ id: "cursor#1", name: "Fix the login test" }), "");
  assert.equal(agentName({ id: "cursor#1" }), "");
  assert.equal(agentName(null), "");
});

test("named agents list the PM first, then by name, and the rest stay in server order", () => {
  const agents = [
    agent("cursor#4", "builder-two"), agent("claude#2", "reviewer"),
    agent("cursor#1", "pm"), { id: "codex#9", name: "Some session title" },
    agent("codex#3", "PM"), { id: "cursor#7" },
  ];
  assert.deepEqual(namedAgents(agents).map(a => a.identityName), ["pm", "PM", "builder-two", "reviewer"]);
  assert.deepEqual(unnamedAgents(agents).map(a => a.id), ["codex#9", "cursor#7"]);
  assert.deepEqual(namedAgents([]), []);
  assert.deepEqual(unnamedAgents([]), []);
});
