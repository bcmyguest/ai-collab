// Layered layout for the task dependency graph; no dependency beyond this file, so a team-graph renderer can swap in.
// Adapter shape: nodes [{id, ...}], edges [{from, to}]; an edge runs from a blocker to the task it blocks.
export const NODE = { width: 200, height: 56 };
export const NODE_MIN_WIDTH = 150;
export const GAP = { layer: 64, node: 24 };
export const STATUS_FILL = { open: "#94a3b8", decided: "#38bdf8", building: "#f59e0b", blocked: "#ef4444", done: "#10b981" };

/** The graph of tasks: done tasks go when showDone is false, and so do the edges from them. */
export function taskGraph(tasks, { showDone = true } = {}) {
  const shown = tasks.filter(task => showDone || task.status !== "done");
  const ids = new Set(shown.map(task => task.id));
  const nodes = shown.map(({ id, title, status, owner, runSession }) => ({ id, title, status, owner, runSession }));
  const edges = shown.flatMap(task => (task.blockers || []).filter(id => ids.has(id)).map(id => ({ from: id, to: task.id })));
  return { nodes, edges, hidden: tasks.length - shown.length };
}

// A node's layer is one more than its deepest blocker; the order inside a layer follows the blockers' positions.
function layersOf(nodes, edges) {
  const preds = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) if (preds.has(edge.to) && preds.has(edge.from)) preds.get(edge.to).push(edge.from);
  const depth = new Map();
  const layerOf = id => {
    if (!depth.has(id)) depth.set(id, preds.get(id).length ? 1 + Math.max(...preds.get(id).map(layerOf)) : 0);
    return depth.get(id);
  };
  const layers = [];
  for (const node of nodes) (layers[layerOf(node.id)] ||= []).push(node.id);
  const position = new Map();
  const place = () => layers.forEach(list => list.forEach((id, index) => position.set(id, index)));
  place();
  // Two barycenter sweeps: each layer sorted by the mean position of its blockers above; ties keep store order.
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let l = 1; l < layers.length; l++) {
      const mean = id => {
        const at = preds.get(id).map(p => position.get(p));
        return at.length ? at.reduce((sum, x) => sum + x, 0) / at.length : position.get(id);
      };
      layers[l].sort((a, b) => mean(a) - mean(b));
      layers[l].forEach((id, index) => position.set(id, index));
    }
  }
  return layers;
}

// Node width for a layer of `across` nodes that must fit in maxWidth; the default width when nothing is given.
function fittedWidth(across, maxWidth) {
  if (!Number.isFinite(maxWidth)) return NODE.width;
  const fit = Math.floor((maxWidth - (across - 1) * GAP.node) / across);
  return Math.min(NODE.width, Math.max(NODE_MIN_WIDTH, fit));
}

/**
 * Positions for the graph: layers run top to bottom ("down") or left to right ("right").
 * maxWidth narrows the nodes so the widest layer fits a "down" canvas (never below NODE_MIN_WIDTH).
 * Returns {width, height, nodeWidth, nodes: [{id, x, y}], edges: [{from, to, d}]}; d is SVG path data.
 */
export function layeredLayout(nodes, edges, { direction = "down", maxWidth } = {}) {
  const layers = layersOf(nodes, edges);
  const across = Math.max(1, ...layers.map(list => list.length));
  const down = direction === "down";
  const w = down ? fittedWidth(across, maxWidth) : NODE.width;
  const h = NODE.height;
  // Size of a node across its layer, and the lane one layer takes along the flow.
  const cross = down ? w : h;
  const lane = (down ? h : w) + GAP.layer;
  const step = cross + GAP.node;
  // Cross-axis extent of the widest layer; a narrower layer is centred on it.
  const span = across * cross + (across - 1) * GAP.node;
  const placed = new Map();
  layers.forEach((list, l) => {
    const inLayer = list.length * cross + (list.length - 1) * GAP.node;
    const offset = (span - inLayer) / 2;
    list.forEach((id, index) => {
      const offsetAcross = offset + index * step;
      const along = l * lane;
      placed.set(id, down ? { x: offsetAcross, y: along } : { x: along, y: offsetAcross });
    });
  });
  const width = down ? span : Math.max(0, layers.length - 1) * lane + w;
  const height = down ? Math.max(0, layers.length - 1) * lane + h : span;
  const laid = nodes.map(node => ({ id: node.id, ...placed.get(node.id) }));
  const routed = edges.filter(edge => placed.has(edge.from) && placed.has(edge.to)).map(({ from, to }) => {
    const a = placed.get(from);
    const b = placed.get(to);
    const d = down
      ? { x1: a.x + w / 2, y1: a.y + h, x2: b.x + w / 2, y2: b.y }
      : { x1: a.x + w, y1: a.y + h / 2, x2: b.x, y2: b.y + h / 2 };
    const mid = down ? (d.y2 - d.y1) / 2 : (d.x2 - d.x1) / 2;
    const path = down
      ? `M${d.x1},${d.y1} C${d.x1},${d.y1 + mid} ${d.x2},${d.y2 - mid} ${d.x2},${d.y2}`
      : `M${d.x1},${d.y1} C${d.x1 + mid},${d.y1} ${d.x2 - mid},${d.y2} ${d.x2},${d.y2}`;
    return { from, to, d: path };
  });
  return { width, height, nodeWidth: w, nodes: laid, edges: routed };
}
