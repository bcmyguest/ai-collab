"use client";
import { ListChecks, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";

// The icon each project view carries; the labels and hashes come from projectNavigation.
const ICONS = { project: MessageSquare, tasks: ListChecks, patterns: Users };

/**
 * A picked project's own views (Chat, Tasks and Teams) as its one navigation.
 * A computer gets a rail down the left edge beside the sidebar; a phone gets a tab bar under the composer.
 * The Tasks link's badge is the number of tasks waiting on a decision, else the project's task count, and turns amber
 * while something waits; the Teams link's badge is its pattern count.
 */
export function ProjectNav({ links, rail = false }) {
  if (!links.length) return null;
  const items = links.map(({ view, label, href, current, count, waiting }) => {
    const Icon = ICONS[view] || MessageSquare;
    // A waiting task outranks the total: the badge should say what the operator has to act on.
    const badge = waiting > 0 ? waiting : count;
    return <a key={view} href={href} aria-current={current ? "page" : undefined}
      aria-label={waiting > 0 ? `${label}, ${waiting} waiting on you` : count > 0 ? `${label}, ${count}` : label}
      className={cn("relative flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        rail ? "min-h-14 px-1 py-2 text-xs" : "min-h-11 px-1 py-1 text-xs",
        current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground")}>
      <span aria-hidden className="relative">
        <Icon className={rail ? "size-5" : "size-4"}/>
        {badge > 0 && <span className={cn("absolute -right-2.5 -top-1.5 min-w-3.5 rounded-md px-1 text-center text-xs leading-3 font-semibold",
          waiting > 0 ? "bg-primary text-white" : "bg-muted text-muted-foreground ring-1 ring-border")}>{badge}</span>}
      </span>
      <span className="max-w-full truncate">{label}</span>
    </a>;
  });
  if (rail) {
    return <nav aria-label="Project views" className="hidden w-16 shrink-0 flex-col gap-1 border-r border-sidebar-border bg-sidebar p-1.5 md:flex">
      {items}
    </nav>;
  }
  return <nav aria-label="Project views" className="shrink-0 border-t bg-background px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:hidden">
    <div className="mx-auto grid max-w-3xl grid-cols-3 gap-1">{items}</div>
  </nav>;
}
