"use client";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { Check } from "lucide-react";
import { OptionPickerApi } from "@/lib/a2ui-catalog";
import { cn } from "@/lib/utils";

/** Options as compact rows: radio buttons, or checkboxes when multiSelect, then the Other field; read-only once the request closed. */
export const OptionPicker = createComponentImplementation(OptionPickerApi, ({ props, buildChild }) => {
  const picked = props.value ?? [];
  const readOnly = props.readOnly === true;
  const multi = props.multiSelect === true;
  // Picking an option clears a typed Other answer in single-select, as the chat card does.
  function choose(label) {
    const next = multi ? (picked.includes(label) ? picked.filter(item => item !== label) : [...picked, label]) : [label];
    props.setValue?.(next);
    if (!multi) props.setOther?.("");
  }
  // Closed: only the chosen labels, as a compact summary; a typed Other answer shows as its own line.
  if (readOnly) return <div role="list" className="flex flex-wrap gap-1.5">
    {props.options.filter(option => picked.includes(option.label)).map(option =>
      <span key={option.label} role="listitem" className="inline-flex h-6 items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 text-xs font-medium">
        <Check aria-hidden className="size-3 text-primary"/>{option.label}
      </span>)}
  </div>;
  return <div role={multi ? "group" : "radiogroup"} className="flex flex-col gap-1.5">
    {props.options.map(option => {
      const on = picked.includes(option.label);
      return <button key={option.label} type="button" role={multi ? "checkbox" : "radio"} aria-checked={on} disabled={readOnly}
        onClick={() => choose(option.label)}
        className={cn("flex w-full min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default",
          on ? "border-primary bg-primary/10" : "border-border")}>
        <span className="flex min-h-7 min-w-0 items-center gap-2.5">
          <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center border", multi ? "rounded-[4px]" : "rounded-full", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60")}>{on && <Check className="size-3"/>}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{option.label}</span>
            {option.description && <span className="truncate text-xs text-muted-foreground">{option.description}</span>}
          </span>
        </span>
        {option.preview && <pre className="ml-6.5 max-h-32 overflow-auto rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs whitespace-pre-wrap">{option.preview}</pre>}
      </button>;
    })}
    {props.otherChild && !readOnly && <div className="flex min-h-11 items-center">{buildChild(props.otherChild)}</div>}
  </div>;
});
