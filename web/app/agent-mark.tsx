"use client";
// Agent identity: a monochrome harness glyph and a short name; the raw address shows on hover or a long press.
import { useRef, useState, type ReactNode } from "react";
import { HarnessLogo, hasLogo } from "./logos";
import { HARNESS_NAMES, peerOf, short } from "./chat-shared";
import { cn } from "@/lib/utils";

const LONG_PRESS_MS = 450;
const REVEAL_MS = 2500;

/** The harness glyph in a small square; a peer without a logo shows its first letter. */
export function HarnessMark({ peer, className }: { peer: string; className?: string }) {
  const name = (HARNESS_NAMES as Record<string, string>)[peer] || peer;
  return <span data-harness={peer} title={name} className={cn("inline-grid size-4 shrink-0 place-items-center text-muted-foreground", className)}>
    {hasLogo(peer) ? <HarnessLogo peer={peer} className="size-3.5"/> : <span aria-label={name} className="font-mono text-xs leading-none">{peer.slice(0, 1).toUpperCase()}</span>}
  </span>;
}

/**
 * A session as glyph plus name. The raw address is the title on hover; a long press on touch swaps the name for it
 * for a moment, since a phone has no hover.
 */
export function AgentName({ address, name, className, children }: { address: string; name?: string; className?: string; children?: ReactNode }) {
  const [reveal, setReveal] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const raw = short(address) || address;
  const shown = name || raw;
  function press(event: React.PointerEvent) {
    if (event.pointerType !== "touch") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setReveal(true);
      timer.current = setTimeout(() => setReveal(false), REVEAL_MS);
    }, LONG_PRESS_MS);
  }
  const cancel = () => { if (!reveal) clearTimeout(timer.current); };
  return <span data-agent={address} title={address} onPointerDown={press} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
    <HarnessMark peer={peerOf(address)}/>
    <span className={cn("min-w-0 truncate", reveal && "font-mono text-xs")}>{reveal ? raw : shown}</span>
    {children}
  </span>;
}
