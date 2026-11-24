import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_KIND, LABEL_MAX, edgeLines, layoutGraph, nodeTitle, toDot, toGraph } from "../web/lib/pattern-graph.js";
import { canCopy, canDelete, firedCounts, pendingEvents, runsOf } from "../web/lib/pattern-view.js";
import { parseSelection } from "../web/lib/selection.js";

const fixOne = {
  name: "fix-and-review",
  description: "Scope, implement, and review one change.",
  roles: [
    { id: "lead", harness: "claude", model: "claude-haiku-5-5", responsibility: "Scope." },
    { id: "implementer", harness: "claude", model: "claude-haiku-5-5", responsibility: "Edit." },
    { id: "reviewer", harness: "cursor", model: "deepseek-v41-flash-1017-high", responsibility: "Review." },
  ],
  handoffs: [
    { from: "lead", to: "implementer", on: "scope", required: false },
    { from: "implementer", to: "reviewer", on: "diff and test results", required: true },
    { from: "reviewer", to: "implementer", on: "changes requested", required: false, cap: 3 },
    { from: "reviewer", to: "lead", on: "approved", required: true },
    { from: "lead", to: "done", on: "finished", required: false },
  ],
};

test("the patterns level keeps its pattern, raw flag and run in the selection", () => {
  assert.deepEqual(parseSelection("level=patterns&project=demo&pattern=fix-and-review&raw=1"), {
    project: "demo", level: "patterns", harness: "", session: "", tab: "chat", run: "", pattern: "fix-and-review", raw: true,
  });
  assert.equal(parseSelection("level=patterns&project=demo&run=abc123").run, "abc123");
  assert.equal(parseSelection("level=patterns&project=demo").raw, false);
});

test("delete is offered only for removable entries; built-in and global patterns copy to the project", () => {
  assert.equal(canDelete({ source: "project", removable: true }), true);
  assert.equal(canDelete({ source: "team", removable: true }), true);
  assert.equal(canDelete({ source: "team", removable: false }), false);
  assert.equal(canDelete({ source: "global" }), false);
  assert.equal(canDelete({ source: "built-in" }), false);
  assert.equal(canCopy("built-in"), true);
  assert.equal(canCopy("global"), true);
  assert.equal(canCopy("other"), true);
  assert.equal(canCopy("project"), false);
});

test("pendingEvents lists the active role's events while a run is running", () => {
  const run = { status: "running", active: "reviewer", definition: fixOne };
  assert.deepEqual(pendingEvents(run), ["changes requested", "approved"]);
  assert.deepEqual(pendingEvents({ ...run, status: "done" }), []);
});

test("runsOf keeps the runs of one pattern in order", () => {
  const runs = [{ id: "a", pattern: "x" }, { id: "b", pattern: "y" }, { id: "c", pattern: "x" }];
  assert.deepEqual(runsOf(runs, "x").map((run) => run.id), ["a", "c"]);
});

test("toGraph maps roles to agent nodes and handoffs to pair edges with required and cap", () => {
  const graph = toGraph(fixOne);
  assert.equal(graph.description, "Scope, implement, and review one change.");
  assert.deepEqual(graph.nodes[2], { id: "reviewer", agent: "cursor:deepseek-v41-flash-1017-high", count: 1, skill: "" });
  assert.equal(graph.nodes[0].agent, "claude:claude-haiku-5-5");
  assert.equal(graph.edges.length, 5);
  assert.deepEqual(graph.edges[2], { from: "reviewer", to: "implementer", on: "changes requested", kind: DEFAULT_KIND, required: false, cap: 3 });
  assert.equal("cap" in graph.edges[0], false);
  assert.equal(graph.maxVisits, null);
});

test("a team with no handoffs maps to nodes only", () => {
  const graph = toGraph({ name: "crew", legacy: true, roles: [{ id: "claude-1", harness: "claude" }], handoffs: [] });
  assert.equal(graph.edges.length, 0);
  assert.equal(graph.nodes[0].agent, "claude");
});

test("toDot writes the definition as DOT with node and edge attributes", () => {
  const dot = toDot(toGraph({ ...fixOne, roles: [fixOne.roles[0]], handoffs: [{ from: "lead", to: "done", on: "say \"done\"", required: true }] }), "fix-and-review");
  assert.equal(dot, [
    'digraph "fix-and-review" {',
    '  graph [description="Scope, implement, and review one change."];',
    '  "lead" [agent="claude:claude-haiku-5-5", count=1];',
    '  "lead" -> "done" [on="say \\"done\\"", kind="pair", required=true];',
    "}",
  ].join("\n"));
});

