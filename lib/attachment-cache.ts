/**
 * One local cache for message attachments, shared by the UI and every agent on this machine.
 *
 * The UI used to fetch `/file/<id>` on every render (once per browser, per reload, per device). A file is
 * fetched here at most once: into <stateDir>/<project>/attachments under a lock, then served from disk.
 * Agents read the same copy, so a screenshot costs one fetch however many sessions see the message.
 *
 * A cached file is complete by construction: the download is written to a temporary name and renamed. The
 * served type comes from the file extension, the same rule the bus uses to name the file it stores.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENT_MAX_BYTES } from "./attachment.ts";
import { withLock } from "./state.ts";

export const IMAGE_FILE = /^[A-Za-z0-9]{1,32}\.(?:png|jpe?g|gif|webp)$/i;
export const TEXT_FILE = /^[A-Za-z0-9]{1,32}\.txt$/;
const TEXT_TYPE = "text/plain; charset=utf-8";
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
// A bounded cache: old attachments go, and the newest CACHE_MAX_FILES stay.
const CACHE_MAX_FILES = 200;
const CACHE_MAX_AGE_MS = 7 * 24 * 3_600_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

export function isAttachmentFile(name: string | number | bigint | boolean | null | undefined, text = false): boolean {
  return (text ? TEXT_FILE : IMAGE_FILE).test(String(name));
}

/** The served type of a cached attachment, from its extension (the bus keeps the extension in the file name). */
export function attachmentType(name: string | number | bigint | boolean | null | undefined): string {
  const file = String(name);
  return file.endsWith(".txt") ? TEXT_TYPE : IMAGE_TYPES[file.slice(file.lastIndexOf(".")).toLowerCase() as keyof typeof IMAGE_TYPES] || "application/octet-stream";
}

/**
 * The attachment metadata of a bus event as {file, name, type, size}, or undefined when the file is not one
 * this UI shows: chat topics carry images only, the activity topic also carries a large result's .txt.
 */
export interface AttachmentMeta {
  file: string;
  name: string;
  type: string;
  size: number;
}

