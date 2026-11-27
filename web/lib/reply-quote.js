// A reply whose message id the server cannot accept goes out as plain text quoting the original's ends.
export const REPLY_QUOTE_WORDS = 6;
// quotedReply's output: "Replying to <sender>: “<quote>”", or "Replying to <sender>:", then a blank line and the reply.
const QUOTED_REPLY = /^Replying to ([^\n]+?):(?: “([^\n]*)”)?\n\n([\s\S]*)$/;

/** The quoted original on one line: its first and last REPLY_QUOTE_WORDS words, joined by … when words were left out. */
export function quoteEnds(body, words = REPLY_QUOTE_WORDS) {
  const list = String(body || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (list.length <= words * 2) return list.join(" ");
  return list.slice(0, words).join(" ") + " … " + list.slice(-words).join(" ");
}

/** True for a message id the server's replyTo check accepts: 1-64 letters, digits and dashes. */
export function usableReplyId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(id);
}

/**
 * The text to send instead of a reply the server refuses: the reply body with the original quoted above it.
 * The quote names the sender and keeps the original's first and last words, so the reader sees what it answers.
 */
export function quotedReply(body, { sender = "", body: original = "" } = {}) {
  const text = String(body || "").trim();
  const quote = quoteEnds(original);
  if (!quote) return sender ? "Replying to " + sender + ":\n\n" + text : text;
  return "Replying to " + (sender || "the original") + ": “" + quote + "”\n\n" + text;
}

/** A body quotedReply wrote, split back into the quoted original {sender, body} and the reply text; null for any other body. */
export function splitQuotedReply(text) {
  const found = QUOTED_REPLY.exec(String(text || ""));
  return found ? { quote: { sender: found[1], body: found[2] || "" }, body: found[3] } : null;
}
