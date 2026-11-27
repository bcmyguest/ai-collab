"use client";
import { SquareTerminal } from "lucide-react";
import { CARD, Surface } from "@/components/a2ui/surface";
import { runOutcome, runSurfaceId } from "@/lib/a2ui-run";
import { cn } from "@/lib/utils";

type RunRequest = {
  id: string;
  session: string;
  cwd: string;
  reason: string;
  script: string;
  sha256: string;
  status: string;
  expiresAt: number;
};

// Without a rendered surface the card stays read-only: Run needs the surface's browser-side hash.
function Fallback({ request }: { request: RunRequest }) {
  return <section className={cn(CARD, "flex flex-col gap-2")} data-card="run">
    <p className="font-medium">Run in terminal · {request.status}</p>
    <p>{request.reason}</p>
    <p className="text-xs text-muted-foreground">From {request.session} · cwd {request.cwd}</p>
    <pre className="max-h-72 overflow-auto rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs whitespace-pre">{request.script}</pre>
    <p className="font-mono text-xs break-all text-muted-foreground">sha256 {request.sha256}</p>
    <p className="text-xs text-muted-foreground">{request.status === "pending" ? "The approval card did not render, so Run is unavailable here. Reload to try again." : runOutcome(request)}</p>
  </section>;
}

/** Run-in-terminal requests as A2UI cards, newest first; open ones first. Nothing renders while the feature is off. */
export function RunRequests({ requests, now }: { requests?: RunRequest[]; now: number }) {
  if (!requests?.length) return null;
  const open = (request: RunRequest) => request.status === "pending" && request.expiresAt > now;
  const sorted = [...requests.filter(open), ...requests.filter(request => !open(request)).slice(0, 3)];
  return <div className="mx-auto mt-2 flex w-full max-w-3xl flex-col gap-2">
    {sorted.map(request => <Surface key={request.id} id={runSurfaceId(request.id)} open={open(request)} fallback={<Fallback request={request}/>}
      head={<><SquareTerminal className="size-3.5"/>{request.session}</>} kind="run in terminal"/>)}
  </div>;
}
