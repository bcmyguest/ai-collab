"use client";
import { Component, createContext, useContext, useMemo, useRef } from "react";
import { A2uiSurface } from "@a2ui/react/v0_9";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { aiCollabCatalog } from "@/lib/a2ui-catalog";
import { cn } from "@/lib/utils";
import { OptionPicker } from "./option-picker";
import { ButtonImpl, ChipImpl, TextFieldImpl } from "./controls";
import { ScriptImpl } from "./script";

// The card shell shared with the legacy cards in web/app/cards.jsx.
export const CARD = "w-full max-w-full rounded-2xl border bg-card px-3.5 py-3 text-sm text-card-foreground shadow-xs [overflow-wrap:anywhere]";
// A2UI theme variables mapped onto the app's tokens, so both themes follow the app's light and dark values.
const THEME = {
  "--a2ui-color-background": "var(--card)", "--a2ui-color-on-background": "var(--card-foreground)",
  "--a2ui-color-surface": "var(--card)", "--a2ui-color-on-surface": "var(--card-foreground)",
  "--a2ui-color-primary": "var(--primary)", "--a2ui-color-on-primary": "var(--primary-foreground)",
  "--a2ui-color-primary-hover": "var(--primary)",
  "--a2ui-color-secondary": "var(--muted)", "--a2ui-color-on-secondary": "var(--foreground)",
  "--a2ui-color-secondary-hover": "var(--accent)",
  "--a2ui-color-border": "var(--border)", "--a2ui-border": "1px solid var(--border)",
  "--a2ui-color-input": "var(--background)", "--a2ui-color-on-input": "var(--foreground)",
  "--a2ui-font-size": "0.875rem", "--a2ui-line-height-body": "1.45",
  "--a2ui-button-font-weight": "500", "--a2ui-button-border-radius": "var(--radius-md)",
};
const catalog = aiCollabCatalog([OptionPicker, ButtonImpl, TextFieldImpl, ChipImpl, ScriptImpl]);
// Surfaces by id from the AG-UI stream, and the submit that posts a surface action (null when signed out).
export const SurfaceContext = createContext({ surfaces: {}, submit: null, disabled: false });

// A render error in a surface shows the legacy card instead of breaking the chat.
class SurfaceBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error("A2UI surface failed; showing the card", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Builds the surface from its operations; a protocol error throws, so the boundary shows the card.
function Rendered({ id, operations, submit }) {
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const surface = useMemo(() => {
    const processor = new MessageProcessor([catalog], userAction => submitRef.current?.({ forwardedProps: { a2uiAction: { userAction } } }));
    const errors = processor.processMessagesWithErrors(operations);
    if (errors.length) throw new Error(errors[0].error.message);
    const built = processor.model.surfacesMap.get(id);
    if (!built) throw new Error("A2UI surface " + id + " was not created");
    return built;
  }, [id, operations]);
  return <A2uiSurface surface={surface}/>;
}

/**
 * The A2UI surface with this id in a card with a header row (head: the asking agent; kind: its label), or the fallback card
 * when the server sent none, the stream has no submit, or rendering fails. open lights the border while it waits for an answer.
 */
export function Surface({ id, fallback, head, kind, open = false }) {
  const { surfaces, submit, disabled } = useContext(SurfaceContext);
  const operations = surfaces[id];
  if (!operations || !submit) return fallback;
  // inert blocks taps and keys while the chat is busy or not connected, as the legacy card's disabled does.
  return <SurfaceBoundary fallback={fallback}>
    <section data-surface={id} inert={disabled || undefined} aria-disabled={disabled || undefined}
      className={cn(CARD, "flex flex-col gap-2.5", open && "border-primary/50", disabled && "opacity-60")} style={THEME}>
      {(head || kind) && <header className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2 font-medium text-foreground">{head}</div>
        {kind && <span className="shrink-0">{kind}</span>}
      </header>}
      <Rendered id={id} operations={operations} submit={submit}/>
    </section>
  </SurfaceBoundary>;
}
