// Layered layout for the task dependency graph; no dependency beyond this file, so a team-graph renderer can swap in.
// Adapter shape: nodes [{id, ...}], edges [{from, to}]; an edge runs from a blocker to the task it blocks.
export const NODE = { width: 200, height: 56 };
export const NODE_MIN_WIDTH = 150;
export const GAP = { layer: 64, node: 24 };
// Arc bulge in the list layout: base for the first lane, step per further lane.
// The gutter never exceeds maxGutter: past a few lanes the lane spacing compresses to fit.
export const ARC = { base: 16, step: 14, maxGutter: 72 };
export const STATUS_FILL = { open: "#94a3b8", decided: "#38bdf8", building: "#f59e0b", blocked: "#ef4444", done: "#10b981" };

/** The graph of tasks: done tasks go when showDone is false, and so do the edges from them. */
export function taskGraph(tasks, { showDone = true } = {}) {
  const shown = tasks.filter(task => showDone || task.status !== "done");
  const ids = new Set(shown.map(task => task.id));
  const nodes = shown.map(({ id, title, status, owner, runSession, priority }) => ({ id, title, status, owner, runSession, priority }));
  const edges = shown.flatMap(task => (task.blockers || []).filter(id => ids.has(id)).map(id => ({ from: id, to: task.id })));
  return { nodes, edges, hidden: tasks.length - shown.length };
}

// Layers by longest blocker chain. An edge that skips layers gets a dummy node in each skipped layer,
// so its route passes between the nodes instead of through them. Returns the layers and each edge's chain.
function layeredChains(nodes, edges) {
  const ids = new Set(nodes.map(node => node.id));
  const valid = edges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const preds = new Map(nodes.map(node => [node.id, []]));
  for (const edge of valid) preds.get(edge.to).push(edge.from);
  const depth = new Map();
  const layerOf = id => {
    if (!depth.has(id)) depth.set(id, preds.get(id).length ? 1 + Math.max(...preds.get(id).map(layerOf)) : 0);
    return depth.get(id);
  };
  const layers = [];
  for (const node of nodes) (layers[layerOf(node.id)] ||= []).push(node.id);
  const chains = new Map();
  const up = new Map();
  valid.forEach((edge, index) => {
    const chain = [edge.from];
    for (let l = layerOf(edge.from) + 1; l < layerOf(edge.to); l++) {
      const dummy = `~${index}:${l}`;
      (layers[l] ||= []).push(dummy);
      chain.push(dummy);
    }
    chain.push(edge.to);
    for (let k = 1; k < chain.length; k++) (up.get(chain[k]) || up.set(chain[k], []).get(chain[k])).push(chain[k - 1]);
    chains.set(`${edge.from}>${edge.to}`, chain);
  });
  // Two barycenter sweeps: each layer sorted by the mean position of its blockers above; ties keep store order.
  const position = new Map();
  const place = () => layers.forEach(list => list.forEach((id, index) => position.set(id, index)));
  place();
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let l = 1; l < layers.length; l++) {
      const mean = id => {
        const at = (up.get(id) || []).map(p => position.get(p));
        return at.length ? at.reduce((sum, x) => sum + x, 0) / at.length : position.get(id);
      };
      layers[l].sort((a, b) => mean(a) - mean(b));
      layers[l].forEach((id, index) => position.set(id, index));
    }
  }
  return { layers, chains };
}

// SVG path through the chain's anchor points: a cubic per hop, curved along the flow.
function curve(points, down) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (down) {
      const mid = (b.y - a.y) / 2;
      d += ` C${a.x},${a.y + mid} ${b.x},${b.y - mid} ${b.x},${b.y}`;
    } else {
      const mid = (b.x - a.x) / 2;
      d += ` C${a.x + mid},${a.y} ${b.x - mid},${b.y} ${b.x},${b.y}`;
    }
  }
  return d;
}

/**
 * Positions for the graph: layers run top to bottom ("down") or left to right ("right").
 * maxWidth wraps a "down" layer into rows and narrows the nodes so each row fits (never below NODE_MIN_WIDTH).
 * Returns {width, height, nodeWidth, nodes: [{id, x, y}], edges: [{from, to, d}]}; d is SVG path data.
 */
