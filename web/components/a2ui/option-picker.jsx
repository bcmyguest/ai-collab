"use client";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { Check } from "lucide-react";
import { OptionPickerApi } from "@/lib/a2ui-catalog";
import { cn } from "@/lib/utils";

/** Options with descriptions: radio buttons, or checkboxes when multiSelect; read-only once the request closed. */
export const OptionPicker = createComponentImplementation(OptionPickerApi, ({ props }) => {
  const picked = props.value ?? [];
  const readOnly = props.readOnly === true;
  const multi = props.multiSelect === true;
  // Picking an option clears a typed Other answer in single-select, as the chat card does.
  function choose(label) {
    const next = multi ? (picked.includes(label) ? picked.filter(item => item !== label) : [...picked, label]) : [label];
    props.setValue?.(next);
    if (!multi) props.setOther?.("");
  }
  return <div role={multi ? "group" : "radiogroup"} className="flex flex-col gap-2">
    {props.options.map(option => {
      const on = picked.includes(option.label);
      return <button key={option.label} type="button" role={multi ? "checkbox" : "radio"} aria-checked={on} disabled={readOnly}
        onClick={() => choose(option.label)}
        className={cn("flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left transition-colors enabled:hover:bg-accent disabled:cursor-default",
          on && "border-primary bg-primary/10")}>
        <span className="flex items-center gap-2 font-medium">
          <span aria-hidden className={cn("grid size-4 shrink-0 place-items-center border", multi ? "rounded" : "rounded-full", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="size-3"/>}</span>
          {option.label}
        </span>
        {option.description && <span className="pl-6 text-xs text-muted-foreground">{option.description}</span>}
        {option.preview && <pre className="ml-6 max-h-48 overflow-auto rounded-lg border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{option.preview}</pre>}
      </button>;
    })}
  </div>;
});