export function attachmentOf(event: Record<string, unknown> | undefined, { text = false }: { text?: boolean } = {}): AttachmentMeta | undefined {
  const a = event?.attachment as Record<string, unknown> | undefined;
  if (!a) return undefined;
  const file = typeof a.url === "string" ? a.url.slice(a.url.lastIndexOf("/") + 1).split(/[?#]/)[0] : "";
  const type = typeof a.type === "string" ? a.type : "";
  const ok = isAttachmentFile(file, text) && (text ? /^text\/plain(?:;|$)/.test(type) : /^image\//.test(type));
  if (!ok) return undefined;
  return { file, name: String(a.name || file).slice(0, 200), type: type || attachmentType(file), size: Number(a.size) || 0 };
}

export interface StateConfig {
  stateDir: string;
  project: string;
  url?: string;
  token?: string;
}

export function attachmentDir(cfg: StateConfig): string {
  return join(cfg.stateDir, cfg.project, "attachments");
}

/** The local path for a file name, validated so a name can never step outside the cache directory. */
export function attachmentPath(cfg: StateConfig, file: string): string {
  if (!isAttachmentFile(file) && !TEXT_FILE.test(String(file))) throw new Error("invalid attachment name");
  return join(attachmentDir(cfg), String(file));
}

export interface CachedAttachment {
  path: string;
  size: number;
  type: string;
}

/** The cached copy of a file, {path, size, type}, or null when this machine has not downloaded it yet. */
export function cachedAttachment(cfg: StateConfig, file: string): CachedAttachment | null {
  let path: string;
  try { path = attachmentPath(cfg, file); } catch { return null; }
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 ? { path, size: stat.size, type: attachmentType(file) } : null;
  } catch {
    return null;
  }
}

export interface LocalizedAttachment extends AttachmentMeta {
  local_path?: string;
}

/** Attachment metadata plus local_path when this machine already holds the file; the inbox prints that path. */
export function localizedAttachment(cfg: StateConfig, attachment: AttachmentMeta | undefined): LocalizedAttachment | undefined {
  if (!attachment) return undefined;
  const hit = cachedAttachment(cfg, attachment.file);
  return hit ? { ...attachment, local_path: hit.path } : attachment;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Reads the body under a hard cap, so a hostile server cannot exhaust memory.
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("attachment is over the size limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

interface PruneEntry {
  name: string;
  at: number;
}

// Drops attachments past the age limit, then the oldest beyond the file cap. Best effort: a prune never fails a fetch.
export function pruneAttachments(cfg: StateConfig, now = Date.now()): number {
  const dir = attachmentDir(cfg);
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  const entries: PruneEntry[] = [];
  for (const name of names) {
    if (!IMAGE_FILE.test(name) && !TEXT_FILE.test(name)) continue;
    try {
      const stat = statSync(join(dir, name));
      if (stat.isFile()) entries.push({ name, at: stat.mtimeMs });
    } catch { /* vanished */ }
  }
  const stale = entries.filter((entry) => now - entry.at > CACHE_MAX_AGE_MS);
  for (const entry of stale) rmSync(join(dir, entry.name), { force: true });
  const live = entries.filter((entry) => !stale.includes(entry)).sort((a, b) => a.at - b.at);
  const excess = live.slice(0, Math.max(0, live.length - CACHE_MAX_FILES));
  for (const entry of excess) rmSync(join(dir, entry.name), { force: true });
  return stale.length + excess.length;
}

function storeAttachment(cfg: StateConfig, file: string, data: Buffer, now: number): void {
  const path = attachmentPath(cfg, file);
  mkdirSync(attachmentDir(cfg), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  try { pruneAttachments(cfg, now); } catch { /* best effort */ }
}

export interface UploadedAttachment {
  filename: string;
  data: Buffer;
}

/** Seed the local cache with bytes already uploaded to the bus. */
export function cacheUploadedAttachment(cfg: StateConfig, event: Record<string, unknown>, { filename, data }: UploadedAttachment): void {
  const attachment = attachmentOf(event, { text: TEXT_FILE.test(filename) });
  if (!attachment || attachment.size !== data.length || cachedAttachment(cfg, attachment.file)) return;
  storeAttachment(cfg, attachment.file, data, Date.now());
}

export interface EnsureOptions {
  signal?: AbortSignal;
  waitMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface EnsuredAttachment {
  path: string;
  size: number;
  type: string;
  cached: boolean;
}

/**
 * The cached copy of file, downloaded from the bus the first time. Resolves {path, size, type, cached}: cached is
 * true when this call found the file already present. The lock makes concurrent readers (two tabs, a hook and
 * the UI, two sessions) share one download. A failed download writes nothing, so a retry starts clean.
 * waitMs bounds the wait for that lock: a hook passes a short one so its message is not delayed.
 */
export async function ensureAttachment(cfg: StateConfig, file: string, { signal, waitMs = LOCK_WAIT_MS, fetch: doFetch = fetch, now = Date.now }: EnsureOptions = {}): Promise<EnsuredAttachment> {
  const hit = cachedAttachment(cfg, file);
  if (hit) return { ...hit, cached: true };
  const path = attachmentPath(cfg, file);
  const text = TEXT_FILE.test(String(file));
  const r = await withLock(path, async () => {
    const again = cachedAttachment(cfg, file);
    if (again) return { ...again, cached: true };
    const res = await doFetch(`${cfg.url}/file/${encodeURIComponent(file)}`, {
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
      signal: requestSignal(signal),
    }).catch(() => null);
    const type = res?.headers.get("content-type") || "";
    if (!res?.ok || !(text ? /^text\/plain(?:;|$)/.test(type) : /^image\//.test(type))) {
      await res?.body?.cancel().catch(() => {});
      throw Object.assign(new Error("attachment unavailable"), { status: 502 });
    }
    const data = await readLimited(res, ATTACHMENT_MAX_BYTES);
    if (!data.length) throw Object.assign(new Error("attachment unavailable"), { status: 502 });
    storeAttachment(cfg, file, data, now());
    return { path, size: data.length, type: attachmentType(file), cached: false };
  }, { waitMs: Math.min(waitMs, LOCK_WAIT_MS), staleMs: LOCK_STALE_MS });
  if (!r.locked) throw Object.assign(new Error("attachment cache is busy"), { status: 503 });
  return r.value;
}

/** The bytes of a cached attachment; used by the UI to answer a request without another network read. */
export function readAttachmentFile(cached: CachedAttachment): Buffer {
  return readFileSync(cached.path);
}

export interface CacheableMessage {
  attachment?: unknown;
}

/**
 * Messages as handed to an agent, each attachment downloaded into the shared cache at most once.
 * A message that already knows its local path is left alone; a failed download keeps the metadata and no
 * local_path, so the UI (or a later delivery) can still try. Never throws: a hook must not fail over a file.
 */
export async function cacheAttachments(cfg: StateConfig, messages: CacheableMessage[], { signal, waitMs, ensure = ensureAttachment }: { signal?: AbortSignal; waitMs?: number; ensure?: typeof ensureAttachment } = {}): Promise<CacheableMessage[]> {
  return Promise.all(messages.map(async (m) => {
    const attachment = m?.attachment as AttachmentMeta & { local_path?: string } | undefined;
    if (!attachment?.file || attachment.local_path) return m;
    const hit = cachedAttachment(cfg, attachment.file);
    if (hit) return { ...m, attachment: { ...attachment, local_path: hit.path } };
    try {
      const got = await ensure(cfg, attachment.file, { signal, ...(waitMs === undefined ? {} : { waitMs }) });
      return { ...m, attachment: { ...attachment, local_path: got.path } };
    } catch {
      return m;
    }
  }));
}

/**
 * cacheAttachments under a time budget, for a path the operator is waiting on (a hook, a Stop rewrite).
 * A download still running at the deadline keeps going in the cache on the next visit; the message just
 * arrives without local_path this time.
 */
export async function cacheAttachmentsWithin(cfg: StateConfig, messages: CacheableMessage[], { budgetMs = 4000, signal, ensure }: { budgetMs?: number; signal?: AbortSignal; ensure?: typeof ensureAttachment } = {}): Promise<CacheableMessage[]> {
  if (!messages.some((m) => { const a = m?.attachment as AttachmentMeta & { local_path?: string } | undefined; return a && !a.local_path; })) return messages;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("attachment cache budget spent")), budgetMs);
  timer.unref?.();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // The lock wait shares the budget, so a concurrent download cannot hold a hook past its deadline.
    return await cacheAttachments(cfg, messages, { signal: ctrl.signal, waitMs: budgetMs, ...(ensure ? { ensure } : {}) });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
