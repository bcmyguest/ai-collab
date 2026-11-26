import assert from "node:assert/strict";
import { test } from "node:test";
import { DotError, parseDot, serializeDot } from "../lib/catalog/dot.ts";

const TEAM = `digraph "review-loop" {
  graph [description="Write, then review", max_visits=4];
  lead [agent="claude:claude-haiku-5-5", prompt="Scope the change.", skill="scope-work", fallback="codex", code_mode=off];
  doer [agent="codex", count=3, prompt="Write the change.\\nKeep the diff small."];
  "review-1" [agent="opencode", prompt="Review it."];
  lead -> doer [on="scoped", kind="broadcast", required=true, cap=2];
  doer -> "review-1" [on="written", kind="fan-in"];
  "review-1" -> done [on="approved", required=true];
}
`;

test("a team with every attribute serializes to canonical text that parses back equal", () => {
  const team = parseDot(TEAM);
  const text = serializeDot(team);
  assert.deepEqual(parseDot(text), team);
  assert.equal(serializeDot(parseDot(text)), text);
  assert.equal(text.split("\n")[0], 'digraph "review-loop" {');
  assert.match(text, /^  graph \[description="Write, then review", max_visits=4\];$/m);
  assert.match(text, /^  "review-1" \[agent="opencode", count=1, prompt="Review it."\];$/m);
  assert.match(text, /^  "doer" -> "review-1" \[on="written", kind="fan-in", required=false\];$/m);
  assert.match(text, /^  "review-1" -> "done" \[on="approved", kind="pair", required=true\];$/m);
});

test("parsed nodes keep the DOT-only fields: count, skill, fallback and code_mode", () => {
  const team = parseDot(TEAM);
  assert.equal(team.maxVisits, 4);
  assert.equal(team.description, "Write, then review");
  assert.deepEqual(team.nodes.map((node) => node.agent), ["claude:claude-haiku-5-5", "codex", "opencode"]);
  assert.equal(team.nodes[0].skill, "scope-work");
  assert.equal(team.nodes[0].fallback, "codex");
  assert.equal(team.nodes[0].codeMode, false);
  assert.equal(team.nodes[1].count, 3);
  assert.equal(team.nodes[1].prompt, "Write the change.\nKeep the diff small.");
  assert.deepEqual(team.edges[0], { from: "lead", to: "doer", on: "scoped", kind: "broadcast", required: true, cap: 2 });
});

test("a prompt with a newline in it survives serialize and parse", () => {
  const team = parseDot(TEAM);
  assert.equal(parseDot(serializeDot(team)).nodes[1].prompt, "Write the change.\nKeep the diff small.");
});

function errorOf(text) {
  try {
    parseDot(text);
  } catch (error) {
    assert.ok(error instanceof DotError, `expected DotError, got ${error?.name}`);
    return { line: error.line, message: error.message };
  }
  assert.fail("expected a DotError");
}

test("errors carry the line where the problem starts, and the message begins with it", () => {
  const duplicate = 'digraph "t" {\n  a [agent="claude", prompt="x"];\n  a [agent="claude"];\n}';
  assert.deepEqual(errorOf(duplicate), { line: 3, message: 'line 3: node "a" is declared twice' });
  const unclosed = 'digraph "t" {\n  a [agent="claude", prompt="x\n';
  assert.deepEqual(errorOf(unclosed), { line: 2, message: "line 2: unclosed string" });
  const unknownEdge = 'digraph "t" {\n  a [agent="claude", prompt="x"];\n  a -> zz [on="e"];\n}';
  assert.deepEqual(errorOf(unknownEdge), { line: 3, message: 'line 3: edge to unknown node "zz"' });
  const comment = 'digraph "t" {\n  a [agent="claude", prompt="x"]\n  /* open\n';
  assert.deepEqual(errorOf(comment), { line: 3, message: "line 3: unclosed comment" });
  const count = 'digraph "t" {\n  a [agent="claude", prompt="x", count="9"];\n}';
  assert.deepEqual(errorOf(count), { line: 2, message: 'line 2: count must be a whole number 1-8; got "9"' });
  const cap = 'digraph "t" {\n  a [agent="claude", prompt="x"];\n  a -> done [on="e", cap=2];\n}';
  assert.deepEqual(errorOf(cap), { line: 3, message: "line 3: cap applies to a handoff between roles, not to done" });
  const extraBrace = 'digraph "t" {\n  a [agent="claude", prompt="x"];\n}\n}';
  assert.deepEqual(errorOf(extraBrace), { line: 4, message: 'line 4: unexpected "}" after the graph' });
  const noClose = 'digraph "t" {\n  a [agent="claude", prompt="x"];\n  a -> done [on="e"];\n';
  assert.deepEqual(errorOf(noClose), { line: 3, message: 'line 3: missing "}" at end of file' });
});

test("a missing comma between attributes is accepted", () => {
  assert.equal(parseDot('digraph "t" {\n  a [agent="claude" prompt="x"];\n}').nodes[0].prompt, "x");
});

test("a node without a prompt parses; the pattern layer rejects it with the node's line", () => {
  const team = parseDot('digraph "t" {\n  a [agent="claude"];\n}');
  assert.equal(team.nodes[0].prompt, undefined);
});
