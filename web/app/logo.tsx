// The ai-collab mark, "Threads": two crossing strands, kept in one constant so the mark swaps in one place.
import { cn } from "@/lib/utils";

const MARK = <>
  <path d="M5 10c6 0 6 12 12 12s6-12 10-12"/>
  <path d="M5 22c6 0 6-12 12-12s6 12 10 12" opacity=".55"/>
</>;

/** The mark in the accent colour; decorative, so the wordmark beside it names the app. */
export function Logo({ className }: { className?: string }) {
  return <svg aria-hidden viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
    className={cn("size-5 shrink-0 text-primary", className)}>{MARK}</svg>;
}
