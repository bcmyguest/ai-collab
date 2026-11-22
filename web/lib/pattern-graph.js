// Pattern graphs: an adapter from a listed pattern to the wteam-shaped graph, its DOT text, and the SVG layout the renderer draws.
export const DONE_ID = "done";
export const DEFAULT_KIND = "pair";
export const NODE_W = 120;
export const NODE_H = 48;
export const SLOT_GAP = 176;
export const DEPTH_GAP = 100;
export const PAD = 16;
export const LABEL_MAX = 12;
export const LANE_GAP = 26;
const CHAR_W = 6.6;

/**
 * A listed pattern as a graph: nodes with agent (harness:model), count and skill; edges with on, kind, required and cap.
 * Saved patterns carry no kind or count or skill, so every edge is "pair" and every node counts once.
 */
export function toGraph(pattern) {
  const nodes = (pattern.roles ?? []).map(role => ({
    id: role.id, agent: role.model ? `${role.harness}:${role.model}` : role.harness ?? "", count: 1, skill: "",
  }));
  const edges = (pattern.handoffs ?? []).map(handoff => ({
    from: handoff.from, to: handoff.to, on: handoff.on, kind: DEFAULT_KIND, required: handoff.required,
    ...(handoff.cap !== undefined ? { cap: handoff.cap } : {}),
  }));
  return { description: pattern.description ?? "", nodes, edges, maxVisits: null };
}

