import assert from "node:assert/strict";
import { test } from "node:test";
import { DotError, parseDot, serializeDot } from "../lib/dot.mjs";
import { toDot, toGraph } from "../web/lib/pattern-graph.js";

const CHANGE = `// change: one worker step.
digraph change {
  graph [description="Make a change a reviewer can check", max_visits=3];
  planner [agent="claude:claude-haiku-5-5"];
  worker [agent="cursor", count=2, skill="diagnose-failure", prompt="Follow the skill."];
  reviewer [agent="codex", skill="audit-agent-diff", fallback="claude:claude-haiku-5-5"];
  planner -> worker [on="dispatch", kind="broadcast"];
  worker -> reviewer [on="submit", kind="pair", required=true];
  reviewer -> worker [on="fail", kind="pair", cap=3];
  reviewer -> done [on="pass", kind="fan-in", required=true];
}
`;

function expectError(text, pattern, line) {
  let error;
  try { parseDot(text); } catch (caught) { error = caught; }
  assert.ok(error instanceof DotError, `expected DotError, got ${error}`);
  assert.match(error.message, pattern);
  if (line !== undefined) assert.equal(error.line, line);
}

test("parses a team with every supported attribute", () => {
  const team = parseDot(CHANGE);
  assert.equal(team.name, "change");
  assert.equal(team.description, "Make a change a reviewer can check");
  assert.equal(team.maxVisits, 3);
  assert.deepEqual(team.nodes[1], { id: "worker", agent: "cursor", count: 2, skill: "diagnose-failure", prompt: "Follow the skill." });
  assert.deepEqual(team.nodes[2], { id: "reviewer", agent: "codex", count: 1, skill: "audit-agent-diff", fallback: "claude:claude-haiku-5-5" });
  assert.deepEqual(team.edges[0], { from: "planner", to: "worker", on: "dispatch", kind: "broadcast", required: false });
  assert.deepEqual(team.edges[2], { from: "reviewer", to: "worker", on: "fail", kind: "pair", required: false, cap: 3 });
  assert.equal(team.edges[3].to, "done");
});

test("serialize then parse returns the same team", () => {
  const team = parseDot(CHANGE);
  assert.deepEqual(parseDot(serializeDot(team)), team);
});

test("canonical text is a fixed point of serialize", () => {
  const once = serializeDot(parseDot(CHANGE));
  assert.equal(serializeDot(parseDot(once)), once);
});

test("prompts keep quotes, backslashes and newlines through a round trip", () => {
  const prompt = 'Say "hi" then C:\\tmp\nthen stop.';
  const team = parseDot(`digraph t { a [agent="claude", prompt="${prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"]; a -> done [on="finish"]; }`);
  assert.equal(team.nodes[0].prompt, prompt);
  assert.equal(parseDot(serializeDot(team)).nodes[0].prompt, prompt);
});

test("a prompt longer than 1000 characters is refused, the same limit validatePattern applies", () => {
  expectError(`digraph t {\n  a [agent="codex", prompt="${"x".repeat(1001)}"];\n}`, /prompt is longer than 1000 characters/, 2);
  assert.equal(parseDot(`digraph t {\n  a [agent="codex", prompt="${"x".repeat(1000)}"];\n}`).nodes[0].prompt.length, 1000);
});

test("defaults count to 1, kind to pair and required to false", () => {
  const team = parseDot('digraph t { a [agent="codex"]; a -> done [on="finish"]; }');
  assert.equal(team.nodes[0].count, 1);
  assert.deepEqual(team.edges[0], { from: "a", to: "done", on: "finish", kind: "pair", required: false });
  assert.equal(team.maxVisits, null);
});

test("a chain a -> b -> done makes two edges", () => {
  const team = parseDot('digraph t { a [agent="codex"]; b [agent="claude"]; a -> b -> done [on="go"]; }');
  assert.deepEqual(team.edges.map((edge) => [edge.from, edge.to]), [["a", "b"], ["b", "done"]]);
});

test("reports the line of an unknown kind", () => {
  expectError('digraph t {\n  a [agent="codex"];\n  a -> done [on="x", kind="fanin"];\n}', /kind must be one of .*fanin/, 3);
});

test("reports the line of a bad agent harness and bad model", () => {
  expectError('digraph t {\n  a [agent="gemini"];\n}', /harness must be one of.*gemini/, 2);
  expectError('digraph t {\n\n  a [agent="claude:"];\n}', /invalid model/, 3);
});

test("rejects an edge to an undeclared node", () => {
  expectError('digraph t {\n  a [agent="codex"];\n  a -> ghost [on="x"];\n}', /edge to unknown node "ghost"/, 3);
});

test("rejects unknown node, edge and graph attributes", () => {
  expectError('digraph t {\n  a [agent="codex", label="x"];\n}', /unknown node attribute "label"/, 2);
  expectError('digraph t {\n  a [agent="codex"];\n  a -> done [on="x", weight=2];\n}', /unknown edge attribute "weight"/, 3);
  expectError('digraph t {\n  graph [rankdir="LR"];\n  a [agent="codex"];\n}', /unknown graph attribute "rankdir"/, 2);
});

