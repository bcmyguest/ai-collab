// Subscription and usage-limit detection: classifies a harness error or event as a limit, or null.
// Typed sources: sdk.d.ts (Claude SDK 0.3.330). Text patterns are UNVERIFIED: no type or source here names them.

export const LIMIT_WINDOW_NAMES = {
  five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly overage", overage: "overage",
};
// UNVERIFIED: limit wording in a harness's error text. A bare HTTP 429 matches none of these.
const LIMIT_TEXT = /usage limit|plan limit|rate limit|quota/i;
// Explicit subscription wording. "Rate limit" alone is not enough to call the card a limit.
const LIMIT_WORDING = /usage limit|plan limit|quota|5[- ]?hour|weekly|7[- ]?day/i;
const WINDOW_TEXT = [[/5[- ]?hour/i, "five_hour"], [/weekly|7[- ]?day/i, "seven_day"]];
// Codex error code for a plan limit. UNVERIFIED: the name is not in any type definition in this repo.
const CODEX_LIMIT_INFO = "usageLimitExceeded";
// SDKRateLimitInfo.resetsAt is an epoch number. Its unit is UNVERIFIED: above 1e12 read as ms, else seconds.
// The window end is held to at least 5 minutes from now.
const MIN_WINDOW_MS = 5 * 60_000;
const MS_THRESHOLD = 1e12;

function limit(harness, { window = null, resetsAt = null, wording = false, verified, source }) {
  return { harness, window, windowName: window ? LIMIT_WINDOW_NAMES[window] ?? window : null, resetsAt, wording, verified, source };
}

// Window named in free text, e.g. "5-hour limit reached"; null when the text names none.
function windowFromText(text) {
  return WINDOW_TEXT.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function resetMs(value, now = Date.now()) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value > MS_THRESHOLD ? value : value * 1000;
  return Math.max(ms, now + MIN_WINDOW_MS);
}

// Overage that is allowed or in use: the request runs on overage credit, so the plan window did not block it (sdk.d.ts:6243-6246).
function onOverage(info) {
  return info.isUsingOverage === true || info.overageInUse === true || info.overageEnabled === true
    || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
}

function classifyClaude(event) {
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
      const details = event.error_details ?? "";
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

function classifyCodex(event) {
  if (event?.kind !== "turn_error") return null;
  // UNVERIFIED: the codexErrorInfo code, from Codex's app-server protocol (not in node_modules or docs/).
  if (event.codexErrorInfo === CODEX_LIMIT_INFO) return limit("codex", { window: windowFromText(event.message ?? ""), wording: true, verified: false, source: "UNVERIFIED codexErrorInfo usageLimitExceeded" });
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("codex", { window: windowFromText(event.message), wording: LIMIT_WORDING.test(event.message), verified: false, source: "UNVERIFIED turn error text" })
    : null;
}

function classifyOpenCode(event) {
  if (event?.kind !== "run_error") return null;
  // UNVERIFIED: OpenCode's provider error carries an HTTP status; runner/adapters/opencode.mjs does not forward it today.
  if (event.status === 429) return limit("opencode", { verified: false, source: "UNVERIFIED HTTP 429 from provider" });
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("opencode", { window: windowFromText(event.message), wording: LIMIT_WORDING.test(event.message), verified: false, source: "UNVERIFIED provider error text" })
    : null;
}

function classifyCursor(event) {
  if (event?.kind !== "run_error") return null;
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("cursor", { window: windowFromText(event.message), wording: LIMIT_WORDING.test(event.message), verified: false, source: "UNVERIFIED ACP error text" })
    : null;
}

/** The limit an event reports, {harness, window, windowName, resetsAt (ms|null), wording, verified, source}, or null. */
export function classifyLimit(harness, event) {
  switch (harness) {
    case "claude": return classifyClaude(event);
    case "codex": return classifyCodex(event);
    case "opencode": return classifyOpenCode(event);
    case "cursor": return classifyCursor(event);
    default: return null;
  }
}

/** The limit a runner RUN_ERROR reports: its message, and for Codex its metadata codexErrorInfo; the kind follows the adapter's error source. */
export function limitFromRunError(harness, message, metadata = {}) {
  const kind = harness === "claude" ? "result_error" : harness === "codex" ? "turn_error" : "run_error";
  return classifyLimit(harness, { kind, text: message, message, codexErrorInfo: metadata.codexErrorInfo });
}
