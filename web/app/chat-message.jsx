"use client";
// One chat message bubble and its header row (receipts, reply, badges), plus the project chat's
// completion and live rows that ride the same thread.
import { useMemo, useState } from "react";
import { MessagePrimitive } from "@assistant-ui/react";
import { Check, CheckCheck, CircleCheck, LoaderCircle, Reply, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BubbleContext, BubbleText } from "@/components/chat/thread";
import { Button } from "@/components/ui/button";
import { remarkPluginsFor } from "@/components/ui/markdown";
import { cn } from "@/lib/utils";
import { withMentions } from "@/lib/mentions";
import { ChatImage } from "./chat-image";
import { ApprovalCard, QuestionCard } from "./cards";
import { Quote } from "./quote";
import { Avatar, ago, clock, short } from "./chat-shared";

const RECEIPTS = { sent: ["Sent", Check], delivered: ["Read by some sessions", CheckCheck], read: ["Read", CheckCheck] };

// WhatsApp-style ticks on the operator's own messages: ✓ sent, ✓✓ read by some (broadcast), primary ✓✓ read.
function Ticks({ state }) {
  const [label, Icon] = RECEIPTS[state] || [];
  if (!Icon) return null;
  return <span role="img" aria-label={label} title={label} data-receipt={state}
    className={cn("inline-flex", state === "read" ? "text-primary" : "text-muted-foreground")}><Icon className="size-3.5"/></span>;
}

export function QueueRow({ message, disabled, change }) {
  const [draft, setDraft] = useState(null);
  return <li className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-sm">
    {draft === null ? <>
      <div className="min-w-0 flex-1">
        {message.body && <p className="truncate" title={message.body}>{message.body}</p>}
        {message.attachment && <ChatImage attachment={message.attachment} compact/>}
      </div>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setDraft(message.body)}>Edit</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => change(message, "cancel")}>Cancel</Button>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => change(message, "steer")}>Retry delivery</Button>
    </> : <form className="flex w-full flex-wrap items-center gap-2" onSubmit={async event => {
      event.preventDefault();
      if (await change(message, "edit", draft)) setDraft(null);
    }}>
      <textarea aria-label="Edit queued message" className="w-full rounded border bg-background p-2" autoFocus value={draft} maxLength={4000} onChange={event => setDraft(event.target.value)}/>
      <Button type="submit" size="sm" disabled={disabled || !draft.trim()}>Save</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>Discard edit</Button>
    </form>}
  </li>;
}

