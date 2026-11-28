// Where a thread runs: "main" or its worktree folder, then its branch.
import { cn } from "@/lib/utils";

export function ThreadPlace({ place, branch, className }: { place?: string; branch?: string; className?: string }) {
  if (!place && !branch) return null;
  return <span className={cn("min-w-0 truncate", className)} title={[place, branch].filter(Boolean).join(" · ")} data-place={place || undefined}>
    {place}{place && branch && " · "}{branch && <span className="font-mono">{branch}</span>}
  </span>;
}
