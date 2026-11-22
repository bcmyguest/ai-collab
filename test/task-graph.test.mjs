import assert from "node:assert/strict";
import { test } from "node:test";
import { GAP, NODE, layeredLayout, taskGraph } from "../web/lib/task-graph.js";

const task = (id, blockers = [], status = "open") => ({ id, title: id, status, blockers });
const nodesOf = (tasks) => tasks.map(({ id }) => ({ id }));
const edgesOf = (tasks) => tasks.flatMap(t => t.blockers.map(from => ({ from, to: t.id })));
const at = (laid, id) => laid.nodes.find(node => node.id === id);

test("taskGraph draws blocker edges and drops done tasks when hidden", () => {
  const tasks = [task("a", [], "done"), task("b", ["a"]), task("c", ["b", "zz"], "blocked")];
  const shown = taskGraph(tasks);
  assert.deepEqual(shown.edges, [{ from: "a", to: "b" }, { from: "b", to: "c" }]);
  assert.equal(shown.hidden, 0);
  const hidden = taskGraph(tasks, { showDone: false });
  assert.deepEqual(hidden.nodes.map(node => node.id), ["b", "c"]);
  assert.deepEqual(hidden.edges, [{ from: "b", to: "c" }]);
  assert.equal(hidden.hidden, 1);
});

test("a chain lays out one layer per step, top to bottom", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["b"])];
  const laid = layeredLayout(nodesOf(tasks), edgesOf(tasks));
  assert.deepEqual([at(laid, "a").y, at(laid, "b").y, at(laid, "c").y], [0, NODE.height + GAP.layer, 2 * (NODE.height + GAP.layer)]);
  assert.equal(laid.height, 2 * (NODE.height + GAP.layer) + NODE.height);
  assert.equal(laid.width, NODE.width);
});

test("a diamond puts the join one layer below both branches and centres the layers", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])];
  const laid = layeredLayout(nodesOf(tasks), edgesOf(tasks));
  assert.equal(at(laid, "d").y, 2 * (NODE.height + GAP.layer));
  const bx = at(laid, "b").x;
  const cx = at(laid, "c").x;
  assert.ok(bx !== cx, "siblings do not overlap");
  assert.equal(Math.abs(bx - cx), NODE.width + GAP.node);
  // The lone task sits centred on the two-wide layer.
  assert.equal(at(laid, "a").x, (laid.width - NODE.width) / 2);
  assert.equal(at(laid, "d").x, (laid.width - NODE.width) / 2);
});

test("layout to the right runs layers left to right with the same spacing", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a"])];
  const laid = layeredLayout(nodesOf(tasks), edgesOf(tasks), { direction: "right" });
  assert.equal(at(laid, "a").x, 0);
  assert.equal(at(laid, "b").x, NODE.width + GAP.layer);
  assert.equal(Math.abs(at(laid, "b").y - at(laid, "c").y), NODE.height + GAP.node);
  assert.equal(laid.height, 2 * NODE.height + GAP.node);
});

test("edges start at the blocker and end at the blocked task, inside the canvas", () => {
  const tasks = [task("a"), task("b", ["a"])];
  const laid = layeredLayout(nodesOf(tasks), edgesOf(tasks));
  const [edge] = laid.edges;
  assert.equal(edge.d, `M${NODE.width / 2},${NODE.height} C${NODE.width / 2},${NODE.height + GAP.layer / 2} ${NODE.width / 2},${NODE.height + GAP.layer / 2} ${NODE.width / 2},${NODE.height + GAP.layer}`);
  for (const node of laid.nodes) {
    assert.ok(node.x >= 0 && node.x + NODE.width <= laid.width);
    assert.ok(node.y >= 0 && node.y + NODE.height <= laid.height);
  }
});

test("maxWidth narrows the nodes so a two-wide layer fits the phone, never below the minimum", () => {
  const tasks = [task("a"), task("b")];
  const fitted = layeredLayout(nodesOf(tasks), [], { maxWidth: 358 });
  assert.equal(fitted.nodeWidth, (358 - GAP.node) / 2);
  assert.equal(fitted.width, 358);
  assert.equal(at(fitted, "b").x, fitted.nodeWidth + GAP.node);
  const wide = layeredLayout(nodesOf([task("a"), task("b"), task("c")]), [], { maxWidth: 358 });
  assert.equal(wide.nodeWidth, 150);
  assert.equal(layeredLayout(nodesOf(tasks), []).nodeWidth, NODE.width);
});

test("an empty graph lays out to an empty canvas", () => {
  const laid = layeredLayout([], []);
  assert.deepEqual([laid.nodes, laid.edges], [[], []]);
  assert.equal(laid.height, NODE.height);
});
