/**
 * Web Push sender: VAPID keys and browser subscriptions live in 0600 files under the state dir, never in the repo.
 * Payloads are encrypted (aes128gcm) for each browser, so the push service (FCM, Mozilla autopush) sees only ciphertext.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateRequestDetails, generateVAPIDKeys } from "web-push";
import { writeState } from "../../lib/state.ts";

const SENT_TTL_MS = 24 * 60 * 60_000;
const SENT_MAX = 2000;
const SUBSCRIPTIONS_MAX = 20;
const ENDPOINT_MAX = 2048;
const KEY = /^[A-Za-z0-9_-]{16,128}={0,2}$/;
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;
const TTL_S = 6 * 60 * 60;
const SEND_TIMEOUT_MS = 15_000;
const TITLE_MAX = 80;
const BODY_MAX = 200;
const GONE = [404, 410];

// oxlint-disable-next-line typescript/no-explicit-any -- state files and browser subscriptions are JSON
type Json = any;
/** A browser push subscription reduced to what sending needs. */
export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type VapidKeys = { publicKey: string; privateKey: string };
type NoticeInput = { project: string; kind: string; id: string; sender: string; harness?: string; tool?: string; text?: string; important?: boolean };
/** The notification payload the service worker shows. */
export type Notice = {
  title: string; body: string; tag: string; important: boolean; kind: string; project: string; session: string; harness: string; url: string;
};
/** Delivery counts of one send. */
export type SendCounts = { sent: number; gone: number; failed: number };
type Delivery = "sent" | "gone" | "failed";

const clip = (text: unknown, max: number): string => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
};

function readJson(file: string, fallback: Json): Json {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

/** A browser PushSubscription reduced to {endpoint, keys}, or null when the shape is wrong. */
export function cleanSubscription(raw: Json, { allowHttp = false } = {}): Subscription | null {
  const endpoint = raw?.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX) return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
  const { p256dh, auth } = raw.keys || {};
  if (!KEY.test(p256dh || "") || !KEY.test(auth || "")) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** Hash route that opens the item's session thread, else the project's session list, in the UI. */
export function itemUrl(project: string, sender: string = ""): string {
  const [peer, session] = String(sender || "").split("#");
  const route: Record<string, string> = session ? { project, level: "session", harness: peer, session: sender } : peer ? { project, level: "session" } : { project };
  return "/#" + new URLSearchParams(route).toString();
}

/** The notification payload: who asks and a clipped one-line summary, never file contents. */
export function notice({ project, kind, id, sender, harness, tool, text, important = false }: NoticeInput): Notice {
  // oxlint-disable-next-line quality/no-known-value-widening -- looked up by a runtime notice kind
  const titles: Record<string, string> = {
    approval: `Approve ${tool || "tool"} · ${sender}`, choice: `Choose · ${sender}`,
    question: `${important ? "Important question" : "Question"} · ${sender}`, message: `Message · ${sender}`,
  };
  return {
    title: clip(titles[kind], TITLE_MAX), body: clip(text, BODY_MAX), tag: id, important: important === true,
    kind, project, session: sender, harness: harness || String(sender).split("#")[0], url: itemUrl(project, sender),
  };
}

export function createPush({ dir, subject, fetch: send = globalThis.fetch, now = Date.now, log = console.warn, allowHttp = false }: {
  dir: string; subject: string; fetch?: typeof fetch; now?: () => number; log?: (line: string) => void; allowHttp?: boolean;
}) {
  const files = { vapid: join(dir, "vapid.json"), subscriptions: join(dir, "subscriptions.json"), sent: join(dir, "sent.json") };
  let vapid: VapidKeys | null = null;

  function keys(): VapidKeys {
    if (vapid) return vapid;
    const stored = readJson(files.vapid, null);
    if (KEY.test(stored?.publicKey || "") && KEY.test(stored?.privateKey || "")) vapid = stored;
    else {
      vapid = generateVAPIDKeys();
      writeState(files.vapid, vapid);
    }
    return vapid as VapidKeys;
  }

  const list = (): Subscription[] => {
    const value = readJson(files.subscriptions, []);
    return Array.isArray(value) ? value.map((item: Json) => cleanSubscription(item, { allowHttp })).filter((item: Subscription | null): item is Subscription => Boolean(item)) : [];
  };
  const save = (items: Subscription[]): void => writeState(files.subscriptions, items);

  function subscribe(raw: Json): Subscription {
    const sub = cleanSubscription(raw, { allowHttp });
    if (!sub) throw Object.assign(new Error("Invalid push subscription"), { status: 400 });
    keys();
    save([...list().filter(item => item.endpoint !== sub.endpoint), sub].slice(-SUBSCRIPTIONS_MAX));
    return sub;
  }

  function unsubscribe(endpoint: string): number {
    const items = list();
    const kept = items.filter(item => item.endpoint !== endpoint);
    if (kept.length !== items.length) save(kept);
    return items.length - kept.length;
  }

  // One encrypted POST to the browser's push service; 404 or 410 means the subscription is gone.
  async function deliver(sub: Subscription, message: Notice): Promise<Delivery> {
    const { publicKey, privateKey } = keys();
    const details = generateRequestDetails(sub, JSON.stringify(message), {
      vapidDetails: { subject, publicKey, privateKey }, TTL: TTL_S,
      urgency: message.important ? "high" : "normal", ...(TOPIC.test(message.tag || "") ? { topic: message.tag } : {}),
    });
    const headers = { ...details.headers };
    delete headers["Content-Length"];
    try {
      const res = await send(details.endpoint, { method: details.method, headers, body: details.body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
      await res.arrayBuffer().catch(() => {});
      if (res.ok) return "sent";
      if (GONE.includes(res.status)) return "gone";
      log(`ai-collab push: ${new URL(sub.endpoint).host} answered ${res.status}`);
    } catch (err) {
      log(`ai-collab push: ${new URL(sub.endpoint).host} unreachable (${(err as Error).name})`);
    }
    return "failed";
  }

  /** Sends to every subscription (or the one endpoint given) and drops those the push service reports gone. */
  async function sendAll(message: Notice, { endpoint }: { endpoint?: string } = {}): Promise<SendCounts> {
    const targets = list().filter(item => !endpoint || item.endpoint === endpoint);
    const results = await Promise.all(targets.map(sub => deliver(sub, message)));
    const gone = new Set(targets.filter((_, i) => results[i] === "gone").map(item => item.endpoint));
    if (gone.size) save(list().filter(item => !gone.has(item.endpoint)));
    return { sent: results.filter(r => r === "sent").length, gone: gone.size, failed: results.filter(r => r === "failed").length };
  }

  /** Sends once per key: ids stay remembered for a day, across restarts. */
  async function notify(key: string, message: Notice): Promise<SendCounts | { sent: 0; duplicate?: true }> {
    const at = now();
    const sent = Object.entries<number>(readJson(files.sent, {})).filter(([, t]) => Number.isFinite(t) && at - t < SENT_TTL_MS);
    if (sent.some(([id]) => id === key)) return { sent: 0, duplicate: true };
    writeState(files.sent, Object.fromEntries([...sent, [key, at]].slice(-SENT_MAX)));
    if (!list().length) return { sent: 0 };
    return sendAll(message);
  }

  return { publicKey: () => keys().publicKey, subscribe, unsubscribe, subscriptions: list, send: sendAll, notify };
}
