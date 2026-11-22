"use client";
import { Component, createContext, useContext, useMemo, useRef } from "react";
import { A2uiSurface } from "@a2ui/react/v0_9";
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { aiCollabCatalog } from "@/lib/a2ui-catalog";
import { cn } from "@/lib/utils";
import { OptionPicker } from "./option-picker";

const catalog = aiCollabCatalog([OptionPicker]);
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

/** The A2UI surface with this id, or the fallback card when the server sent none, the stream has no submit, or rendering fails. */
export function Surface({ id, fallback }) {
  const { surfaces, submit, disabled } = useContext(SurfaceContext);
  const operations = surfaces[id];
  if (!operations || !submit) return fallback;
  // inert blocks taps and keys while the chat is busy or not connected, as the legacy card's disabled does.
  return <SurfaceBoundary fallback={fallback}>
    <div data-surface={id} inert={disabled || undefined} aria-disabled={disabled || undefined} className={cn("w-full min-w-0", disabled && "opacity-60")}>
      <Rendered id={id} operations={operations} submit={submit}/>
    </div>
  </SurfaceBoundary>;
}
