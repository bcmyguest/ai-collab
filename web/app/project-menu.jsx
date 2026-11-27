import { MoreHorizontal, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** A project's Close and Delete actions; Delete keeps the repo, worktrees and message history. */
export function ProjectMenu({ project, act }) {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" className="size-8 shrink-0 rounded-md" aria-label={"Project actions for " + project}><MoreHorizontal/></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => act("request-outcome", project)}>Request an outcome</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => act("close", project)}>Close</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => act("delete", project)} className="text-destructive">Delete</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** Closed projects with a Reopen action each. */
export function ClosedProjects({ names, act }) {
  return <section aria-label="Closed projects" className="px-2 pb-2">
    <h2 className="pb-2 text-xs font-medium text-muted-foreground">Closed projects</h2>
    <ul className="flex flex-col gap-1">
      {names.map(name => <li key={name} className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{name}</span>
        <Button variant="ghost" size="sm" className="h-7 rounded-md px-2 text-xs" onClick={() => act("reopen", name)}><RotateCcw/>Reopen</Button>
      </li>)}
    </ul>
  </section>;
}
