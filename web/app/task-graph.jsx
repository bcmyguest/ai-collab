import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NODE, STATUS_FILL, layeredLayout, taskGraph } from "@/lib/task-graph";

const ARROW = "task-arrow";
// Keeps the 12 px page padding on each side of the canvas.
const PAGE_GUTTER = 32;

// Characters that fit beside the status bar in a node of this width (about 7.5 px per character at 13 px).
function label(title, width) {
  const max = Math.max(8, Math.floor((width - 24) / 7.5));
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

// Layers run down on a phone and right on a wide screen.
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

/** Tasks as nodes, blockers as arrows, colour by status; done tasks collapse. Tapping a node opens its owner or run. */
export function TaskGraph({ tasks, open = () => {} }) {
  const [showDone, setShowDone] = useState(true);
  const wide = useWide();
  const graph = taskGraph(tasks, { showDone });
  const laid = layeredLayout(graph.nodes, graph.edges, {
    direction: wide ? "right" : "down",
    maxWidth: wide ? undefined : window.innerWidth - PAGE_GUTTER,
  });
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const hasDone = tasks.some(task => task.status === "done");
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{graph.nodes.length} tasks · {graph.edges.length} blockers{!showDone && graph.hidden ? ` · ${graph.hidden} done hidden` : ""}</span>
      {hasDone && <Button type="button" size="sm" variant="outline" className="h-8 rounded-full" aria-pressed={!showDone} onClick={() => setShowDone(!showDone)}>
        {showDone ? "Collapse done" : "Show done"}
      </Button>}
    </div>
    <div className="overflow-x-auto">
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
          const activate = target ? { role: "button", tabIndex: 0, onClick: () => open(target), onKeyDown: e => { if (e.key === "Enter") open(target); } } : {};
          return <g key={node.id} transform={`translate(${node.x},${node.y})`} className={target ? "cursor-pointer" : undefined} {...activate}>
            <title>{`${task.title} · ${task.status}`}</title>
            <rect width={laid.nodeWidth} height={NODE.height} rx="10" className="fill-card stroke-border" strokeWidth="1"/>
            <rect width="6" height={NODE.height} rx="3" fill={STATUS_FILL[task.status]}/>
            <text x="16" y="23" fontSize="13" fontWeight="500" className="fill-foreground">{label(task.title, laid.nodeWidth)}</text>
            <text x="16" y="43" fontSize="11" className="fill-muted-foreground">{task.status}{task.owner ? ` · ${task.owner.split("#")[0]}` : ""}</text>
          </g>;
        })}
      </svg>
    </div>
  </div>;
}
