"use client";
import { ArrowRightLeft, Bot, ChevronRight, CircleAlert, CirclePlay, CircleStop, Eraser, FileText, Globe, ListTodo, LoaderCircle, Minimize2, Paperclip, Pencil, Plug, Search, SquareArrowOutUpRight, Terminal, TriangleAlert, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { CodeBlockCode } from "@/components/ui/code-block";
import { MessageContent } from "@/components/ui/message";
import { cn } from "@/lib/utils";
import { groupLabel } from "@/lib/chat-turns";
import { clearText, compactionText, modelText } from "@/lib/compaction-view";
import { activeAgents, inputBlocks, readableText, resultLanguage, runState, subagentLabel, summarize } from "@/lib/activity-rows";
import { toolDiff } from "@/lib/tool-diff";
import { ChoiceCard, askedQuestions } from "./cards";
import { Counts, ToolDiff } from "./tool-diff";

const PREVIEW_LINES = 3;
const TOOL_ICONS = [
  [/^(bash|shell|exec_command|run_terminal_cmd|terminal)/i, Terminal],
  [/^(read|view|cat|read_file)/i, FileText],
  [/(edit|write|patch|apply_patch|multiedit|notebookedit|delete_file)/i, Pencil],
  [/(grep|glob|search|find|ls|list)/i, Search],
  [/^web|fetch|browser/i, Globe],
  [/^mcp/i, Plug],
  [/^(task|agent|spawn_agent)/i, Bot],
  [/todo|plan/i, ListTodo],
];

const CODE = "font-mono [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:font-mono";
// Subagent runs the operator expanded, kept for the page's lifetime.
const expandedRuns = new Set();
const iconOf = tool => TOOL_ICONS.find(([pattern]) => pattern.test(tool || ""))?.[1] || Wrench;
const sizeOf = bytes => bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + " MB" : bytes >= 1024 ? Math.round(bytes / 1024) + " KB" : bytes + " B";

// Highlighted code once rendered; language is a fence name or file extension.
function Code({ code, language, className }) {
  return <CodeBlockCode code={code} language={language} className={cn(CODE, "text-xs [&>pre]:px-2.5 [&>pre]:py-1.5", className)}/>;
}

function Result({ item, input, header, summary }) {
  const [open, setOpen] = useState(false);
  const text = item.output || "";
  const lines = text.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const more = lines.length > PREVIEW_LINES || preview.length > 240;
  const error = item.type === "error";
  const language = error ? "" : resultLanguage(item.tool, input, text);
  return <div className={cn("min-w-0 rounded-lg border bg-muted/40 text-xs", error && "border-destructive/50 bg-destructive/10")}>
    {header && <ToolName tool={item.tool} error={error} summary={summary} className="border-b px-2.5 py-1.5"/>}
    {more ? <details className="group" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary aria-label={error ? "Error details" : "Tool result"} className="flex cursor-pointer list-none items-start gap-1.5 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90"/>
        <pre className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap font-mono [overflow-wrap:anywhere] group-open:hidden">{preview}</pre>
        <span className="hidden text-muted-foreground group-open:inline">{error ? "Error" : "Result"} · {lines.length} lines</span>
      </summary>
      {open && <Code code={text} language={language} className="max-h-96 overflow-auto border-t"/>}
    </details> : text ? <Code code={text} language={language}/> : <pre className="px-2.5 py-1.5 font-mono">(no output)</pre>}
    {item.attachment && <a href={"/api/file/" + item.attachment.file} target="_blank" rel="noreferrer"
      className="flex items-center gap-1.5 border-t px-2.5 py-1.5 font-medium text-primary underline-offset-2 hover:underline">
      <Paperclip className="size-3.5"/>Full output ({sizeOf(item.attachment.size)})
    </a>}
  </div>;
}

// One line: the tool name, then its summary (the command or path) truncated to the row width.
function ToolName({ tool, error, summary, className }) {
  const Icon = error ? TriangleAlert : iconOf(tool);
  return <div className={cn("flex min-w-0 items-center gap-2 text-sm", className)}>
    <Icon className={cn("size-4 shrink-0", error ? "text-destructive" : "text-muted-foreground")}/>
    <span className="shrink-0 font-medium">{tool}</span>
    {summary && <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>}
  </div>;
}

function ToolCall({ item }) {
  const [open, setOpen] = useState(false);
  // A file edit shows its diff: the files it changes in the summary, their diffs when open.
  const diff = useMemo(() => toolDiff(item.tool, item.input, item.result?.output), [item.tool, item.input, item.result?.output]);
  // An AskUserQuestion call shows its questions as a read-only card; a pending one is answered from its approval card.
  const questions = askedQuestions(item.tool, item.input);
  if (questions) return <div className="flex min-w-0 flex-col gap-1.5">
    <ChoiceCard questions={questions} title="AskUserQuestion"/>
    {item.result && <Result item={item.result} input={item.input}/>}
  </div>;
  const Icon = iconOf(item.tool);
  const summary = diff ? diff.files.map(file => file.path).join(", ") : summarize(item.input);
  const blocks = open && !diff ? inputBlocks(item.tool, item.input) : [];
  return <div className="flex min-w-0 flex-col gap-1.5">
    <details className="group min-w-0 rounded-lg border bg-card text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary aria-label={"Tool call " + (item.tool || "")} className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
        <Icon className="size-4 shrink-0 text-muted-foreground"/>
        <span className="shrink-0 font-medium">{item.tool || "tool"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>
        {diff && <Counts added={diff.files.reduce((sum, file) => sum + file.added, 0)} removed={diff.files.reduce((sum, file) => sum + file.removed, 0)} className="text-xs"/>}
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"/>
      </summary>
      {open && diff && <div className="max-h-96 overflow-auto border-t p-2">
        <ToolDiff files={diff.files} truncated={diff.truncated}/>
      </div>}
      {open && !diff && <div className="max-h-96 overflow-auto border-t">
        {blocks.length ? blocks.map((block, i) => <Code key={i} code={block.code} language={block.language} className={i > 0 && "border-t"}/>)
          : <pre className="px-2.5 py-1.5 font-mono text-xs">(no input)</pre>}
      </div>}
    </details>
    {item.result && <Result item={item.result} input={item.input}/>}
  </div>;
}

function Body({ item }) {
  switch (item.type) {
    case "prompt":
      return <MessageContent markdown className="bubble ml-auto max-w-[90%] rounded-2xl rounded-tr-md border border-primary/25 bg-primary/10 px-3 py-1.5 text-sm leading-relaxed text-foreground [overflow-wrap:anywhere]">{readableText(item.input).text}</MessageContent>;
    case "text":
      // Lighter than a chat bubble: the agent's own narration, not a message to the operator.
      return <MessageContent markdown className="bubble max-w-full rounded-2xl rounded-tl-md border border-dashed bg-muted/30 px-3 py-1.5 text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{readableText(item.output).text}</MessageContent>;
    case "tool_call":
      return <ToolCall item={item}/>;
    case "tool_result":
    case "error":
      // A result without its call names the tool and its command inside its own box.
      return <Result item={item} input={item.input} header={Boolean(item.tool)} summary={summarize(item.input)}/>;
    default: {
      const Icon = { start: CirclePlay, compact: Minimize2, clear: Eraser, model: Bot, limit: CircleAlert, handoff: ArrowRightLeft }[item.type] || CircleStop;
      const label = item.type === "clear" ? clearText(item.clear) : item.type === "model" && item.modelSwitch ? modelText(item.modelSwitch)
        : compactionText(item.compaction) || item.input || item.type;
      return <>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="size-3.5"/>{label}</p>
        {item.output && <MessageContent markdown className="bubble max-w-full rounded-2xl rounded-tl-md border border-dashed bg-muted/30 px-3 py-1.5 text-sm leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">{item.output}</MessageContent>}
      </>;
    }
  }
}

// One collapsed row per subagent run; tapping it shows the run's own rows, indented.
function SubagentRun({ row, when, now, goRun }) {
  const [open, setOpen] = useState(() => expandedRuns.has(row.id));
  const toggle = () => { if (open) expandedRuns.delete(row.id); else expandedRuns.add(row.id); setOpen(!open); };
  const state = runState(row, now);
  const label = "Subagent · " + subagentLabel(row, now) + (row.description ? " · " + row.description : "");
  return <div className="flex min-w-0 flex-col gap-2" data-run-state={state}>
    <div className="flex min-w-0 items-center gap-1.5">
      <button type="button" aria-expanded={open} onClick={toggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed bg-card px-2.5 py-1.5 text-left text-sm">
        {state === "running" ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground"/> : <Bot className="size-4 shrink-0 text-muted-foreground"/>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}/>
      </button>
      {goRun && <GoToAgent label={"Go to subagent " + (row.kind || "agent")} onClick={() => goRun(row)}/>}
    </div>
    {open && <div data-subagent={row.run} className="ml-3 flex min-w-0 flex-col gap-3 border-l pl-3">
      {row.rows.map(item => <ActivityRow key={item.id} row={item} when={when}/>)}
    </div>}
  </div>;
}

// One row per run of tool uses between two messages: "Ran …" when collapsed; the live run stays open until a message follows.
function ToolGroupRun({ row, when, now, goRun }) {
  const [manual, setManual] = useState(null);
  const open = manual ?? row.live;
  return <div className="flex min-w-0 flex-col gap-2">
    <button type="button" aria-expanded={open} onClick={() => setManual(!open)}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-dashed bg-card px-2.5 py-1.5 text-left text-sm">
      {row.live ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground"/> : <Wrench className="size-4 shrink-0 text-muted-foreground"/>}
      <span className="min-w-0 flex-1 truncate">{groupLabel(row)}</span>
      <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}/>
    </button>
    {open && <div data-group={row.id} className="ml-3 flex min-w-0 flex-col gap-3 border-l pl-3">
      {row.rows.map(item => <ActivityRow key={item.id} row={item} when={when} now={now} goRun={goRun}/>)}
    </div>}
  </div>;
}

/** Small "Go to agent" button used wherever an agent or subagent is referenced. */
export function GoToAgent({ label = "Go to agent", onClick, className }) {
  return <button type="button" aria-label={label} title={label} onClick={event => { event.stopPropagation(); onClick(); }}
    className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground", className)}>
    <SquareArrowOutUpRight className="size-3.5"/>
  </button>;
}

/** One activity row; goRun opens a subagent run. */
export function ActivityRow({ row, when, now, goRun }) {
  if (row.type === "subagent") return <article data-type="subagent" className="flex min-w-0 flex-col gap-1">
    <SubagentRun row={row} when={when} now={now} goRun={goRun}/>
  </article>;
  if (row.type === "group") return <article data-type="group" data-agent={row.agent} className="flex min-w-0 flex-col gap-1"><p className="font-mono text-xs text-muted-foreground">{row.agent}</p><ToolGroupRun row={row} when={when} now={now} goRun={goRun}/></article>;
  return <article data-type={row.type} data-agent={row.agent} className={cn("flex min-w-0 flex-col gap-1", row.type === "prompt" && "items-end")}>
    <div className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
      {row.type === "prompt" && <span className="font-medium text-foreground">Prompt</span>}
      {row.type === "text" && <span className="font-medium text-foreground">{readableText(row.output).label || row.tool || "Agent"}</span>}
      {row.type === "text" && row.agent && <span className="font-mono text-xs">{row.agent}</span>}
      {row.time > 0 && <time dateTime={new Date(row.time * 1000).toISOString()}>{when(row.time * 1000)}</time>}
    </div>
    <Body item={row}/>
  </article>;
}

/** "Working now" with each agent running: the session with an open tool call, and its running subagents. */
export function Working({ rows, now }) {
  const busy = activeAgents(rows, now);
  if (!busy.length) return null;
  return <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
    <LoaderCircle className="size-4 animate-spin"/>Working now:
    {busy.map(item => <span key={item.key} data-agent={item.agent} className="font-mono text-xs text-foreground">{item.kind ? item.kind + " subagent in " + item.agent : item.agent + " (session)"}</span>)}
  </p>;
}
