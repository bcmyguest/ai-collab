"use client";
import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ALERT_LEVELS, AlertLevelItems } from "./alert-level";
import { isAlertLevel, readRememberedAlertLevel, rememberAlertLevel, shownAlertLevel, subscriptionUsesKey } from "@/lib/alert-level";

const STATES = {
  loading: ["checking", Bell], off: ["off", Bell], on: ["on", BellRing],
  blocked: ["blocked by browser", BellOff], unsupported: ["unsupported", BellOff], install: ["needs Home Screen app", BellOff],
};
const HINTS = {
  blocked: "Allow notifications for this site in the browser's site settings, then reload.",
  unsupported: "This browser cannot receive push notifications here. Use Chrome or Firefox over the HTTPS address.",
  install: "On iPhone or iPad, add AI Collab to the Home Screen and open it from there.",
};

// Decisions the bell lists before pointing at the inbox.
const BELL_ITEMS = 5;

const supported = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const apple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone;

function keyBytes(base64url) {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const sameKey = subscriptionUsesKey;

async function call(method, path, body) {
  const res = await fetch("/api/push/" + path, body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}

// Header bell: one Notifications menu with the browser push state, its actions, and the phone alert level.
// level is the server's stored level; undefined before the first state frame, so the last choice shows instead.
/** One line for a pending decision: the approval's summary, the suspension's title, or the question itself. */
function decisionText(item) {
  if (item.approval) return item.approval.summary || item.approval.tool || "Approval";
  if (item.suspension) return item.suspension.title || item.suspension.prompt || "Run waits to resume";
  const lines = String(item.body || "").split("\n").map(line => line.trim()).filter(line => line && !/^(Question from|Reply in this topic)/.test(line));
  return (lines[0] || "Question").replace(/^IMPORTANT, the agent waits for this answer:\s*/, "");
}

/** The one bell: pending decisions from every project with their count, then this browser's push and alert controls. */
export function NotifyToggle({ level, levelDisabled = false, setLevel, decisions = [], now = 0, openInbox }) {
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported()) { setState(apple() ? "install" : "unsupported"); return; }
    let live = true;
    // A tapped notification asks an open tab to show the item's thread.
    const onMessage = event => {
      const hash = event.data?.type === "ai-collab-open" && event.data.hash;
      if (typeof hash === "string" && hash.startsWith("#")) location.hash = hash;
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then(reg => reg.pushManager.getSubscription())
      .then(async sub => {
        if (!live) return;
        if (Notification.permission === "denied") return setState("blocked");
        if (!sub || Notification.permission !== "granted") return setState("off");
        // A subscription made with an older VAPID key can never be delivered to; replace it before claiming "on".
        const { publicKey } = await call("GET", "key").catch(() => ({}));
        const key = publicKey ? keyBytes(publicKey) : null;
        if (key && !sameKey(sub, key)) {
          await sub.unsubscribe().catch(() => {});
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => null);
          if (!live) return;
          if (!sub) return setState("off");
        }
        setState("on");
        // The server drops subscriptions the push service reports gone; resend so it holds this one.
        await call("POST", "subscribe", { subscription: sub.toJSON() }).catch(() => {});
      })
      .catch(() => live && setState("unsupported"));
    return () => { live = false; navigator.serviceWorker.removeEventListener("message", onMessage); };
  }, []);

  async function enable() {
    // Firefox shows the prompt only from a user gesture, so requestPermission runs before any other await.
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { setState(permission === "denied" ? "blocked" : "off"); return; }
    setBusy(true);
    try {
      const [reg, { publicKey }] = await Promise.all([navigator.serviceWorker.ready, call("GET", "key")]);
      const key = keyBytes(publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
      sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await call("POST", "subscribe", { subscription: sub.toJSON() });
      setState("on");
      toast.success("Notifications on");
    } catch (err) {
      toast.error("Notifications failed: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) {
        await call("DELETE", "subscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setState("off");
      toast.success("Notifications off");
    } catch (err) {
      toast.error("Could not turn notifications off: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (!sub) throw new Error("this browser is not subscribed");
      await call("POST", "test", { endpoint: sub.endpoint });
      toast.success("Test sent");
    } catch (err) {
      toast.error("Test failed: " + err.message);
    } finally {
      setBusy(false);
    }
  }

  // The server's level wins; before the first state frame (and after a deploy reload) this browser's last choice shows.
  const shown = shownAlertLevel(level, readRememberedAlertLevel(globalThis.localStorage));
  const choose = next => {
    if (!isAlertLevel(next)) return;
    rememberAlertLevel(globalThis.localStorage, next);
    setLevel?.(next);
  };
  const [label, Icon] = STATES[state];
  const alerts = ALERT_LEVELS.find(([id]) => id === shown)?.[1] || "All";
  const pending = decisions.filter(item => !(item.expiresAt && item.expiresAt < now));
  const count = pending.length;
  const summary = (count ? count + (count === 1 ? " decision waits" : " decisions wait") + " on you · " : "") + "Notifications: " + label + " · phone alerts " + alerts;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size={count ? "default" : "icon"} aria-label={summary} title={summary} data-state-push={state} data-decisions={count} disabled={levelDisabled}
        className={cn(count > 0 && "gap-1 px-2 text-primary")}>
        <Icon/>{count > 0 && <span className="text-xs font-semibold tabular-nums">{count}</span>}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" side="top" className="w-80 max-w-[calc(100vw-1rem)]">
      <DropdownMenuLabel>{count ? "Waiting on you · " + count : "No decisions waiting"}</DropdownMenuLabel>
      {pending.slice(0, BELL_ITEMS).map(item => <DropdownMenuItem key={item.project + ":" + item.key} onSelect={() => openInbox?.()} className="flex-col items-start gap-0.5">
        <span className="line-clamp-2 w-full text-sm [overflow-wrap:anywhere]">{decisionText(item)}</span>
        <span className="text-xs text-muted-foreground">{item.project} · {item.agentName || item.from}</span>
      </DropdownMenuItem>)}
      {openInbox && <DropdownMenuItem onSelect={openInbox} className="font-medium text-primary">
        {count > BELL_ITEMS ? "All " + count + " in the decision inbox" : "Open decision inbox"}
      </DropdownMenuItem>}
      <DropdownMenuSeparator/>
      <DropdownMenuLabel>Browser push · {label}</DropdownMenuLabel>
      <DropdownMenuSeparator/>
      {state === "off" && <DropdownMenuItem disabled={busy} onSelect={enable}>Turn on</DropdownMenuItem>}
      {state === "on" && <>
        <DropdownMenuItem disabled={busy} onSelect={test}>Send test</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={disable}>Turn off</DropdownMenuItem>
      </>}
      {HINTS[state] && <p className="px-2 py-1.5 text-xs text-muted-foreground">{HINTS[state]}</p>}
      <AlertLevelItems level={shown} set={choose}/>
    </DropdownMenuContent>
  </DropdownMenu>;
}
