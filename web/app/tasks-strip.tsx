"use client";
// The sidebar's pinned strip: the project's top open tasks and their count, above the threads; the full board is one tap away.
import { ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";
import { statusLabel } from "@/lib/task-board";
import { priorityOf, sortTasks } from "../../lib/task-order.mjs";

type Task = { id: string; title?: string; status?: string; priority?: unknown; updated?: number; question?: { answer?: string } };
// Tasks the strip shows before pointing at the board.
const STRIP_TASKS = 4;
const PRIORITY_TONE = { P0: "text-destructive", P1: "text-primary" } satisfies Record<string, string>;

export function TasksStrip({ tasks, openTask, openBoard }: { tasks: Task[]; openTask: (id: string) => void; openBoard: () => void }) {
  const open = sortTasks(tasks.filter(task => task.status !== "done"));
  if (!open.length) return null;
  return <section aria-label="Open tasks" className="mx-2 mb-2 flex flex-col gap-0.5 rounded-2xl bg-card p-1.5 shadow-surface">
    <button type="button" onClick={openBoard} className="flex min-h-8 items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground max-md:min-h-11">
      <ListTodo aria-hidden className="size-3.5"/><span className="flex-1">Tasks</span>
      <span className="tabular-nums" aria-label={open.length + " open tasks"}>{open.length} open</span>
    </button>
    <ul className="flex flex-col">
      {open.slice(0, STRIP_TASKS).map(task => {
        const priority = priorityOf(task);
        const asks = Boolean(task.question && !task.question.answer);
        return <li key={task.id}>
          <button type="button" data-task={task.id} onClick={() => openTask(task.id)} title={task.title || task.id}
            className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm hover:bg-accent max-md:py-2">
            <span className={cn("w-5 shrink-0 font-mono text-xs", priority in PRIORITY_TONE ? PRIORITY_TONE[priority as keyof typeof PRIORITY_TONE] : "text-muted-foreground")}>{priority}</span>
            <span className="min-w-0 flex-1 truncate">{task.title || task.id}</span>
            <span className={cn("shrink-0 text-xs", asks ? "font-medium text-primary" : "text-muted-foreground")}>{asks ? "decide" : statusLabel(task.status)}</span>
          </button>
        </li>;
      })}
    </ul>
  </section>;
}
