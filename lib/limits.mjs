// Subscription and usage-limit detection: classifies a harness error or event as a limit, or null.
// Typed sources: sdk.d.ts (Claude SDK 0.3.330). Text patterns are UNVERIFIED: no type or source here names them.

export const LIMIT_WINDOW_NAMES = {
  five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly overage", overage: "overage",
};
// UNVERIFIED: limit wording in a harness's error text. Matched only when no typed code exists.
const LIMIT_TEXT = /usage limit|plan limit|rate limit|quota|too many requests|\b429\b/i;
const WINDOW_TEXT = [[/5[- ]?hour/i, "five_hour"], [/weekly|7[- ]?day/i, "seven_day"]];
// Codex error code for a plan limit. UNVERIFIED: the name is not in any type definition in this repo.
const CODEX_LIMIT_INFO = "usageLimitExceeded";

function limit(harness, { window = null, resetsAt = null, verified, source }) {
  return { harness, window, windowName: window ? LIMIT_WINDOW_NAMES[window] ?? window : null, resetsAt, verified, source };
}

// Window named in free text, e.g. "5-hour limit reached"; null when the text names none.
function windowFromText(text) {
  return WINDOW_TEXT.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

// SDKRateLimitInfo.resetsAt: epoch number; its unit is UNVERIFIED, read here as seconds.
function resetMs(value) {
  return Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

function classifyClaude(event) {
  switch (event?.kind) {
    // sdk.d.ts:6224 SDKRateLimitEvent; status 'rejected' means the limit blocked the request (sdk.d.ts:6238).
    case "rate_limit_event": {
      const info = event.rate_limit_info;
      if (info?.status !== "rejected") return null;
      return limit("claude", {
        window: LIMIT_WINDOW_NAMES[info.rateLimitType] ? info.rateLimitType : null,
        resetsAt: resetMs(info.resetsAt), verified: true, source: "sdk.d.ts:6224 rate_limit_event",
      });
    }
    // sdk.d.ts:10502 StopFailureHookInput; error 'rate_limit' is in the enum at sdk.d.ts:3995. Also returns for API 429s, not only plan limits.
    case "stop_failure": {
      if (event.error !== "rate_limit") return null;
      return limit("claude", {
        window: windowFromText(event.error_details ?? ""), verified: true, source: "sdk.d.ts:10502 StopFailure error=rate_limit",
      });
    }
    // sdk.d.ts:6268 SDKResultError with is_error; the text match is UNVERIFIED.
    case "result_error":
      return LIMIT_TEXT.test(event.text ?? "")
        ? limit("claude", { window: windowFromText(event.text), verified: false, source: "UNVERIFIED result error text" })
        : null;
    default: return null;
  }
}

function classifyCodex(event) {
  if (event?.kind !== "turn_error") return null;
  // UNVERIFIED: the codexErrorInfo code, from Codex's app-server protocol (not in node_modules or docs/).
  if (event.codexErrorInfo === CODEX_LIMIT_INFO) return limit("codex", { window: windowFromText(event.message ?? ""), verified: false, source: "UNVERIFIED codexErrorInfo usageLimitExceeded" });
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("codex", { window: windowFromText(event.message), verified: false, source: "UNVERIFIED turn error text" })
    : null;
}

function classifyOpenCode(event) {
  if (event?.kind !== "run_error") return null;
  // UNVERIFIED: OpenCode's provider error carries an HTTP status; runner/adapters/opencode.mjs does not forward it today.
  if (event.status === 429) return limit("opencode", { verified: false, source: "UNVERIFIED HTTP 429 from provider" });
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("opencode", { window: windowFromText(event.message), verified: false, source: "UNVERIFIED provider error text" })
    : null;
}

function classifyCursor(event) {
  if (event?.kind !== "run_error") return null;
  return LIMIT_TEXT.test(event.message ?? "")
    ? limit("cursor", { window: windowFromText(event.message), verified: false, source: "UNVERIFIED ACP error text" })
    : null;
}

/** The limit an event reports, {harness, window, windowName, resetsAt (ms|null), verified, source}, or null. */
export function classifyLimit(harness, event) {
  switch (harness) {
    case "claude": return classifyClaude(event);
    case "codex": return classifyCodex(event);
    case "opencode": return classifyOpenCode(event);
    case "cursor": return classifyCursor(event);
    default: return null;
  }
}
