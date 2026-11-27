"use client";

import { Button } from "@/components/ui/button";
import { ageOf } from "@/lib/task-board";
import { taskLink } from "@/lib/task-tags";
import { selectionHash } from "@/lib/selection";
import { LegacyApprovalCard, LegacyQuestionCard, SuspensionCard } from "./cards";

export function DecisionQueue({ decisions = [], inbox, now, disabled, action, seen, markSeen, openInbox }) {
  const groups = new Map();
  for (const item of [...decisions].sort((a, b) => a.time - b.time)) {
    if (item.expiresAt && item.expiresAt < now) continue;
    const key = JSON.stringify([item.project, item.task?.id, item.task ? "" : item.run || item.from]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const count = [...groups.values()].reduce((total, items) => total + items.length, 0);
  return <section aria-label={inbox ? "Decision inbox" : "Operator decisions"} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">{inbox ? "Waiting on you" : "Operator decisions"} · {count}</h2>
      {!inbox && <Button variant="outline" size="sm" onClick={openInbox}>Open decision inbox</Button>}
    </div>
    {!count && <p className="text-sm text-muted-foreground">No unresolved decisions.</p>}
    {[...groups].map(([key, items]) => {
      const { project, task } = items[0];
      return <section key={key} className="flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-3 [overflow-wrap:anywhere]">
        <h3 className="text-sm font-medium">
          {project}{task && <> · <a className="underline" href={taskLink(project, task.id)}>{task.title || task.id}</a> · {task.priority}</>}
        </h3>
        {items.map(item => <div key={item.key} className="flex min-w-0 flex-col gap-1.5">
          {!seen.has(JSON.stringify([project, item.key])) && <button type="button" aria-label="Mark new decision as seen"
            className="w-fit rounded-md border border-primary/60 bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary hover:bg-primary/25"
            onClick={() => markSeen(JSON.stringify([project, item.key]))}>New</button>}
          <p className="text-xs text-muted-foreground">
            {item.from.includes("#") ? <a className="underline" href={"#" + selectionHash({ project, level: "session", session: item.from })}>{item.agentName || item.from}</a>
              : item.agentName || item.from}
            {" · Waiting "}{ageOf(item.time * 1000, now)}
            {item.run && <> · <a className="underline" href={"#" + selectionHash({ project, level: "patterns", run: item.run })}>Run {item.run}</a></>}
          </p>
          {item.kind === "Suspension" ? <SuspensionCard suspension={item.suspension} disabled={disabled}
            resume={() => action("pattern", { project, advanceRun: item.run, advanceConfirmation: item.suspension.id }, "Resumed")}/>
            : item.kind === "Approval" ? <LegacyApprovalCard approval={item.approval} now={now} disabled={disabled}
              act={payload => action("approve", { project, ...payload }, "Sent")}/>
              : <LegacyQuestionCard body={item.body} disabled={disabled}
                onAnswer={body => action("reply", { project, question: item.question, body }, "Reply sent")}/>}
          {/* Skip closes the card unanswered; a suspended run has no prompt to fall back on, so it is resumed or left waiting. */}
          {item.kind !== "Suspension" && !item.approval?.owned && <Button variant="ghost" size="sm" className="w-fit rounded-md text-muted-foreground" disabled={disabled}
            onClick={() => action("skip", { project, id: item.key }, "Skipped")}>Skip</Button>}
        </div>)}
      </section>;
    })}
  </section>;
}
