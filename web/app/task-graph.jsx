import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NODE, STATUS_FILL, layeredLayout, listLayout, taskGraph } from "@/lib/task-graph";
import { priorityOf } from "../../lib/task-order.mjs";

const ARROW = "task-arrow";
// Keeps the 12 px page padding on each side of the canvas.
const PAGE_GUTTER = 32;
const LIST_BELOW = 600;
const CHAR_WIDTH = 7.5;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Graphemes that fit beside the status bar in a node of this width; a cut title ends in an ellipsis.
function label(title, width) {
  const graphemes = [...segmenter.segment(title)].map(part => part.segment);
  const max = Math.max(8, Math.floor((width - 24) / CHAR_WIDTH));
  return graphemes.length > max ? `${graphemes.slice(0, max - 1).join("")}…` : title;
}

// Window width, re-read on resize and orientation change.
function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const update = () => setWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return width;
}

/** Tasks as nodes, blockers as arrows, colour by status; done tasks collapse. Tapping a node opens its owner or run. */
export function TaskGraph({ tasks, open = () => {} }) {
  const [showDone, setShowDone] = useState(true);
  const viewport = useViewportWidth();
  const graph = taskGraph(tasks, { showDone });
  // A phone gets one node per row with arcs in a left gutter; wider screens flow layers left to right.
  const laid = viewport < LIST_BELOW
    ? listLayout(graph.nodes, graph.edges, { maxWidth: viewport - PAGE_GUTTER })
    : layeredLayout(graph.nodes, graph.edges, { direction: "right" });
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const hasDone = tasks.some(task => task.status === "done");
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{graph.nodes.length} tasks · {graph.edges.length} blockers{!showDone && graph.hidden ? ` · ${graph.hidden} done hidden` : ""}</span>
      {hasDone && <Button type="button" size="sm" variant="outline" className="h-8 rounded-full" aria-pressed={!showDone} onClick={() => setShowDone(!showDone)}>
        {showDone ? "Collapse done" : "Show done"}
      </Button>}
    </div>
    {graph.nodes.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No tasks to graph.</p>
      : <div className="overflow-x-auto">
        <svg role="img" aria-label="Task dependency graph" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`} className="mx-auto block">
          <defs>
            <marker id={ARROW} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground"/>
            </marker>
          </defs>
          {laid.edges.map(edge => <path key={`${edge.from}>${edge.to}`} d={edge.d} fill="none" strokeWidth="1.5" className="stroke-muted-foreground" markerEnd={`url(#${ARROW})`}/>)}
          {laid.nodes.map(node => {
            const task = byId.get(node.id);
            const target = task.owner || task.runSession || "";
            const activate = target ? { role: "button", tabIndex: 0, "aria-label": `${task.title}, open ${target}`, onClick: () => open(target), onKeyDown: e => { if (e.key === "Enter") open(target); } } : {};
            return <g key={node.id} transform={`translate(${node.x},${node.y})`} className={target ? "cursor-pointer" : undefined} {...activate}>
              <title>{`${task.title} · ${task.status}`}</title>
              <rect width={laid.nodeWidth} height={NODE.height} rx="10" className="fill-card stroke-border" strokeWidth="1"/>
              <rect width="6" height={NODE.height} rx="3" fill={STATUS_FILL[task.status]}/>
              <text x="16" y="23" fontSize="13" fontWeight="500" className="fill-foreground">{label(task.title, laid.nodeWidth)}</text>
              <text x="16" y="43" fontSize="11" className="fill-muted-foreground">{task.status}{task.owner ? ` · ${task.owner.split("#")[0]}` : ""}</text>
              <text x={laid.nodeWidth - 8} y="20" fontSize="10" textAnchor="end" className="fill-muted-foreground">{priorityOf(task)}</text>
            </g>;
          })}
        </svg>
      </div>}
  </div>;
}
