"use client";
import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Checkbox, CheckboxGroup, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Radio, RadioGroup, RadioIndicator } from "@ui-sdk/react/radio";
import { cn } from "@/lib/utils";

export type ChoiceOption = { label: string; description?: string; preview?: string };

// The whole row is the radio or checkbox; the inset shadow thickens the selected border without moving the content.
const ROW = cn("group flex min-h-11 w-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors",
  "hover:bg-accent data-[checked]:border-primary data-[checked]:bg-primary/8 data-[checked]:shadow-[inset_0_0_0_1px_var(--primary)] data-[checked]:hover:bg-primary/12",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-60 data-[disabled]:hover:bg-transparent");
const MARK = "mt-0.5 grid size-4 shrink-0 place-items-center border border-muted-foreground/70 bg-background group-data-[checked]:border-primary group-data-[checked]:bg-primary";

function Body({ id, option }: { id: string; option: ChoiceOption }) {
  return <span className="flex min-w-0 flex-1 flex-col gap-0.5">
    <span id={id + "-label"} className="text-sm leading-snug font-medium wrap-anywhere text-foreground">{option.label}</span>
    {option.description && <span id={id + "-description"} className="text-sm leading-snug wrap-anywhere text-muted-foreground">{option.description}</span>}
    {option.preview && <span className="mt-1 block max-h-32 overflow-auto rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-foreground">{option.preview}</span>}
  </span>;
}

/** A question and its options as full-row radios, or checkboxes when multiSelect; the group is named by the question. */
export function ChoiceList({ question, options, multiSelect = false, value, onValueChange, disabled = false, children }: {
  question?: ReactNode; options: ChoiceOption[]; multiSelect?: boolean; value: string[];
  onValueChange: (value: string[]) => void; disabled?: boolean; children?: ReactNode;
}) {
  const id = useId();
  const named = (index: number, option: ChoiceOption) => ({
    "aria-labelledby": `${id}-${index}-label`,
    ...(option.description ? { "aria-describedby": `${id}-${index}-description` } : {}),
  });
  return <div className="flex min-w-0 flex-col gap-2.5">
    <div className="flex min-w-0 flex-col gap-0.5">
      {question && <p id={id + "-question"} className="text-[0.9375rem] leading-snug font-semibold wrap-anywhere text-foreground">{question}</p>}
      <p id={id + "-hint"} className="text-xs text-muted-foreground">{multiSelect ? "Pick any" : "Pick one"}</p>
    </div>
    {multiSelect
      ? <CheckboxGroup value={value} onValueChange={next => onValueChange(next)} disabled={disabled}
        aria-labelledby={id + "-question"} aria-describedby={id + "-hint"} className="flex flex-col gap-1.5">
        {options.map((option, index) => <Checkbox key={option.label} value={option.label} className={ROW} {...named(index, option)}>
          <span aria-hidden className={cn(MARK, "rounded-[3px]")}>
            <CheckboxIndicator className="text-primary-foreground"><Check className="size-3" strokeWidth={3}/></CheckboxIndicator>
          </span>
          <Body id={`${id}-${index}`} option={option}/>
        </Checkbox>)}
      </CheckboxGroup>
      : <RadioGroup value={value[0] ?? null} onValueChange={next => onValueChange(next ? [next] : [])} disabled={disabled}
        aria-labelledby={id + "-question"} aria-describedby={id + "-hint"} className="flex flex-col gap-1.5">
        {options.map((option, index) => <Radio key={option.label} value={option.label} className={ROW} {...named(index, option)}>
          <span aria-hidden className={cn(MARK, "rounded-full")}>
            <RadioIndicator className="size-1.5 rounded-full bg-primary-foreground"/>
          </span>
          <Body id={`${id}-${index}`} option={option}/>
        </Radio>)}
      </RadioGroup>}
    {children}
  </div>;
}

/** A closed question: the question, then the chosen answers with a check. */
export function ChoiceSummary({ question, chosen }: { question?: ReactNode; chosen: string[] }) {
  return <div className="flex min-w-0 flex-col gap-1">
    {question && <p className="text-sm leading-snug wrap-anywhere text-muted-foreground">{question}</p>}
    {chosen.length > 0 && <ul className="flex min-w-0 flex-col gap-0.5">
      {chosen.map(label => <li key={label} className="flex min-w-0 items-start gap-1.5 text-sm font-medium text-foreground">
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-primary"/><span className="min-w-0 wrap-anywhere">{label}</span>
      </li>)}
    </ul>}
  </div>;
}
