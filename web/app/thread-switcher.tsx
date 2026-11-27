"use client";
// The phone header's thread switcher: jump to another thread of the project without going back to the list.
import { ChevronsUpDown } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { cn } from "@/lib/utils";
import { threadSession, type Agent, type Thread } from "@/lib/thread-groups";

const ITEM = "flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 focus-visible:-outline-offset-2 data-highlighted:bg-accent";

export function ThreadSwitcher({ threads, agents, current, open }: { threads: Thread[]; agents: Agent[]; current?: string; open: (session: string) => void }) {
  const shown = threads.filter(thread => thread.status !== "archived" && (thread.sessions || []).length > 0)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (shown.length < 2) return null;
  return <Menu presentation="auto">
    <MenuTrigger aria-label="Switch thread" title="Switch thread"
      className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground data-open:bg-accent md:hidden">
      <ChevronsUpDown aria-hidden className="size-4"/>
    </MenuTrigger>
    <MenuContent align="end" className="z-50 max-h-(--available-height) w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-raised outline-none">
      {shown.map(thread => <MenuItem key={thread.id} className={cn(ITEM, thread.id === current && "font-medium text-primary")}
        onSelect={() => open(threadSession(thread, agents))}>
        <span className="min-w-0 flex-1 truncate">{thread.title || thread.branch || thread.id}</span>
      </MenuItem>)}
    </MenuContent>
  </Menu>;
}
