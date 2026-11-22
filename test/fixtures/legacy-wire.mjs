// Verbatim readers from main before the AG-UI migration.
export function parseEnvelope(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  return m && typeof m === "object" && m.v === 1 ? m : null;
}

export const MODES = ["on", "off", "quiet"];

export function parseMode(raw) {
  let m = raw;
  if (typeof raw === "string") {
    try { m = JSON.parse(raw); } catch { return null; }
  }
  if (!m || typeof m !== "object" || m.v !== 1 || m.kind !== "mode" || m.from !== "operator") return null;
  if (!MODES.includes(m.mode) || !Number.isSafeInteger(m.ts) || m.ts < 0) return null;
  return { mode: m.mode, ts: m.ts };
}

const QUESTION_TEXT = /^Question from ([^\n]+)\n\n[\s\S]+\n\nReply in this topic: reply ([a-f0-9]{12}) YOUR ANSWER$/;

/** An agent's ask_question post as {sender, id}, or null. */
export function parseQuestionText(text) {
  const match = QUESTION_TEXT.exec(text);
  return match ? { sender: match[1], id: match[2] } : null;
}