test("rejects a count that is not a whole number 1-8", () => {
  expectError('digraph t {\n  a [agent="codex", count="$pairs"];\n}', /count must be a whole number 1-8/, 2);
  expectError('digraph t {\n  a [agent="codex", count=9];\n}', /count must be/, 2);
});

test("rejects a cap on an edge to done and a cap above 10", () => {
  expectError('digraph t {\n  a [agent="codex"];\n  a -> done [on="x", cap=2];\n}', /cap applies to a handoff between roles/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  b [agent="codex"];\n  a -> b [on="x", cap=11];\n}', /cap must be/, 4);
});

test("rejects a node without agent, a duplicate node and a missing event", () => {
  expectError('digraph t {\n  a;\n}', /needs agent/, 2);
  expectError('digraph t {\n  a [agent="codex"];\n  a [agent="claude"];\n}', /declared twice/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  a -> done;\n}', /edge needs on=/, 3);
});

test("rejects a done node, an edge out of done, and a self loop", () => {
  expectError('digraph t {\n  done [agent="codex"];\n}', /invalid node id "done"/, 2);
  expectError('digraph t {\n  a [agent="codex"];\n  done -> a [on="x"];\n}', /"done" can only receive handoffs/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  a -> a [on="x"];\n}', /to itself/, 3);
});

test("rejects bad syntax with the line where it starts", () => {
  expectError('digraph t {\n  a [agent="codex"\n}', /missing "\]" before "}"/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  b [agent="codex"];\n  a -> b [on="x"', /missing "\]"/);
  expectError('digraph t {\n  a [agent="codex"];\n  "unclosed', /unclosed string/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  a = b;\n}', /graph attribute assignments/, 3);
  expectError('digraph t {\n  a [agent="codex"]; @\n}', /unexpected character "@"/, 2);
  expectError('digraph t {\n  a [agent="codex"];\n', /missing "}"/);
  expectError('', /expected "digraph"/);
  expectError('digraph t {}', /needs at least one node/);
});

test("rejects an event longer than 60 characters and a bad required value", () => {
  expectError(`digraph t {\n  a [agent="codex"];\n  a -> done [on="${"x".repeat(61)}"];\n}`, /edge event must be 1-60/, 3);
  expectError('digraph t {\n  a [agent="codex"];\n  a -> done [on="x", required=yes];\n}', /required must be true or false/, 3);
});

test("the web graph's DOT text parses back into the same roles and edges", () => {
  const pattern = {
    name: "fix-and-review",
    description: "Scope, implement and review.",
    roles: [
      { id: "lead", responsibility: "Scope.", harness: "cursor", model: "deepseek-v41-flash-1017-high" },
      { id: "implementer", responsibility: "Edit.", harness: "claude", model: "claude-haiku-5-5" },
    ],
    handoffs: [
      { from: "lead", to: "implementer", on: "scope", required: false },
      { from: "implementer", to: "lead", on: "changes requested", required: false, cap: 3 },
      { from: "lead", to: "done", on: "finished", required: true },
    ],
  };
  const graph = toGraph(pattern);
  const team = parseDot(toDot(graph, pattern.name));
  assert.equal(team.name, "fix-and-review");
  assert.equal(team.description, pattern.description);
  assert.deepEqual(team.nodes.map((node) => [node.id, node.agent]), [["lead", "cursor:deepseek-v41-flash-1017-high"], ["implementer", "claude:claude-haiku-5-5"]]);
  assert.deepEqual(team.edges[1], { from: "implementer", to: "lead", on: "changes requested", kind: "pair", required: false, cap: 3 });
});

test("the web graph keeps count, skill, fallback and kind from a team", () => {
  const team = parseDot(CHANGE);
  const roles = team.nodes.map((node) => {
    const [harness, ...rest] = node.agent.split(":");
    return { id: node.id, responsibility: node.prompt ?? "", harness, ...(rest.length ? { model: rest.join(":") } : {}), count: node.count, skill: node.skill, fallback: node.fallback };
  });
  const handoffs = team.edges.map((edge) => ({ from: edge.from, to: edge.to, on: edge.on, required: edge.required, kind: edge.kind, ...(edge.cap !== undefined ? { cap: edge.cap } : {}) }));
  const graph = toGraph({ name: team.name, description: team.description, maxVisits: team.maxVisits, roles, handoffs });
  assert.equal(graph.maxVisits, 3);
  assert.deepEqual(graph.nodes[2], { id: "reviewer", agent: "codex", count: 1, skill: "audit-agent-diff", fallback: "claude:claude-haiku-5-5" });
  assert.equal(graph.nodes[1].count, 2);
  assert.equal(graph.edges[0].kind, "broadcast");
});
