"use client";
import { useState } from "react";
import { Check, CircleHelp, ShieldQuestion, SkipForward, SquareTerminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageContent } from "@/components/ui/message";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceList, ChoiceSummary } from "@/components/ui/choice-list";
import { Input } from "@ui-sdk/react/input";
import { cn } from "@/lib/utils";
import { BLOCKING_LABEL, IN_TERMINAL, SKIPPED, approvalOutcome, isBlocking, approvalSurfaceId, questionText, questionSurfaceId, terminalHint } from "@/lib/a2ui";
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
  function pick(i, next, multi) {
    setPicked(list => list.map((items, j) => j === i ? next : items));
    if (!multi) setOther(list => list.map((text, j) => j === i ? "" : text));
  }
  return <div className={cn(CARD, "flex flex-col gap-3")} data-card="choice">
    {title && <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CircleHelp className="size-3.5"/>{title}</p>}
    {questions.map((q, i) => {
      const chosen = String(answers?.[q.question] ?? "");
      const labels = chosen ? chosen.split(", ") : [];
      const typed = labels.some(label => !q.options.some(o => o.label === label));
      return <section key={q.question} className={cn("flex min-w-0 flex-col gap-2", i > 0 && "border-t pt-3")}>
        {(q.header || questions.length > 1) && <div className="flex min-w-0 items-center justify-between gap-2">
          {q.header && <Badge variant="secondary" className="min-h-5 max-w-full px-2 text-xs wrap-anywhere whitespace-normal">{q.header}</Badge>}
          {questions.length > 1 && <span className="text-xs text-muted-foreground">{i + 1} of {questions.length}</span>}
        </div>}
        {readOnly ? <>
          <ChoiceSummary question={q.question} chosen={labels.filter(label => q.options.some(o => o.label === label))}/>
          {typed && <p className="text-sm">Answer: <span className="font-medium">{chosen}</span></p>}
          {!answers && <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
            {q.options.map(o => <li key={o.label} className="wrap-anywhere"><span className="text-foreground">{o.label}</span>{o.description && " · " + o.description}</li>)}
          </ul>}
        </> : <ChoiceList question={q.question} options={q.options} multiSelect={q.multiSelect === true} value={picked[i]} disabled={disabled}
          onValueChange={next => pick(i, next, q.multiSelect === true)}>
          <label className="flex min-w-0 flex-col gap-1 pt-0.5">
            <span className="text-xs text-muted-foreground">Or write your own answer</span>
            <Input aria-label={"Other answer: " + q.question} placeholder="Other answer" value={other[i]} disabled={disabled}
              onValueChange={text => { setOther(list => list.map((v, j) => j === i ? text : v)); if (!q.multiSelect && text) setPicked(list => list.map((v, j) => j === i ? [] : v)); }}
              className="h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground sm:h-9 sm:text-sm"/>
          </label>
        </ChoiceList>}
      </section>;
    })}
    {!readOnly && <div className="flex justify-end">
      <Button className="h-11 rounded-md px-4 sm:h-8 sm:px-3.5" disabled={disabled || !complete}
        onClick={() => onSubmit(Object.fromEntries(questions.map((q, i) => [q.question, value(i)])))}>Submit</Button>
    </div>}
  </div>;
}

/** Dismisses an open decision without answering it; a waiting hook then leaves the harness's own prompt in charge. */
export function SkipButton({ disabled, onSkip }) {
  return <Button size="sm" variant="ghost" className="self-start rounded-md text-muted-foreground" disabled={disabled} onClick={onSkip}><SkipForward/>Skip</Button>;
}

/** A permission request or choice an agent waits on: the A2UI surface when the stream sent one, else the card below; Skip while open. */
export function ApprovalCard({ skip, ...props }) {
  const open = !approvalOutcome(props.approval, props.now);
  // A view-only card closes in the terminal, and a runner session has no terminal prompt to fall back on.
  const skippable = skip && open && !props.approval.terminal && !props.approval.owned;
  // A choice reads as a question; the chat message header above it already names the agent.
  const count = props.approval.questions?.length ?? 0;
  const kind = count > 1 ? count + " questions" : count ? "Question" : "Approval";
  return <>
    <Surface id={approvalSurfaceId(props.approval.id)} head={count ? undefined : props.head} kind={kind} open={open} fallback={<LegacyApprovalCard {...props}/>}/>
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
  return <div className={cn(CARD, "flex flex-col gap-2", open && "border-primary/50")} data-card="approval" data-terminal={terminal || undefined}>
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldQuestion className="size-3.5"/>{approval.harness} asks permission · {approval.tool}</p>
    {approval.summary && <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{approval.summary}</pre>}
    {open && terminal ? <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><SquareTerminal className="size-3.5 shrink-0"/>{IN_TERMINAL}<span className="font-normal text-muted-foreground">· {terminalHint(approval.mode)}</span></p>
      : open ? <div className="flex gap-2">
      <Button size="sm" className="rounded-md" disabled={disabled} onClick={() => act({ id: approval.id, decision: "allow" })}><Check/>Allow</Button>
      <Button size="sm" variant="outline" className="rounded-md" disabled={disabled} onClick={() => act({ id: approval.id, decision: "deny" })}><X/>Deny</Button>
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
  return <div className={cn(CARD, "flex flex-col gap-2", !answer && !skipped && "border-primary/50")} data-card="question">
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><CircleHelp className="size-3.5"/>Question</p>
    {!answer && !skipped && isBlocking(body) && <Badge variant="secondary" className="h-5 border-primary/40 bg-primary/10 px-2 text-xs font-medium text-primary">{BLOCKING_LABEL}</Badge>}
    <MessageContent markdown taskLinks={taskLinks} className="bubble max-w-full bg-transparent p-0 text-base leading-relaxed">{typeof body === "string" ? questionText(body) : body}</MessageContent>
    {answer ? <p className="text-xs text-muted-foreground">Answered: <span className="font-medium text-foreground">{answer}</span>{by && " · " + by}</p>
      : skipped ? <p className="text-xs text-muted-foreground" data-outcome="skipped">{SKIPPED}</p>
      : <div className="flex flex-col gap-2">
        <Textarea aria-label="Answer" placeholder="Your answer…" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} className="min-h-9 text-sm"/>
        <Button size="sm" className="self-start rounded-md" disabled={disabled || !draft.trim()} onClick={async () => { if (await onAnswer(draft.trim())) setDraft(""); }}>Submit</Button>
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