export function layeredLayout(nodes, edges, { direction = "down", maxWidth } = {}) {
  const down = direction === "down";
  const { layers, chains } = layeredChains(nodes, edges);
  const longest = Math.max(1, ...layers.map(list => list.length));
  const fit = down && Number.isFinite(maxWidth);
  const perRow = fit ? Math.max(1, Math.min(longest, Math.floor((maxWidth + GAP.node) / (NODE_MIN_WIDTH + GAP.node)))) : longest;
  const w = fit ? Math.min(NODE.width, Math.floor((maxWidth - (perRow - 1) * GAP.node) / perRow)) : NODE.width;
  const h = NODE.height;
  const pos = new Map();
  let width;
  let height;
  if (down) {
    const span = perRow * w + (perRow - 1) * GAP.node;
    let top = 0;
    for (const list of layers) {
      const rows = Math.ceil(list.length / perRow);
      list.forEach((id, i) => {
        const row = Math.floor(i / perRow);
        const count = Math.min(perRow, list.length - row * perRow);
        const rowWidth = count * w + (count - 1) * GAP.node;
        pos.set(id, { x: (span - rowWidth) / 2 + (i % perRow) * (w + GAP.node), y: top + row * (h + GAP.node) });
      });
      top += rows * h + (rows - 1) * GAP.node + GAP.layer;
    }
    width = span;
    height = layers.length ? top - GAP.layer : h;
  } else {
    const across = longest * h + (longest - 1) * GAP.node;
    let left = 0;
    for (const list of layers) {
      const span = list.length * h + (list.length - 1) * GAP.node;
      list.forEach((id, i) => pos.set(id, { x: left, y: (across - span) / 2 + i * (h + GAP.node) }));
      left += w + GAP.layer;
    }
    width = layers.length ? left - GAP.layer : w;
    height = across;
  }
  // Anchor of a chain point: the bottom or top middle of a node (down), or its right or left middle (right).
  const anchor = (id, role) => {
    const p = pos.get(id);
    if (down) return { x: p.x + w / 2, y: role === "start" ? p.y + h : role === "end" ? p.y : p.y + h / 2 };
    return { x: role === "start" ? p.x + w : role === "end" ? p.x : p.x + w / 2, y: p.y + h / 2 };
  };
  const routed = edges.filter(edge => pos.has(edge.from) && pos.has(edge.to)).map(({ from, to }) => {
    const chain = chains.get(`${from}>${to}`);
    const points = chain.map((id, k) => anchor(id, k === 0 ? "start" : k === chain.length - 1 ? "end" : "middle"));
    return { from, to, d: curve(points, down) };
  });
  const laid = nodes.map(node => ({ id: node.id, ...pos.get(node.id) }));
  return { width, height, nodeWidth: w, nodes: laid, edges: routed };
}

// Arc lanes for the list layout: each edge takes the first lane where its row span does not overlap another's.
function arcLanes(order, edges) {
  const row = new Map(order.map((id, index) => [id, index]));
  const spans = edges.map(({ from, to }) => [row.get(from), row.get(to)]);
  const byLength = spans.map((_, index) => index).sort((a, b) => (spans[a][1] - spans[a][0]) - (spans[b][1] - spans[b][0]));
  const lanes = [];
  const lane = new Array(edges.length);
  for (const index of byLength) {
    const [a, b] = spans[index];
    let found = lanes.findIndex(taken => taken.every(([x, y]) => b <= x || a >= y));
    if (found < 0) found = lanes.push([]) - 1;
    lanes[found].push([a, b]);
    lane[index] = found;
  }
  return lane;
}

/**
 * One node per row in dependency order, arcs for the edges in a gutter to the left: no arc crosses a node.
 * Used on a phone. Returns the same shape as layeredLayout, plus the arc bulge in each edge's d.
 */
export function listLayout(nodes, edges, { maxWidth } = {}) {
  const { layers } = layeredChains(nodes, edges);
  const order = layers.flat().filter(id => nodes.some(node => node.id === id));
  const known = new Set(order);
  const valid = edges.filter(edge => known.has(edge.from) && known.has(edge.to));
  const lanes = arcLanes(order, valid);
  const laneCount = lanes.length ? Math.max(...lanes) + 1 : 0;
  const step = laneCount ? Math.min(ARC.step, (ARC.maxGutter - ARC.base) / laneCount) : ARC.step;
  const gutter = laneCount ? ARC.base + step * laneCount : ARC.base;
  const w = Number.isFinite(maxWidth) ? Math.max(NODE_MIN_WIDTH, Math.min(NODE.width, maxWidth - gutter)) : NODE.width;
  const h = NODE.height;
  const pos = new Map(order.map((id, index) => [id, { x: gutter, y: index * (h + GAP.node) }]));
  const routed = valid.map((edge, index) => {
    const a = pos.get(edge.from);
    const b = pos.get(edge.to);
    const depth = ARC.base + step * lanes[index];
    const ys = a.y + h / 2;
    const ye = b.y + h / 2;
    return { from: edge.from, to: edge.to, d: `M${gutter},${ys} C${gutter - depth},${ys} ${gutter - depth},${ye} ${gutter},${ye}` };
  });
  const height = order.length ? order.length * h + (order.length - 1) * GAP.node : h;
  return { width: gutter + w, height, nodeWidth: w, nodes: order.map(id => ({ id, ...pos.get(id) })), edges: routed };
}
