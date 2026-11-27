"use client";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChipApi } from "@/lib/a2ui-catalog";
import { cn } from "@/lib/utils";

// Button, TextField and Chip render with the app's components; the schemas stay the basic catalog's, so answers and checks are unchanged.
const VARIANT = { primary: "default", default: "outline", borderless: "ghost" };
// The child Text paints with the surface color; inside a button it takes the button's foreground.
const ON_BUTTON = { "--a2ui-color-on-surface": "currentColor", "--a2ui-color-on-background": "currentColor" };

/** A button: primary, outlined or ghost; disabled while its checks fail. */
export const ButtonImpl = createComponentImplementation(basicCatalog.components.get("Button"), ({ props, buildChild }) => {
  const disabled = props.isValid === false;
  return <Button type="button" size="sm" variant={VARIANT[props.variant ?? "default"]} disabled={disabled} onClick={() => props.action?.()}
    style={ON_BUTTON} className="h-8 rounded-md px-3.5 disabled:opacity-50 [&_*]:text-inherit">
    {props.child && buildChild(props.child)}
  </Button>;
});

/** A single-line text field; its label is the placeholder, as the Other row shows it. */
export const TextFieldImpl = createComponentImplementation(basicCatalog.components.get("TextField"), ({ props }) => {
  return <input type="text" aria-label={props.label || "Answer"} placeholder={props.label} value={props.value ?? ""}
    onChange={event => props.setValue?.(event.target.value)}
    className={cn("h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground",
      "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring")}/>;
});

/** A short tag: a question's header, or a status. */
export const ChipImpl = createComponentImplementation(ChipApi, ({ props }) => {
  return <Badge variant={props.tone === "muted" ? "outline" : "secondary"} className="h-5 max-w-full px-2 text-xs font-medium text-muted-foreground">{props.text}</Badge>;
});
