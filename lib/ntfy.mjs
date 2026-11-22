/**
 * Minimal ntfy HTTP client: JSON publish, cached bounded polling, and streaming subscriptions.
 * Uses Node's builtin fetch. Every request has a short timeout and
 * the poll body is size-capped, so a slow or hostile server cannot stall a hook.
 */

const POLL_MAX_BYTES = 256 * 1024;
const STREAM_LINE_MAX = 64 * 1024;
const STREAM_IDLE_MS = 120_000;
const TAIL_READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * ntfy turns the two characters \n of a query-string message into a newline, which breaks JSON string escapes.
 * For a JSON message, respell \n and \\ as \u000a and \: the same JSON value, safe through the query string.
 */
export function querySafe(message) {
  try { JSON.parse(message); } catch { return message; }
  return message.replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\\u000a" : "\\u005c"));
}

// The request timeout, or the caller's deadline when that ends sooner.
function withSignal(signal, ms) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function headers(cfg, extra = {}) {
  const h = { ...extra };
  if (cfg.token) h.authorization = `Bearer ${cfg.token}`;
  return h;
}

/** Publishes one message; resolves with the new event's id (true when ntfy's answer carries none). */
export async function publish(cfg, topic, message, { title, attach, signal, priority, click } = {}) {
  // An attachment is the request body; ntfy then takes message and title from the query string.
  const query = new URLSearchParams({ message: attach ? querySafe(message) : message, ...(title ? { title } : {}), ...(click ? { click } : {}), ...(attach ? { filename: attach.filename } : {}) });
  const res = attach
    ? await fetch(`${cfg.url}/${topic}?${query}`, {
      method: "PUT", headers: headers(cfg), body: attach.data, signal: withSignal(signal, cfg.timeoutMs * 4),
    })
    : await fetch(`${cfg.url}/`, {
      method: "POST",
      headers: headers(cfg, { "content-type": "application/json" }),
      body: JSON.stringify({ topic, message, ...(title ? { title } : {}), ...(priority ? { priority } : {}), ...(click ? { click } : {}) }),
      signal: withSignal(signal, cfg.timeoutMs),
    });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw Object.assign(new Error(`publish failed: HTTP ${res.status}`), { ntfyStatus: res.status });
  return publishedId(text) || true;
}

// The id of the event ntfy answers a publish with, or "".
function publishedId(text) {
  try {
    const id = JSON.parse(text)?.id;
    return typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

async function readBounded(res, maxBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.length - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  // Drop a partial trailing line so only complete JSON lines are parsed.
  if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
  return text;
}

// Keeps the newest complete lines within keepBytes; stops reading after TAIL_READ_MAX_BYTES.
async function readTail(res, keepBytes) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lines = [];
  let kept = 0;
  let partial = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    const parts = (partial + decoder.decode(value, { stream: true })).split("\n");
    partial = parts.pop();
    for (const line of parts) {
      lines.push(line);
      kept += line.length + 1;
    }
    while (kept > keepBytes && lines.length) kept -= lines.shift().length + 1;
    if (total > TAIL_READ_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Cached read: GET /<topic>/json?poll=1&since=<id|unix-seconds|duration>.
 * Returns only "message" events, oldest first. tailBytes keeps the newest events instead of the oldest.
 */
export async function pollCached(cfg, topic, since, signal, { tailBytes = 0 } = {}) {
  const url = `${cfg.url}/${encodeURIComponent(topic)}/json?poll=1&since=${encodeURIComponent(since)}`;
  const timeout = AbortSignal.timeout(cfg.timeoutMs);
  const res = await fetch(url, {
    headers: headers(cfg), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    throw Object.assign(new Error(`poll failed: HTTP ${res.status}`), { ntfyStatus: res.status });
  }
  const text = tailBytes ? await readTail(res, tailBytes) : await readBounded(res, POLL_MAX_BYTES);
  return text.split("\n").map(messageEvent).filter(Boolean);
}

function messageEvent(line) {
  if (!line.trim()) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || ev.event !== "message" || typeof ev.id !== "string" || typeof ev.message !== "string") return null;
  const a = ev.attachment;
  const attachment = a && typeof a.url === "string"
    ? { name: String(a.name || ""), type: String(a.type || ""), size: Number(a.size) || 0, url: a.url }
    : undefined;
  // The title carries who sent a UI reply (web/server/ui.mjs replyTitle).
  const title = typeof ev.title === "string" && ev.title ? { title: ev.title.slice(0, 200) } : {};
  return { id: ev.id, time: Number(ev.time) || 0, topic: ev.topic, message: ev.message, ...title, ...(attachment ? { attachment } : {}) };
}

/** Streaming read of GET /<topic1>,<topic2>/json?since=…; yields message events until close, idle, or abort. */
export async function* streamEvents(cfg, topics, { since = "", signal, onOpen } = {}) {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let timer = setTimeout(() => ctrl.abort(new Error("subscribe timed out")), cfg.timeoutMs);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error("subscription idle")), STREAM_IDLE_MS);
  };
  try {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await fetch(`${cfg.url}/${topics.map(encodeURIComponent).join(",")}/json${query}`, {
      headers: headers(cfg), signal: ctrl.signal,
    });
    if (!res.ok) {
      await res.arrayBuffer().catch(() => {});
      throw Object.assign(new Error(`subscribe failed: HTTP ${res.status}`), { ntfyStatus: res.status });
    }
    arm();
    onOpen?.();
    let buffer = "";
    for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
      arm();
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop();
      if (buffer.length > STREAM_LINE_MAX) throw new Error("subscription line too long");
      for (const line of lines) {
        const ev = messageEvent(line);
        if (ev) yield ev;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    ctrl.abort();
  }
}
