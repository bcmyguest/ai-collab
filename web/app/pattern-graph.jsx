import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { NODE_H, NODE_W, edgeLabel, layoutGraph, nodeTitle } from "@/lib/pattern-graph";
import { firedCounts } from "@/lib/pattern-view";

// Nodes are roles, arrows are handoffs: solid when required, dashed for guidance. `used` is a run; `active` names the node it is on.
export function RoleGraph({ graph, active = "", used = null, label = "Pattern graph" }) {
  const markerId = "arrow" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const geo = layoutGraph(graph);
  const fired = used ? firedCounts(used) : null;
  return <svg viewBox={`0 0 ${geo.width} ${geo.height}`} role="img" aria-label={label} className="h-auto w-full text-muted-foreground">
    <defs>
      <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L10,5 L0,10 z" className="fill-current"/>
      </marker>
    </defs>
    {geo.edges.map(edge => {
      const text = edgeLabel(edge, fired ? fired(edge) : null);
      const width = text.length * 6.6 + 12;
      const left = edge.anchor === "end" ? edge.lx - width + 4 : edge.lx - 4;
      return <g key={edge.index}>
        <path d={edge.path} fill="none" className="stroke-current" strokeWidth="1.5" strokeDasharray={edge.required ? undefined : "5 4"} markerEnd={`url(#${markerId})`}>
          <title>{`${edge.from} → ${edge.to}: "${edge.on}" (${edge.required ? "required" : "guidance"}, ${edge.kind})`}</title>
        </path>
        <rect x={left} y={edge.ly - 9} width={width} height={18} rx={9} className="fill-background stroke-border" strokeWidth="1"/>
        <text x={edge.anchor === "end" ? edge.lx : edge.lx + 4} y={edge.ly + 4} textAnchor={edge.anchor} fontSize="11" className="fill-foreground font-mono">{text}</text>
      </g>;
    })}
    {geo.nodes.map(node => {
      const isActive = node.id === active;
      const detail = [node.agent, node.skill].filter(Boolean).join(" · ");
      return <g key={node.id}>
        <rect x={node.x} y={node.y} width={NODE_W} height={NODE_H} rx={10} strokeWidth="1.5"
          className={cn(isActive ? "fill-primary stroke-primary" : node.done ? "fill-muted stroke-border" : "fill-card stroke-border")}>
          <title>{node.id}</title>
        </rect>
        <text x={node.x + NODE_W / 2} y={node.y + 19} textAnchor="middle" fontSize="13" fontWeight="600" className={cn("font-mono", isActive ? "fill-primary-foreground" : "fill-foreground")}>{nodeTitle(node)}</text>
        {detail && <text x={node.x + NODE_W / 2} y={node.y + 36} textAnchor="middle" fontSize="10" className={cn(isActive ? "fill-primary-foreground" : "fill-muted-foreground")}>
          {detail.length > 22 ? `${detail.slice(0, 21)}…` : detail}</text>}
      </g>;
    })}
  </svg>;
}

// One line per handoff: from -> to, the event that triggers it, and whether the run enforces it.
export function HandoffDiagram({ handoffs }) {
  return <ol className="flex flex-col gap-1 font-mono text-xs">
    {handoffs.map((handoff, index) => <li key={index} className="flex flex-wrap items-center gap-1">
      <span className="rounded border px-1">{handoff.from}</span>
      <span>→</span>
      <span className="rounded border px-1">{handoff.to}</span>
      <span className="text-muted-foreground">&quot;{handoff.on}&quot;</span>
      <span className={handoff.required ? "text-foreground" : "text-muted-foreground"}>
        {handoff.required ? "required" : "guidance"}{handoff.cap !== undefined ? ` · max ${handoff.cap}` : ""}
      </span>
    </li>)}
  </ol>;
}

// Two clicks: the first asks, the second runs the action.
export function ConfirmButton({ label, question, confirmLabel, onConfirm, disabled, variant = "outline" }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button type="button" size="sm" variant={variant} disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return <span role="alert" className="flex flex-wrap items-center gap-2 text-xs">
    <span>{question}</span>
    <Button type="button" size="sm" variant="destructive" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</Button>
    <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
  </span>;
}
