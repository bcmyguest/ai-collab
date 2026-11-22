import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_KIND, LABEL_MAX, edgeLabel, layoutGraph, nodeTitle, toDot, toGraph } from "../web/lib/pattern-graph.js";
import { canCopy, canEdit, firedCounts, pendingEvents, runsOf } from "../web/lib/pattern-view.js";
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

test("built-in and global patterns copy to the project; project patterns and teams can be deleted", () => {
  assert.equal(canEdit("project"), true);
  assert.equal(canEdit("team"), true);
  assert.equal(canEdit("built-in"), false);
  assert.equal(canEdit("global"), false);
  assert.equal(canCopy("built-in"), true);
  assert.equal(canCopy("global"), true);
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
    '  lead [agent="claude:claude-haiku-5-5", count=1];',
    '  lead -> done [on="say \\"done\\"", kind="pair", required=true];',
    "}",
  ].join("\n"));
});

test("toDot adds max_visits and skill when the graph carries them", () => {
  const graph = { description: "", nodes: [{ id: "worker", agent: "codex", count: 2, skill: "review" }], edges: [], maxVisits: 4 };
  assert.equal(toDot(graph, "t"), 'digraph "t" {\n  graph [max_visits=4];\n  worker [agent="codex", count=2, skill="review"];\n}');
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

test("backward and same-row edges loop out to the side; forward edges run down", () => {
  const geo = layoutGraph(toGraph(fixOne));
  const loops = geo.edges.filter((edge) => edge.loop).map((edge) => `${edge.from}->${edge.to}`).sort();
  assert.deepEqual(loops, ["reviewer->implementer", "reviewer->lead"]);
  assert.equal(geo.edges.find((edge) => edge.from === "lead" && edge.to === "implementer").loop, false);
});

test("a node counted twice shows its count", () => {
  assert.equal(nodeTitle({ id: "worker", count: 2 }), "worker ×2");
  assert.equal(nodeTitle({ id: "worker", count: 1 }), "worker");
});

test("an edge label shows the event, its kind, and the cap or the used count", () => {
  const capped = toGraph(fixOne).edges[2];
  assert.equal(edgeLabel(capped), "changes requested · pair · max 3");
  assert.equal(edgeLabel(capped, 2), "changes requested · pair · 2/3");
  assert.equal(edgeLabel(toGraph(fixOne).edges[0], 2), "scope · pair · ×2");
  assert.equal(edgeLabel({ on: "x".repeat(40), kind: "fan-in" }).split(" · ")[0].length, LABEL_MAX);
});

test("firedCounts counts handoffs by from, to and event", () => {
  const run = { handoffs: [{ from: "reviewer", to: "implementer", on: "changes requested" }, { from: "reviewer", to: "implementer", on: "changes requested" }] };
  const fired = firedCounts(run);
  assert.equal(fired(toGraph(fixOne).edges[2]), 2);
  assert.equal(fired(toGraph(fixOne).edges[3]), 0);
});