export function ChatMessage({ message, operator, me, now, replyFrom, open, act, answer, skip, disabled, detail, name, taskLinks }) {
  const bubble = useMemo(() => ({ plugins: remarkPluginsFor(taskLinks) }), [taskLinks]);
  const sender = message.from || message.sender || "ntfy";
  const outgoing = sender === operator;
  // Channel posts (operator broadcasts, phone replies) travel as "ntfy" on the wire; readers see them as the operator's.
  const shown = sender === "ntfy" ? "operator" : sender;
  // A signed-in family member's message names them; the viewer's own stays "You".
  const other = message.by && message.by !== me ? message.by : "";
  const who = message.by || name || short(shown);
  const label = message.system ? "System" : ["Question", "Reply", "Approval"].includes(message.kind) ? message.kind + " · " + who : who;
  const at = message.time ? message.time * 1000 : 0;
  // An agent's avatar and name open its session (or harness) view; the operator's own, system and channel posts stay plain.
  const openable = !outgoing && sender !== "ntfy" && sender !== "operator" && sender !== "system";
  const go = () => open(sender);
  // A reply to an agent prefills its address so the mention routes the reply to that session.
  const prefill = openable ? "@" + sender + " " : "";
  // The asking agent's avatar and name, the header row of an approval card; a question card leaves them to the message header.
  const cardHead = <><Avatar address={sender} by={other} className="size-6 text-xs"/><span className="truncate" title={sender}>{name || short(sender)}</span></>;
  // Cards take the whole row on a phone, so long option descriptions wrap less.
  const card = message.kind === "Approval" || (message.kind === "Question" && Boolean(message.question));
  return <MessagePrimitive.Root data-message-id={message.id} data-reply-id={message.replyId} className={cn("flex max-w-full gap-3", outgoing && "flex-row-reverse")}
    onClick={event => { const tag = event.target.closest?.("[data-mention]"); if (tag) open(tag.textContent.replace(/^@/, "").split(/[:/]/)[0]); }}>
    {openable ? <button type="button" aria-label={"Open avatar " + sender} tabIndex={-1} className="shrink-0 self-start rounded-md" onClick={go}><Avatar address={sender}/></button> : <Avatar address={shown} by={other}/>}
    <div className={cn("flex min-w-0 flex-col gap-1", card ? "flex-1 sm:max-w-[82%]" : "max-w-[82%]", outgoing ? "items-end" : "items-start")}>
      <div className="flex max-w-full flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        {openable ? <button type="button" aria-label={"Open " + sender} title={sender} onClick={go}
          className="font-medium text-foreground underline-offset-2 hover:underline">{label}</button>
          : <span className="font-medium text-foreground" title={message.by ? shown + " · " + message.by : shown}>{outgoing ? other || "You" : label}</span>}
        {detail && <span data-agent-detail className="text-xs text-muted-foreground">{"· " + detail}</span>}
        {message.to && message.to !== "all" && <span title={message.to}>→ {short(message.to)}</span>}
        {message.terminal && <Badge variant="outline" data-terminal title="Typed in the agent's terminal" className="h-4 px-1.5 text-xs">terminal</Badge>}
        {message.replyTo && <Badge variant="outline" data-answer title={"Answers question " + message.replyTo} className="h-4 px-1.5 text-xs">answer</Badge>}
        {at > 0 && <time dateTime={new Date(at).toISOString()} title={clock.format(at)}>{ago(at, now)}</time>}
        {replyFrom && message.kind !== "Approval" && message.kind !== "Question" && <button type="button" data-tap aria-label={"Reply to " + sender} title="Reply" onClick={() => replyFrom({ id: message.replyId || message.id, sender, prefill, body: message.body })}
          className="rounded-md p-0.5 hover:bg-muted hover:text-foreground"><Reply className="size-3.5"/></button>}
        {message.scope === "all" && <Badge variant="secondary" className="h-4 px-1.5 text-xs">to all</Badge>}
        {message.urgent && !message.cancelled && <span role="img" aria-label="Sent now" title="Sent now: delivered at the agent's next tool call" data-urgent className="text-primary"><Zap className="size-3.5"/></span>}
        {outgoing && (message.queueStatus ? <span>{message.queueStatus}</span> : <Ticks state={message.receipt}/>)}
      </div>
      {message.quote && <Quote quote={message.quote} label={short(message.quote.sender)}/>}
      {message.kind === "Approval" ? <ApprovalCard approval={message.approval} now={now} disabled={disabled} act={act} skip={skip} head={cardHead}/>
        : message.kind === "Question" && message.question ? <QuestionCard question={message.question} body={withMentions(message.body)} taskLinks={taskLinks} answer={message.answer} by={message.answeredBy} skipped={message.skipped} disabled={disabled} onAnswer={body => answer(message.question, body)} skip={skip}/>
        : (message.body || !message.attachment) && <BubbleContext.Provider value={bubble}>
          <div className={cn("bubble max-w-full rounded-2xl px-3.5 py-2 text-base leading-relaxed shadow-xs [overflow-wrap:anywhere]",
        outgoing ? "rounded-tr-md border border-primary/25 bg-primary/10 text-foreground" : "rounded-tl-md bg-card shadow-surface text-card-foreground",
        message.kind === "Question" && "border-primary/50")}><MessagePrimitive.Content components={{ Text: BubbleText }}/></div>
        </BubbleContext.Provider>}
      {message.attachment && <ChatImage attachment={message.attachment}/>}
    </div>
  </MessagePrimitive.Root>;
}

// A session's finished turn(s) in the project chat: the first line of the final reply; tap opens the session.
export function CompletionRow({ row, when, open }) {
  return <button type="button" data-type="completion" onClick={() => open(row.agent)} title={row.agent}
    className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent">
    <CircleCheck className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400"/>
    <span className="min-w-0 flex-1 truncate"><span className="font-mono text-foreground">{short(row.agent)}</span>{row.seat && " · " + row.seat} finished{row.turns > 1 ? " " + row.turns + " turns" : ""}{row.text && " · " + row.text}</span>
    {row.time > 0 && <time className="shrink-0 text-xs" dateTime={new Date(row.time * 1000).toISOString()}>{when(row.time * 1000)}</time>}
  </button>;
}

// A busy session in the project chat: its current turn's summary; tap opens the session.
export function LiveRow({ row, open }) {
  return <button type="button" data-type="live" onClick={() => open(row.agent)} title={row.agent}
    className="flex min-w-0 items-center gap-2 rounded-xl border border-dashed bg-card px-2.5 py-1.5 text-left text-sm">
    <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground"/>
    <span className="min-w-0 flex-1 truncate"><span className="font-mono">{short(row.agent)}</span>{row.seat && " · " + row.seat} · working{row.summary && " on " + row.summary}</span>
  </button>;
}
