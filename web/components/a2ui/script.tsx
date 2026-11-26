"use client";
import { createComponentImplementation } from "@a2ui/react/v0_9";
import { useEffect, useRef, useState } from "react";
import { ScriptApi } from "@/lib/a2ui-run-catalog";
import { cn } from "@/lib/utils";

type Check = "checking" | "match" | "differs" | "unavailable";

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const CHECK_TEXT: Record<Check, string> = {
  checking: "Hashing what is shown…",
  match: "matches the bytes shown",
  differs: "DIFFERS from the bytes shown: do not run",
  unavailable: "This browser cannot hash the script (needs HTTPS), so Run stays off",
};

/** A labelled pre block; a hashed block shows the server's sha256 and whether the browser's own digest matches it. */
export const ScriptImpl = createComponentImplementation(ScriptApi, ({ props }) => {
  const text = String(props.text ?? "");
  const expected = props.sha256;
  const lines = text.split("\n");
  // The binder makes a new setter each render; a ref keeps the hash effect from re-running for it.
  const setShown = useRef<((value: string) => void) | undefined>(undefined);
  setShown.current = (props as { setShown?: (value: string) => void }).setShown;
  const [check, setCheck] = useState<Check>("checking");
  useEffect(() => {
    if (!expected) return;
    if (!globalThis.crypto?.subtle) { setCheck("unavailable"); return; }
    let live = true;
    digest(text).then(hex => {
      if (!live) return;
      setCheck(hex === expected ? "match" : "differs");
      setShown.current?.(hex);
    }, () => live && setCheck("unavailable"));
    return () => { live = false; };
  }, [text, expected]);
  return <div className="flex min-w-0 flex-col gap-1">
    {props.label && <span className="text-xs font-medium text-muted-foreground">{props.label}</span>}
    {/* Long lines wrap rather than scroll, so no byte sits off screen; numbers tell a wrap from a newline. */}
    <pre tabIndex={0} aria-label={props.label || "Text"}
      className="max-h-96 overflow-y-auto rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs">{lines.map((line, i) =>
        <span key={i} className="flex gap-2">
          {lines.length > 1 && <span aria-hidden className="w-[3ch] shrink-0 text-right text-muted-foreground select-none">{i + 1}</span>}
          <span className="min-h-[1lh] min-w-0 break-all whitespace-pre-wrap">{line}</span>
        </span>)}</pre>
    {expected && <span className={cn("font-mono text-[11px] break-all text-muted-foreground", check === "differs" && "font-semibold text-destructive")}>
      sha256 {expected} · {CHECK_TEXT[check]}
    </span>}
  </div>;
});
