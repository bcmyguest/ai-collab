"use client";
import { useState } from "react";
import { Check, CircleHelp, ShieldQuestion, SkipForward, SquareTerminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageContent } from "@/components/ui/message";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { IN_TERMINAL, SKIPPED, approvalOutcome, approvalSurfaceId, questionSurfaceId, terminalHint } from "@/lib/a2ui";
import { CARD, Surface } from "@/components/a2ui/surface";
import { ConfirmButton } from "./pattern-graph";

export { approvalOutcome };

/** AskUserQuestion questions: options as buttons (checkboxes when multiSelect), an Other field, one Submit; read-only without onSubmit. */
export function ChoiceCard({ questions, answers, onSubmit, disabled, title }) {
  const [picked, setPicked] = useState(() => questions.map(() => []));
  const [other, setOther] = useState(() => questions.map(() => ""));
  const readOnly = !onSubmit || Boolean(answers);
  const value = i => [...picked[i], ...(other[i].trim() ? [other[i].trim()] : [])].join(", ");
  const complete = questions.every((_, i) => value(i));
  function toggle(i, label, multi) {
    setPicked(list => list.map((items, j) => j !== i ? items : multi ? (items.includes(label) ? items.filter(x => x !== label) : [...items, label]) : [label]));
    if (!multi) setOther(list => list.map((text, j) => j === i ? "" : text));
  }
  return <div className={cn(CARD, "flex flex-col gap-3")} data-card="choice">
    {title && <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CircleHelp className="size-3.5"/>{title}</p>}
    {questions.map((q, i) => {
      const chosen = answers?.[q.question];
      return <fieldset key={i} className="flex min-w-0 flex-col gap-2">
        <legend className="flex max-w-full flex-wrap items-center gap-2 pb-1 wrap-anywhere">
          {q.header && <Badge variant="secondary" className="min-h-5 max-w-full px-2 text-[11px] wrap-anywhere whitespace-normal">{q.header}</Badge>}
          <span className="font-medium">{q.question}</span>
          {q.multiSelect && <span className="text-xs text-muted-foreground">pick any</span>}
        </legend>
        {q.options.map(option => {
          const on = readOnly ? String(chosen || "").split(", ").includes(option.label) : picked[i].includes(option.label);
          return <button key={option.label} type="button" role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={readOnly || disabled}
            onClick={() => toggle(i, option.label, q.multiSelect)}
            className={cn("flex min-h-11 w-full min-w-0 flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default",
              on && "border-primary bg-primary/10")}>
            <span className="flex min-w-0 items-start gap-2 font-medium">
              <span aria-hidden className={cn("mt-0.5 grid size-4 shrink-0 place-items-center border", q.multiSelect ? "rounded" : "rounded-full", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="size-3"/>}</span>
              <span className="min-w-0 wrap-anywhere">{option.label}</span>
            </span>
            {option.description && <span className="min-w-0 pl-6 text-sm wrap-anywhere text-muted-foreground">{option.description}</span>}
            {option.preview && <pre className="ml-6 max-h-48 overflow-auto wrap-anywhere rounded-lg border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{option.preview}</pre>}
          </button>;
        })}
        {!readOnly && <Textarea aria-label={"Other answer: " + q.question} placeholder="Other…" value={other[i]} disabled={disabled}
          onChange={event => { const text = event.target.value; setOther(list => list.map((v, j) => j === i ? text : v)); if (!q.multiSelect && text) setPicked(list => list.map((v, j) => j === i ? [] : v)); }}
          className="min-h-9 text-sm"/>}
        {readOnly && chosen && !q.options.some(o => String(chosen).split(", ").includes(o.label)) && <p className="text-xs">Answer: <span className="font-medium">{chosen}</span></p>}
      </fieldset>;
    })}
    {!readOnly && <Button size="sm" className="self-start rounded-full" disabled={disabled || !complete}
      onClick={() => onSubmit(Object.fromEntries(questions.map((q, i) => [q.question, value(i)])))}>Submit</Button>}
  </div>;
}

/** Dismisses an open decision without answering it; a waiting hook then leaves the harness's own prompt in charge. */
export function SkipButton({ disabled, onSkip }) {
  return <Button size="sm" variant="ghost" className="self-start rounded-full text-muted-foreground" disabled={disabled} onClick={onSkip}><SkipForward/>Skip</Button>;
}

/** A permission request or choice an agent waits on: the A2UI surface when the stream sent one, else the card below; Skip while open. */
export function ApprovalCard({ skip, ...props }) {
  const open = !approvalOutcome(props.approval, props.now);
  // A view-only card closes in the terminal, and a runner session has no terminal prompt to fall back on.
  const skippable = skip && open && !props.approval.terminal && !props.approval.owned;
  return <>
    <Surface id={approvalSurfaceId(props.approval.id)} head={props.head} kind="Approval" open={open} fallback={<LegacyApprovalCard {...props}/>}/>
    {skippable && <SkipButton disabled={props.disabled} onSkip={() => skip({ id: props.approval.id })}/>}
  </>;
}

/** A permission request or choice an agent waits on: Allow / Deny (or the choice card) until it closes, then the outcome. */
export function LegacyApprovalCard({ approval, now, disabled, act }) {
  const outcome = approvalOutcome(approval, now);
  const open = !outcome;
  // No answer buttons: the hook published this card while AFK was off, so the terminal prompt answers it.
  // The hint follows the live mode, so the card never claims AFK is off after the operator turned it back on.
  const terminal = approval.terminal === true;
  if (approval.questions) {
    return <div className="flex w-full flex-col gap-1.5" data-terminal={terminal || undefined}>
      <ChoiceCard questions={approval.questions} answers={approval.answers} disabled={disabled || !open || terminal}
        title={approval.harness + " asks · " + (!open ? "closed" : terminal ? IN_TERMINAL : "answer to continue")}
        onSubmit={open && !terminal ? answers => act({ id: approval.id, answers }) : undefined}/>
      {outcome && <p className="text-xs text-muted-foreground" data-outcome={approval.state}>{outcome}{approval.by && " · " + approval.by}</p>}
    </div>;
  }
  return <div className={cn(CARD, "flex flex-col gap-2", open && "border-amber-500/50")} data-card="approval" data-terminal={terminal || undefined}>
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldQuestion className="size-3.5"/>{approval.harness} asks permission · {approval.tool}</p>
    {approval.summary && <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{approval.summary}</pre>}
    {open && terminal ? <p className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400"><SquareTerminal className="size-3.5 shrink-0"/>{IN_TERMINAL}<span className="font-normal text-muted-foreground">· {terminalHint(approval.mode)}</span></p>
      : open ? <div className="flex gap-2">
      <Button size="sm" className="rounded-full" disabled={disabled} onClick={() => act({ id: approval.id, decision: "allow" })}><Check/>Allow</Button>
      <Button size="sm" variant="outline" className="rounded-full" disabled={disabled} onClick={() => act({ id: approval.id, decision: "deny" })}><X/>Deny</Button>
    </div> : <p className="text-xs text-muted-foreground" data-outcome={approval.state}>{outcome}{approval.by && " · " + approval.by}</p>}
  </div>;
}

/** An ask_question post: the A2UI surface when the stream sent one, else the card below; Skip while open. */
export function QuestionCard({ skip, ...props }) {
  const open = !props.answer && !props.skipped;
  return <>
    <Surface id={questionSurfaceId(props.question)} head={props.head} kind="Question" open={open} fallback={<LegacyQuestionCard {...props}/>}/>
    {skip && open && <SkipButton disabled={props.disabled} onSkip={() => skip({ id: props.question })}/>}
  </>;
}

/** An ask_question post: the question, then its answer, Skipped, or an answer field. */
export function LegacyQuestionCard({ body, answer, by, skipped, disabled, onAnswer, taskLinks }) {
  const [draft, setDraft] = useState("");
  return <div className={cn(CARD, "flex flex-col gap-2", !answer && !skipped && "border-amber-500/50")} data-card="question">
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CircleHelp className="size-3.5"/>Question</p>
    <MessageContent markdown taskLinks={taskLinks} className="bubble max-w-full bg-transparent p-0 text-[15px] leading-relaxed">{body}</MessageContent>
    {answer ? <p className="text-xs text-muted-foreground">Answered: <span className="font-medium text-foreground">{answer}</span>{by && " · " + by}</p>
      : skipped ? <p className="text-xs text-muted-foreground" data-outcome="skipped">{SKIPPED}</p>
      : <div className="flex flex-col gap-2">
        <Textarea aria-label="Answer" placeholder="Your answer…" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} className="min-h-9 text-sm"/>
        <Button size="sm" className="self-start rounded-full" disabled={disabled || !draft.trim()} onClick={async () => { if (await onAnswer(draft.trim())) setDraft(""); }}>Submit</Button>
      </div>}
  </div>;
}

/** AskUserQuestion questions from a tool call's JSON input, or null. */
export function askedQuestions(tool, input) {
  if (tool !== "AskUserQuestion" || !input) return null;
  try {
    const questions = JSON.parse(input).questions;
    return Array.isArray(questions) && questions.every(q => typeof q?.question === "string" && Array.isArray(q.options) && q.options.every(o => typeof o?.label === "string")) ? questions : null;
  } catch {
    return null;
  }
}

export function SuspensionCard({ suspension, disabled, resume }) {
  return <div className="flex min-w-0 flex-col items-start gap-2 rounded-xl border p-3">
    <p role="alert" className="text-xs">{suspension.reason}. Waiting for operator confirmation.</p>
    <ConfirmButton label="Resume handoff" confirmLabel="Resume"
      question={`Allow ${suspension.from} → ${suspension.to} on "${suspension.on}" to exceed the limit?`}
      disabled={disabled} onConfirm={resume}/>
  </div>;
}