test("toDot quotes ids that DOT would misread: hyphens, dots and keywords", () => {
  const graph = {
    description: "",
    nodes: [{ id: "claude-1", agent: "claude", count: 1, skill: "" }, { id: "code-reviewer", agent: "codex", count: 1, skill: "" }, { id: "node", agent: "claude", count: 1, skill: "" }],
    edges: [
      { from: "claude-1", to: "code-reviewer", on: "ready", kind: "pair", required: true },
      { from: "code-reviewer", to: "node", on: "ok", kind: "pair", required: false },
    ],
    maxVisits: null,
  };
  const dot = toDot(graph, "fix");
  assert.match(dot, /^ {2}"claude-1" \[agent="claude", count=1\];$/m);
  assert.match(dot, /^ {2}"node" \[agent="claude", count=1\];$/m);
  assert.match(dot, /^ {2}"claude-1" -> "code-reviewer" \[on="ready", kind="pair", required=true\];$/m);
  assert.match(dot, /^ {2}"code-reviewer" -> "node" \[on="ok", kind="pair", required=false\];$/m);
});

test("toDot adds max_visits and skill when the graph carries them", () => {
  const graph = { description: "", nodes: [{ id: "worker", agent: "codex", count: 2, skill: "review" }], edges: [], maxVisits: 4 };
  assert.equal(toDot(graph, "t"), 'digraph "t" {\n  graph [max_visits=4];\n  "worker" [agent="codex", count=2, skill="review"];\n}');
});

test("the layout puts the entry first, the reviewer below it, and done last", () => {
  const geo = layoutGraph(toGraph(fixOne));
  const at = Object.fromEntries(geo.nodes.map((node) => [node.id, node]));
  assert.ok(at.lead.y < at.implementer.y);
  assert.ok(at.implementer.y < at.reviewer.y);
  assert.ok(at.reviewer.y < at.done.y);
  assert.equal(at.done.done, true);
  assert.equal(geo.edges.length, 5);
});

test("backward, same-row and row-skipping edges loop out to the side; one-row forward edges run down", () => {
  const geo = layoutGraph(toGraph(fixOne));
  const loops = geo.edges.filter((edge) => edge.loop).map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(loops, ["lead->done", "reviewer->implementer", "reviewer->lead"]);
  assert.equal(geo.edges.find((edge) => edge.from === "lead" && edge.to === "implementer").loop, false);
});

test("a row-skipping edge labels in the gap above its target, clear of the rows it passes", () => {
  const geo = layoutGraph(toGraph(fixOne));
  const skip = geo.edges.find((edge) => edge.from === "lead" && edge.to === "done");
  const done = geo.nodes.find((node) => node.id === "done");
  const reviewer = geo.nodes.find((node) => node.id === "reviewer");
  assert.ok(skip.ly > reviewer.y + 48 && skip.ly < done.y);
});

test("a node counted twice shows its count", () => {
  assert.equal(nodeTitle({ id: "worker", count: 2 }), "worker ×2");
  assert.equal(nodeTitle({ id: "worker", count: 1 }), "worker");
});

test("an edge label is two lines: the event cut to LABEL_MAX, then the kind with the cap or the used count", () => {
  const capped = toGraph(fixOne).edges[2];
  const cut = "changes requested".slice(0, LABEL_MAX - 1) + "…";
  assert.deepEqual(edgeLines(capped), [cut, "pair · max 3"]);
  assert.deepEqual(edgeLines(capped, 2), [cut, "pair · 2/3"]);
  assert.deepEqual(edgeLines(toGraph(fixOne).edges[0], 2), ["scope", "pair · ×2"]);
  assert.equal(edgeLines({ on: "x".repeat(40), kind: "fan-in" })[0].length, LABEL_MAX);
});

test("firedCounts counts handoffs by from, to and event", () => {
  const run = { handoffs: [{ from: "reviewer", to: "implementer", on: "changes requested" }, { from: "reviewer", to: "implementer", on: "changes requested" }] };
  const fired = firedCounts(run);
  assert.equal(fired(toGraph(fixOne).edges[2]), 2);
  assert.equal(fired(toGraph(fixOne).edges[3]), 0);
});
