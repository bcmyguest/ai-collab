// Usage and plan limits: detects a limit in a harness error or event, and owns the fallback chain a limit starts.
// Typed sources: sdk.d.ts (Claude SDK 0.3.330). Text patterns are UNVERIFIED: no type or source here names them.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { autoDefaults, stateDir } from "./config.ts";
import { FALLBACK_MODEL, HARNESSES, modelShape, parseHarnessModel } from "./harness.ts";
import { readJson, withLock, writeJson } from "./store.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- SDK event payloads are untyped JSON; property reads need any
export type Event = Record<string, any>;
export type Limit = {
  harness: string; window: string | null; windowName: string | null; resetsAt: number | null;
  wording: boolean; verified: boolean; source: string;
};
// kind is "limit" for a plan or usage limit (window, reset or wording shown), else "rate" for a bare HTTP 429.
export type DetectedLimit = Limit & { kind: "limit" | "rate" };
export type Pick = { label: string; harness: string; model: string; description?: string };

// oxlint-disable-next-line quality/no-known-value-widening -- open map keyed by server window names
export const LIMIT_WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly overage", overage: "overage",
};
// UNVERIFIED: limit wording in a harness's error text. A bare HTTP 429 matches none of these.
const LIMIT_TEXT = /usage limit|plan limit|rate limit|quota/i;
// Explicit subscription wording. "Rate limit" alone is not enough to call the card a limit.
const LIMIT_WORDING = /usage limit|plan limit|quota|5[- ]?hour|weekly|7[- ]?day/i;
const WINDOW_TEXT: [RegExp, string][] = [[/5[- ]?hour/i, "five_hour"], [/weekly|7[- ]?day/i, "seven_day"]];
// Codex error code for a plan limit. UNVERIFIED: the name is not in any type definition in this repo.
const CODEX_LIMIT_INFO = "usageLimitExceeded";
const CODEX_LIMIT_INFO_ROLLOUT = "usage_limit_exceeded";
// SDKRateLimitInfo.resetsAt is an epoch number. Its unit is UNVERIFIED: above 1e12 read as ms, else seconds.
// The window end is held to at least 5 minutes from now.
const MIN_WINDOW_MS = 5 * 60_000;
const MS_THRESHOLD = 1e12;

// The replacement a limit starts when nobody has named one: Cursor DeepSeek, then the free OpenCode model.
export const CURSOR_FALLBACK = { harness: "cursor", model: FALLBACK_MODEL };
export const OPENCODE_FALLBACK = { harness: "opencode", model: "opencode/deepseek-v4.1-flash-free" };
export const REPLACEMENT_MAX = 4;

/** "harness:model" when the model is known, else the harness. */
export const who = (harness: string, model?: string): string => (model ? `${harness}:${model}` : harness);

function limit(harness: string, { window = null, resetsAt = null, wording = false, verified, source }: {
  window?: string | null; resetsAt?: number | null; wording?: boolean; verified: boolean; source: string;
}): Limit {
  return { harness, window, windowName: window ? LIMIT_WINDOW_NAMES[window] ?? window : null, resetsAt, wording, verified, source };
}

// Window named in free text, e.g. "5-hour limit reached"; null when the text names none.
function windowFromText(text: unknown): string | null {
  return WINDOW_TEXT.find(([pattern]) => pattern.test(String(text ?? "")))?.[1] ?? null;
}

function resetMs(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > MS_THRESHOLD ? value : value * 1000;
  return Math.max(ms, now + MIN_WINDOW_MS);
}

// Overage that is allowed or in use: the request runs on overage credit, so the plan window did not block it (sdk.d.ts:6243-6246).
// A rejected overage is not on overage, whatever the other flags say: overageEnabled only means the account may buy overage.
function onOverage(info: Event): boolean {
  if (info.overageStatus === "rejected") return false;
  return info.isUsingOverage === true || info.overageInUse === true || info.overageEnabled === true
    || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
}