const quote = text => `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The definition as DOT text, the form wteam reads. Read-only: the Raw view shows it, nothing parses it back yet. */
export function toDot(graph, name) {
  const lines = [`digraph ${quote(name)} {`];
  const attrs = [];
  if (graph.description) attrs.push(`description=${quote(graph.description)}`);
  if (graph.maxVisits !== null && graph.maxVisits !== undefined) attrs.push(`max_visits=${graph.maxVisits}`);
  if (attrs.length) lines.push(`  graph [${attrs.join(", ")}];`);
  for (const node of graph.nodes) {
    const fields = [`agent=${quote(node.agent)}`, `count=${node.count}`];
    if (node.skill) fields.push(`skill=${quote(node.skill)}`);
    lines.push(`  ${quote(node.id)} [${fields.join(", ")}];`);
  }
  for (const edge of graph.edges) {
    const fields = [`on=${quote(edge.on)}`, `kind=${quote(edge.kind)}`, `required=${edge.required ? "true" : "false"}`];
    if (edge.cap !== undefined) fields.push(`cap=${edge.cap}`);
    lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [${fields.join(", ")}];`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Node depth from the first node over the edges; a node no edge reaches sits at depth 0. */
function depthsOf(graph) {
  const depth = new Map([[graph.nodes[0].id, 0]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of graph.edges) {
      if (edge.to === DONE_ID || !depth.has(edge.from)) continue;
      const next = depth.get(edge.from) + 1;
      if (!depth.has(edge.to) || next < depth.get(edge.to)) {
        depth.set(edge.to, next);
        grew = true;
      }
    }
  }
  for (const node of graph.nodes) if (!depth.has(node.id)) depth.set(node.id, 0);
  return depth;
}

/** Width of an edge label's widest line at 11px mono, plus padding. */
function labelWidth(edge) {
  return Math.max(...edgeLines(edge).map(line => line.length)) * CHAR_W + 14;
}

/**
 * Vertical layout: the first node at the top, one row per depth, nodes side by side within a row, done last.
 * An edge one row down runs straight; an edge that goes up, stays in its row, or skips rows loops out to the left,
 * in its own lane. A skipping edge's label sits in the gap above its target, clear of the rows it passes.
 */
export function layoutGraph(graph) {
  if (!graph.nodes.length) return { nodes: [], edges: [], width: 2 * PAD, height: 2 * PAD };
  const depth = depthsOf(graph);
  const perDepth = new Map();
  const nodes = graph.nodes.map(node => {
    const d = depth.get(node.id);
    const slot = perDepth.get(d) ?? 0;
    perDepth.set(d, slot + 1);
    return { ...node, depth: d, slot };
  });
  const doneDepth = Math.max(...nodes.map(node => node.depth)) + 1;
  if (graph.edges.some(edge => edge.to === DONE_ID)) nodes.push({ id: DONE_ID, agent: "", count: 1, skill: "", depth: doneDepth, slot: 0, done: true });
  const rowOf = new Map(nodes.map(node => [node.id, node.depth]));
  const sideRoute = edge => rowOf.get(edge.to) - rowOf.get(edge.from) !== 1;
  const unshifted = new Map(nodes.map(node => [node.id, PAD + node.slot * SLOT_GAP]));
  let offset = 0;
  let lanes = 0;
  for (const edge of graph.edges) {
    if (!sideRoute(edge)) continue;
    const bulge = Math.min(unshifted.get(edge.from), unshifted.get(edge.to)) - 40 - lanes * LANE_GAP;
    lanes += 1;
    offset = Math.max(offset, PAD - (bulge - 4 - labelWidth(edge)));
  }
  const place = nodes.map(node => ({ ...node, x: offset + PAD + node.slot * SLOT_GAP, y: PAD + node.depth * DEPTH_GAP }));
  const at = new Map(place.map(node => [node.id, node]));
  lanes = 0;
  let right = 0;
  const edges = graph.edges.map((edge, index) => {
    const src = at.get(edge.from);
    const dst = at.get(edge.to);
    const base = { ...edge, index };
    if (!sideRoute(edge)) {
      const x1 = src.x + NODE_W / 2;
      const y1 = src.y + NODE_H;
      const x2 = dst.x + NODE_W / 2;
      const y2 = dst.y;
      const c = (y2 - y1) / 2;
      // The label sits centred on its arrow, in the gap between the rows; it adds no width.
      const lx = (x1 + x2) / 2;
      return { ...base, loop: false, path: `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`, lx, ly: (y1 + y2) / 2, anchor: "middle" };
    }
    const x1 = src.x;
    const y1 = src.y + NODE_H / 2;
    const x2 = dst.x;
    const y2 = dst.y + NODE_H / 2;
    const bulge = Math.min(x1, x2) - 40 - lanes * LANE_GAP;
    lanes += 1;
    right = Math.max(right, src.x + NODE_W, dst.x + NODE_W);
    const skips = rowOf.get(edge.to) - rowOf.get(edge.from) > 1;
    return {
      ...base, loop: true, path: `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x2},${y2}`,
      lx: 0.125 * x1 + 0.75 * bulge + 0.125 * x2 - 4, ly: skips ? dst.y - DEPTH_GAP / 2 : (y1 + y2) / 2, anchor: "end",
    };
  });
  const maxSlots = Math.max(...place.map(node => node.slot)) + 1;
  const nodeRight = offset + PAD + (maxSlots - 1) * SLOT_GAP + NODE_W;
  const width = Math.max(nodeRight, right) + PAD;
  const height = PAD + doneDepth * DEPTH_GAP + NODE_H + PAD;
  return { nodes: place, edges, width, height };
}

/**
 * Edge label as two lines: the event (cut to LABEL_MAX), then the kind with the cap as "max N" or, in a run, "used/N".
 * An uncapped edge fired in a run adds "×N". Long events are cut here and shown in full in the handoff list.
 */
export function edgeLines(edge, used = null) {
  const on = edge.on.length > LABEL_MAX ? `${edge.on.slice(0, LABEL_MAX - 1)}…` : edge.on;
  const meta = [edge.kind];
  if (edge.cap === undefined) { if (used) meta.push(`×${used}`); }
  else meta.push(used === null ? `max ${edge.cap}` : `${used}/${edge.cap}`);
  return [on, meta.filter(Boolean).join(" · ")];
}

/** The node's first line: its id, with ×count when a role runs more than once. */
export function nodeTitle(node) {
  return node.count > 1 ? `${node.id} ×${node.count}` : node.id;
}
