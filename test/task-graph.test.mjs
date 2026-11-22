import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC, GAP, NODE, NODE_MIN_WIDTH, layeredLayout, listLayout, taskGraph } from "../web/lib/task-graph.js";

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

test("maxWidth narrows the nodes and wraps a layer into rows that fit the phone", () => {
  const tasks = [task("a"), task("b")];
  const fitted = layeredLayout(nodesOf(tasks), [], { maxWidth: 358 });
  assert.equal(fitted.nodeWidth, (358 - GAP.node) / 2);
  assert.equal(fitted.width, 358);
  assert.equal(at(fitted, "b").x, fitted.nodeWidth + GAP.node);
  // Three roots on a phone: two per row, the third wraps below, and every node stays inside the canvas.
  const wrapped = layeredLayout(nodesOf([task("a"), task("b"), task("c")]), [], { maxWidth: 358 });
  assert.equal(wrapped.nodeWidth, Math.floor((358 - GAP.node) / 2));
  assert.equal(at(wrapped, "c").y, NODE.height + GAP.node);
  assert.equal(at(wrapped, "c").x, (wrapped.width - wrapped.nodeWidth) / 2);
  for (const node of wrapped.nodes) assert.ok(node.x >= 0 && node.x + wrapped.nodeWidth <= wrapped.width + 0.5);
  assert.equal(layeredLayout(nodesOf(tasks), []).nodeWidth, NODE.width);
});

test("an edge that skips a layer routes through a gap in the layer between", () => {
  // a -> c skips layer 1, which holds b; the route must pass beside b, not through it.
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"])];
  const laid = layeredLayout(nodesOf(tasks), edgesOf(tasks));
  const skip = laid.edges.find(edge => edge.from === "a" && edge.to === "c");
  assert.equal(skip.d.split(" C").length - 1, 2, "two cubic hops through one dummy point");
  const b = at(laid, "b");
  const xs = [...skip.d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map(m => [Number(m[1]), Number(m[2])]);
  const midpoint = xs.find(([, y]) => y > b.y && y < b.y + NODE.height) ?? [0, 0];
  assert.ok(midpoint[0] < b.x || midpoint[0] > b.x + NODE.width, "the route passes outside the node in the middle layer");
});

test("an empty graph lays out to an empty canvas", () => {
  const laid = layeredLayout([], []);
  assert.deepEqual([laid.nodes, laid.edges], [[], []]);
  assert.equal(laid.height, NODE.height);
});

test("the list layout stacks one node per row in dependency order, arcs in a gutter on the left", () => {
  const tasks = [task("a"), task("b", ["a"]), task("c", ["a", "b"]), task("d")];
  const laid = listLayout(nodesOf(tasks), edgesOf(tasks), { maxWidth: 390 - 32 });
  assert.deepEqual(laid.nodes.map(node => node.id), ["a", "d", "b", "c"]);
  // Blockers sit above what they block.
  assert.ok(at(laid, "a").y < at(laid, "b").y && at(laid, "b").y < at(laid, "c").y);
  for (const [i, node] of laid.nodes.entries()) assert.equal(node.y, i * (NODE.height + GAP.node));
  const gutter = at(laid, "a").x;
  assert.ok(gutter > 0 && laid.nodes.every(node => node.x === gutter));
  assert.ok(laid.width <= 390 - 32, "fits the phone");
  assert.equal(laid.edges.length, 3, "the skipping edge is drawn too, with no dummy node");
  for (const edge of laid.edges) {
    const xs = [...edge.d.matchAll(/(-?\d+(?:\.\d+)?),/g)].map(m => Number(m[1]));
    assert.ok(xs.every(x => x <= gutter), "arcs stay in the gutter, never over a node");
  }
});

test("arcs whose rows overlap take different lanes; the bulge stays inside the canvas", () => {
  const tasks = [task("a"), task("b"), task("c", ["a"]), task("d", ["b"]), task("e", ["a", "b"])];
  const laid = listLayout(nodesOf(tasks), edgesOf(tasks));
  const reach = (from, to) => laid.edges.find(edge => edge.from === from && edge.to === to).d.match(/C(-?[\d.]+),/)[1];
  assert.notEqual(reach("a", "c"), reach("a", "e"), "overlapping spans do not share a lane");
  for (const edge of laid.edges) assert.ok(Number(reach(edge.from, edge.to)) >= 0);
  assert.ok(ARC.base > 0);
});

test("many overlapping arcs compress into a gutter that keeps the phone canvas inside 358 px", () => {
  const tasks = [task("root"), ...Array.from({ length: 20 }, (_, i) => task(`child-${i}`, ["root"]))];
  const laid = listLayout(nodesOf(tasks), edgesOf(tasks), { maxWidth: 358 });
  assert.ok(laid.width <= 358, `width ${laid.width} fits the phone`);
  assert.ok(laid.nodeWidth >= NODE_MIN_WIDTH);
  assert.equal(laid.edges.length, 20);
  for (const edge of laid.edges) assert.ok(Number(edge.d.match(/C(-?[\d.]+),/)[1]) >= 0, "no arc leaves the canvas");
});