function classifyClaude(event: Event): Limit | null {
  switch (event?.kind) {
    // sdk.d.ts:6224 SDKRateLimitEvent; status 'rejected' means the limit blocked the request (sdk.d.ts:6238).
    case "rate_limit_event": {
      const info = event.rate_limit_info;
      if (info?.status !== "rejected" || onOverage(info)) return null;
      return limit("claude", {
        window: LIMIT_WINDOW_NAMES[info.rateLimitType] ? info.rateLimitType : null,
        resetsAt: resetMs(info.resetsAt), wording: true, verified: true, source: "sdk.d.ts:6224 rate_limit_event",
      });
    }
    // sdk.d.ts:10502 StopFailureHookInput; error 'rate_limit' is in the enum at sdk.d.ts:3995. Also returns for API 429s, not only plan limits.
    case "stop_failure": {
      if (event.error !== "rate_limit") return null;
      const details = String(event.error_details ?? "");
      return limit("claude", {
        window: windowFromText(details), wording: LIMIT_WORDING.test(details), verified: true, source: "sdk.d.ts:10502 StopFailure error=rate_limit",
      });
    }
    // sdk.d.ts:6268 SDKResultError with is_error; the text match is UNVERIFIED.
    case "result_error":
      return LIMIT_TEXT.test(event.text ?? "")
        ? limit("claude", { window: windowFromText(event.text), wording: LIMIT_WORDING.test(event.text), verified: false, source: "UNVERIFIED result error text" })
        : null;
    default: return null;
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Codex words the reset as "try again at 1:14 PM" or "try again at Nov 29th, 2026 1:14 PM"; a local time (the CLI prints the user's clock).
const CODEX_RESET = /try again at (?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/i;

/** The reset time (ms) a Codex limit message names, or null. A bare clock time is the next such time, not a past one. */
export function codexResetFrom(message: unknown, now = Date.now()): number | null {
  const found = CODEX_RESET.exec(String(message ?? ""));
  if (!found) return null;
  const [, month, day, year, hourText, minute, meridiem] = found;
  const hour = (Number(hourText) % 12) + (/^p/i.test(meridiem) ? 12 : 0);
  if (Number(hourText) < 1 || Number(hourText) > 12 || Number(minute) > 59) return null;
  let at: Date;
  if (year) {
    const index = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
    if (index < 0) return null;
    at = new Date(Number(year), index, Number(day), hour, Number(minute));
  } else {
    const today = new Date(now);
    at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, Number(minute));
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  }
  return Number.isFinite(at.getTime()) ? resetMs(at.getTime(), now) : null;
}

function classifyCodex(event: Event): Limit | null {
  if (event?.kind !== "turn_error") return null;
  const message = event.message ?? "";
  // UNVERIFIED: the codexErrorInfo code, from Codex's app-server protocol (not in node_modules or docs/).
  // The rollout file records the same code in snake_case (codex_error_info: "usage_limit_exceeded"), measured 2026-11-24.
  if (event.codexErrorInfo === CODEX_LIMIT_INFO || event.codexErrorInfo === CODEX_LIMIT_INFO_ROLLOUT) {
    return limit("codex", { window: windowFromText(message), resetsAt: codexResetFrom(message), wording: true, verified: false, source: "UNVERIFIED codexErrorInfo usageLimitExceeded" });
  }
  return LIMIT_TEXT.test(message)
    ? limit("codex", { window: windowFromText(message), resetsAt: codexResetFrom(message), wording: LIMIT_WORDING.test(message), verified: false, source: "UNVERIFIED turn error text" })
    : null;
}

function classifyOpenCode(event: Event): Limit | null {
  if (event?.kind !== "run_error") return null;
  // UNVERIFIED: OpenCode's provider error carries an HTTP status; runner/adapters/opencode.mjs forwards it in RUN_ERROR metadata.
  if (event.status === 429) return limit("opencode", { verified: false, source: "UNVERIFIED HTTP 429 from provider" });
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("opencode", { window: windowFromText(event.message), wording: LIMIT_WORDING.test(event.message), verified: false, source: "UNVERIFIED provider error text" })
    : null;
}

// Explicit limit wording a Cursor error may use about the plan's own window (not a bare "rate limited").
const CURSOR_LIMIT_TEXT = /usage limit|plan limit|monthly quota|quota exhausted|reached your (usage|limit|quota)/i;
// Structured ACP/error codes that name a usage limit. UNVERIFIED: no local schema names them.
const CURSOR_LIMIT_CODES = /usage_?limit|rate_?limit|limit_?exceeded|quota|insufficient_quota|429/i;
// A bare HTTP 429 counts only with limit wording beside it, so an ordinary throttled request does not open a card.
const HAS_429 = /(^|\D)429(\D|$)/;

function classifyCursor(event: Event): Limit | null {
  if (event?.kind !== "run_error") return null;
  const message = String(event.message ?? "");
  // The adapter joins the ACP error code, its data and the child's stderr tail into the message, so one text covers them all.
  const structured = [event.code, event.data].filter((value) => value !== undefined)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n");
  if (structured && CURSOR_LIMIT_CODES.test(structured) && !/^(0|1|2)$/.test(structured.trim())) {
    // A structured code is a limit on its own: the code says the plan blocked the request, not that a request was throttled.
    return limit("cursor", { window: windowFromText(`${message}\n${structured}`), wording: true, verified: false, source: "UNVERIFIED ACP error code" });
  }
  if (CURSOR_LIMIT_TEXT.test(message)) {
    return limit("cursor", { window: windowFromText(message), wording: LIMIT_WORDING.test(message), verified: false, source: "UNVERIFIED ACP error text" });
  }
  // "You've reached your usage limit" and "429" combined with limit wording: LIMIT_TEXT already covers the first; a 429 with
  // explicit limit wording is a limit even when neither of the patterns above matched only because of formatting.
  if (HAS_429.test(message) && LIMIT_TEXT.test(message)) {
    return limit("cursor", { window: windowFromText(message), wording: LIMIT_WORDING.test(message), verified: false, source: "UNVERIFIED ACP error text with HTTP 429" });
  }
  return null;
}

/** The limit an event reports, {harness, window, windowName, resetsAt (ms|null), wording, verified, source}, or null. */
export function classifyLimit(harness: string, event: Event): Limit | null {
  switch (harness) {
    case "claude": return classifyClaude(event);
    case "codex": return classifyCodex(event);
    case "opencode": return classifyOpenCode(event);
    case "cursor": return classifyCursor(event);
    default: return null;
  }
}

/** The limit a runner RUN_ERROR reports: its message, and for Codex its metadata codexErrorInfo; the kind follows the adapter's error source. */
export function limitFromRunError(harness: string, message: string, metadata: Event = {}): Limit | null {
  const kind = harness === "claude" ? "result_error" : harness === "codex" ? "turn_error" : "run_error";
  // An adapter that saw an HTTP status (OpenCode's provider error) or an ACP error code (Cursor) forwards it here.
  const status = Number.isInteger(metadata.status) && metadata.status > 0 ? metadata.status : undefined;
  return classifyLimit(harness, {
    kind, text: message, message, codexErrorInfo: metadata.codexErrorInfo,
    ...(status ? { status } : {}), ...(metadata.code !== undefined ? { code: metadata.code } : {}),
  });
}

/**
 * The one detector for an error: a text (classified as the harness's run error) or a structured event.
 * Returns the limit with kind, or null when the text or event is not a limit.
 */
export function detectLimit(harness: string, errorOrText: string | Event): DetectedLimit | null {
  const found = typeof errorOrText === "string" ? limitFromRunError(harness, errorOrText) : classifyLimit(harness, errorOrText);
  if (!found) return null;
  return { ...found, kind: isBlockingLimit(found) ? "limit" : "rate" };
}

/** Whether a limit stops the work and starts the fallback: wording, a window or a reset. A bare rate limit does not. Every path uses this. */
export function isBlockingLimit(limit: Limit | null | undefined): boolean {
  return Boolean(limit && (limit.wording || limit.window || limit.resetsAt));
}

// Cursor names the end of its monthly cycle in a limit line; the limit lasts through the day after it.
const CURSOR_MONTHLY = /monthly cycle ends on (\d{1,2})\/(\d{1,2})\/(\d{4})/i;
// A Cursor limit with no usable cycle date lasts this long.
const CURSOR_UNKNOWN_LIMIT_MS = 5 * 3600_000;

/** The reset (ms) a Cursor limit line names, or null when it names none or the date has passed. */
export function cursorResetFrom(line: string, now = Date.now()): number | null {
  const found = CURSOR_MONTHLY.exec(line);
  if (!found) return null;
  const at = Date.UTC(Number(found[3]), Number(found[1]) - 1, Number(found[2]) + 1);
  return at > now ? at : null;
}

// Cursor's limit record per model: builder-limits/cursor-<sha256 of the lower-case model>.json, holding {until} in ms.
export function cursorLimitFile(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(model.toLowerCase()).digest("hex");
  return join(stateDir(env), "builder-limits", `cursor-${key}.json`);
}

/** The time (ms) a Cursor model is limited until, or 0. A missing or unreadable record is no limit. */
export function cursorLimitUntil(model: string, env: NodeJS.ProcessEnv = process.env): number {
  const record = readJson<{ until?: unknown }>(cursorLimitFile(model, env));
  return typeof record?.until === "number" && Number.isFinite(record.until) ? record.until : 0;
}

/** Records a Cursor model's limit from its limit line, lasting to the cycle end or 5 hours; keeps the later of old and new. */
export async function recordCursorLimit(model: string, line: string, { env = process.env, now = Date.now() }: { env?: NodeJS.ProcessEnv; now?: number } = {}): Promise<void> {
  const file = cursorLimitFile(model, env);
  await withLock(file, async () => {
    const until = cursorResetFrom(line, now) ?? now + CURSOR_UNKNOWN_LIMIT_MS;
    writeJson(file, { until: Math.max(until, cursorLimitUntil(model, env)) });
  });
}

// A role's fallback as {harness, model}, or null; read defensively, since the attribute is optional.
function fallbackOf(fallback: unknown): { harness: string; model: string } | null {
  const parsed = parseHarnessModel(fallback);
  return parsed?.model ? parsed : null;
}

/**
 * Models to try after a limit, in order: the configured fallback first (a different model on the same harness is allowed),
 * then Cursor DeepSeek, then the free OpenCode model, then the first listed model of each other available harness.
 * Harness `harness` is the one that stopped; `fallback` defaults to defaults.json limitFallback.
 */
export function fallbackChain({ harness, model = "", fallback, models = {}, available = [], env }: {
  harness: string; model?: string; fallback?: unknown; models?: Record<string, string[]>; available?: string[]; env?: NodeJS.ProcessEnv;
}): Pick[] {
  const picks: Pick[] = [];
  const add = (item: { harness: string; model: string } | null, description?: string, { sameHarness = false } = {}) => {
    if (!item || !(HARNESSES as readonly string[]).includes(item.harness) || !modelShape(item.harness, item.model)) return;
    if (item.harness === harness && !(sameHarness && model && item.model !== model)) return;
    const label = who(item.harness, item.model);
    if (picks.some((pick) => pick.label === label) || picks.length >= REPLACEMENT_MAX) return;
    picks.push({ label, harness: item.harness, model: item.model, ...(description ? { description } : {}) });
  };
  const defaults: { limitFallback?: unknown } | null = env ? autoDefaults(env) : null;
  const configured = fallback ?? defaults?.limitFallback;
  add(fallbackOf(configured), "Configured fallback", { sameHarness: true });
  add(CURSOR_FALLBACK, "Cursor fallback");
  add(OPENCODE_FALLBACK, "Free fallback");
  for (const other of available) {
    if (other === harness || !(HARNESSES as readonly string[]).includes(other)) continue;
    const first = (models[other] ?? []).find((name) => modelShape(other, name));
    if (first) add({ harness: other, model: first });
  }
  return picks;
}

/**
 * Manual limit card options: the role's fallback first, then the first listed model of each other available harness, at most REPLACEMENT_MAX.
 * Returns [{label, harness, model, description?}]; the caller appends its wait option.
 */
export function replacementOptions({ harness, model = "", fallback, models = {}, available = [] }: {
  harness: string; model?: string; fallback?: unknown; models?: Record<string, string[]>; available?: string[];
}): Pick[] {
  const picks: { harness: string; model: string; description?: string }[] = [];
  const fb = fallbackOf(fallback);
  if (fb) picks.push({ ...fb, description: "Role fallback" });
  for (const other of available) {
    if (other === harness || !(HARNESSES as readonly string[]).includes(other)) continue;
    const first = (models[other] ?? []).find((name) => modelShape(other, name));
    if (first) picks.push({ harness: other, model: first });
  }
  const seen = new Set([who(harness, model)]);
  const out: Pick[] = [];
  for (const pick of picks) {
    const label = who(pick.harness, pick.model);
    if (seen.has(label) || out.length >= REPLACEMENT_MAX) continue;
    seen.add(label);
    out.push({ label, harness: pick.harness, model: pick.model, ...(pick.description ? { description: pick.description } : {}) });
  }
  return out;
}
