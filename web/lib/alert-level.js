// The phone alert level, as the header shows it. The server file is the truth; this browser keeps its last choice so a
// deploy (which reloads every tab) never renders a stored level as "all" before the first state frame arrives.
export const ALERT_LEVELS = [["all", "All"], ["questions-and-direct", "Questions and direct replies"], ["questions", "Questions only"], ["none", "None"]];
export const ALERT_LEVEL_DEFAULT = "all";
const REMEMBERED_KEY = "ai-collab.alertLevel";
const LEVEL_IDS = ALERT_LEVELS.map(([id]) => id);

export function isAlertLevel(value) {
  return LEVEL_IDS.includes(value);
}

/** The level to show: the server's when it names one, else this browser's last choice, else the default. */
export function shownAlertLevel(server, remembered) {
  if (isAlertLevel(server)) return server;
  return isAlertLevel(remembered) ? remembered : ALERT_LEVEL_DEFAULT;
}

/** The browser's last chosen level, or undefined; a storage that throws (private mode, quota) reads as none. */
export function readRememberedAlertLevel(storage) {
  try {
    return storage?.getItem(REMEMBERED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a level across reloads; an unknown level or an unavailable storage is ignored. */
export function rememberAlertLevel(storage, level) {
  if (!isAlertLevel(level)) return;
  try {
    storage?.setItem(REMEMBERED_KEY, level);
  } catch { /* private mode or quota: the server still holds the level */ }
}

/**
 * Whether a push subscription was made with this VAPID key. A subscription from an older key can never be delivered to,
 * so a reload must replace it instead of resending it and showing notifications as on.
 */
export function subscriptionUsesKey(subscription, key) {
  const own = subscription?.options?.applicationServerKey;
  if (!own) return true; // some browsers hide the key; assume the subscription still matches
  const current = new Uint8Array(own);
  return current.length === key.length && current.every((byte, i) => byte === key[i]);
}
