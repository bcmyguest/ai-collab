"use client";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { ChoiceList, ChoiceSummary } from "@/components/ui/choice-list";
import { OptionPickerApi } from "@/lib/a2ui-catalog";

/** The question and its options as full-row radios, or checkboxes when multiSelect, then the Other field; a summary once closed. */
export const OptionPicker = createComponentImplementation(OptionPickerApi, ({ props, buildChild }) => {
  const picked = props.value ?? [];
  if (props.readOnly === true) {
    return <ChoiceSummary question={props.label} chosen={props.options.filter(option => picked.includes(option.label)).map(option => option.label)}/>;
  }
  // Picking an option clears a typed Other answer in single-select, as the chat card does.
  function choose(next) {
    props.setValue?.(next);
    if (props.multiSelect !== true) props.setOther?.("");
  }
  return <ChoiceList question={props.label} options={props.options} multiSelect={props.multiSelect === true} value={picked} onValueChange={choose}>
    {props.otherChild && <label className="flex min-w-0 flex-col gap-1 pt-0.5">
      <span className="text-xs text-muted-foreground">Or write your own answer</span>
      {buildChild(props.otherChild)}
    </label>}
  </ChoiceList>;
});
