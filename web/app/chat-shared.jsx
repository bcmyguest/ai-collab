"use client";
// Small pieces every chat view shares: relative time, address helpers, the sender avatar and its online dot.
import { HarnessLogo, hasLogo } from "./logos";
import { Avatar as BaseAvatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { isLive } from "@/lib/session-state";

export const HARNESS_NAMES = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
export const clock = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ago(ms, now) {
  if (!ms) return "never";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 15) return "just now";
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.max(1, Math.round(seconds / 60)) + "m ago";
  if (seconds < 86400) return Math.round(seconds / 3600) + "h ago";
  return Math.round(seconds / 86400) + "d ago";
}

export const peerOf = address => String(address || "").split("#")[0];
export const short = address => address?.includes("#") ? address.slice(0, address.indexOf("#") + 9) : address;

export function Avatar({ address, className, by }) {
  const peer = peerOf(address);
  const label = by ? by.slice(0, 2).toUpperCase() : peer === "operator" ? "You" : peer === "system" ? "Sys" : peer.slice(0, 2).toUpperCase();
  const fallback = !by && hasLogo(peer) ? <HarnessLogo peer={peer} className="size-[55%]"/> : label;
  return <BaseAvatar title={address} className={cn("size-8 shrink-0 rounded-md text-xs font-medium [&_[data-slot=avatar-fallback]]:rounded-md [&_[data-slot=avatar-fallback]]:bg-muted [&_[data-slot=avatar-fallback]]:text-muted-foreground", className)}><AvatarFallback>{fallback}</AvatarFallback></BaseAvatar>;
}

export function Dot({ online }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground/40")}/>;
}

/** Team and role for a session address, from the agent list. Empty when the session holds no live role. */
export function seatOf(agents, address) {
  const agent = (agents || []).find(item => item.id === address);
  return agent?.team ? agent.team + " · " + agent.role : "";
}

/** "msg 3m ago · active just now" only while the session is waiting, held, or working. Hook seenAt is not a turn. */
export function seen(item, now) {
  const live = item.live === true || (item.live === undefined && isLive(item, now));
  return live && item.activeAt ? `msg ${ago(item.lastMessageAt, now)} · active ${ago(item.activeAt, now)}` : `msg ${ago(item.lastMessageAt, now)}`;
}

// The session's human name after its address, when the harness or its first prompt gives one.
export function SessionName({ agent }) {
  return agent?.name ? <span className="block min-w-0 truncate text-xs text-muted-foreground" title={agent.name}>{agent.name}</span> : null;
}
