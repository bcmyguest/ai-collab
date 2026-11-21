"use client";
import { useEffect, useState } from "react";
import { Bell, BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const STATES = {
  loading: ["checking", Bell], off: ["off", Bell], on: ["on", BellRing],
  blocked: ["blocked by browser", BellOff], unsupported: ["unsupported", BellOff], install: ["needs Home Screen app", BellOff],
};
const HINTS = {
  blocked: "Allow notifications for this site in the browser's site settings, then reload.",
  unsupported: "This browser cannot receive push notifications here. Use Chrome or Firefox over the HTTPS address.",
  install: "On iPhone or iPad, add AI Collab to the Home Screen and open it from there.",
};

const supported = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const apple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone;

function keyBytes(base64url) {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "="));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const sameKey = (sub, key) => {
  const own = sub.options?.applicationServerKey;
  if (!own) return true;
  const a = new Uint8Array(own);
  return a.length === key.length && a.every((byte, i) => byte === key[i]);
};

async function call(method, path, body) {
  const res = await fetch("/api/push/" + path, body ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { method });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}

// Header bell: shows the push state, asks permission only on tap, subscribes, unsubscribes, and sends a test.
export function NotifyToggle() {
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

  const [label, Icon] = STATES[state];
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label={"Notifications: " + label} title={"Notifications: " + label} data-state-push={state}><Icon/></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64">
      <DropdownMenuLabel>Notifications · {label}</DropdownMenuLabel>
      <DropdownMenuSeparator/>
      {state === "off" && <DropdownMenuItem disabled={busy} onSelect={enable}>Turn on</DropdownMenuItem>}
      {state === "on" && <>
        <DropdownMenuItem disabled={busy} onSelect={test}>Send test</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onSelect={disable}>Turn off</DropdownMenuItem>
      </>}
      {HINTS[state] && <p className="px-2 py-1.5 text-xs text-muted-foreground">{HINTS[state]}</p>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
