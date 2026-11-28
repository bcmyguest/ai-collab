"use client";
// The phone header's agent switcher: jump to another agent of the open thread without going back to the list.
import { ChevronsUpDown } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { cn } from "@/lib/utils";
import { shortName, type Agent, type Thread } from "@/lib/thread-groups";

const ITEM = "flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 focus-visible:-outline-offset-2 data-highlighted:bg-accent";

export function ThreadSwitcher({ thread, agents, current, open }: { thread?: Thread; agents: Agent[]; current?: string; open: (session: string) => void }) {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const shown = (thread?.sessions || []).map(id => byId.get(id)).filter((agent): agent is Agent => Boolean(agent && !agent.gone));
  if (shown.length < 2) return null;
  return <Menu presentation="auto">
    <MenuTrigger aria-label="Switch agent" title="Switch agent in this thread"
      className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-open:bg-accent md:hidden">
      <ChevronsUpDown aria-hidden className="size-4"/>
    </MenuTrigger>
    <MenuContent align="end" className="z-50 max-h-(--available-height) w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-raised outline-none">
      {shown.map(agent => <MenuItem key={agent.id} className={cn(ITEM, agent.id === current && "font-medium text-primary")}
        onSelect={() => open(agent.id)}>
        <span className="min-w-0 flex-1 truncate">{shortName(agent, thread?.title) || agent.id}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{agent.peer || agent.id.split("#")[0]}</span>
      </MenuItem>)}
    </MenuContent>
  </Menu>;
}
