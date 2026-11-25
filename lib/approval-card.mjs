/**
 * Approval cards on the wire: question cleaning and the size fit every card goes through. A leaf module, so the
 * approval, question and limit-alert modules can share it without importing one another.
 */
import { encodeEnvelope } from "./agui.mjs";
import { MESSAGE_MAX_BYTES } from "./config.mjs";
import { stripControl } from "./format.mjs";

const QUESTION_MAX = 500;
const HEADER_MAX = 40;
const LABEL_MAX = 100;
const QUESTIONS_MAX = 4;
const OPTIONS_MAX = 6;
// Last resort: a summary longer than this is cut before the card is refused (a limit card lists every joined session).
const SUMMARY_FIT_MAX = 200;

export const text = (value, max) => typeof value === "string" ? stripControl(value).slice(0, max) : "";

/** AskUserQuestion questions with every field type-checked and capped, or null when the shape is wrong. */
export function cleanQuestions(raw, { descriptionMax = 300, previewMax = 2000 } = {}) {
  if (!Array.isArray(raw) || !raw.length || raw.length > QUESTIONS_MAX) return null;
  const out = [];
  for (const q of raw) {
    if (!q || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) || !q.options.length) return null;
    const options = q.options.slice(0, OPTIONS_MAX).map((o) => ({
      label: text(o?.label, LABEL_MAX),
      ...(descriptionMax && text(o?.description, descriptionMax) ? { description: text(o.description, descriptionMax) } : {}),
      ...(previewMax && text(o?.preview, previewMax) ? { preview: text(o.preview, previewMax) } : {}),
    }));
    if (options.some((o) => !o.label)) return null;
    out.push({ question: text(q.question, QUESTION_MAX), header: text(q.header, HEADER_MAX), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

function fitWith(kind, base, rawQuestions, wire) {
  const tries = rawQuestions ? [[300, 2000], [200, 400], [100, 0], [0, 0]] : [[0, 0]];
  for (const [descriptionMax, previewMax] of tries) {
    const questions = rawQuestions ? cleanQuestions(rawQuestions, { descriptionMax, previewMax }) : undefined;
    const message = encodeEnvelope(kind, questions ? { ...base, questions } : base, wire);
    if (Buffer.byteLength(message) <= MESSAGE_MAX_BYTES) return message;
  }
  return null;
}

/**
 * An envelope of `kind` within MESSAGE_MAX_BYTES: long choice previews and descriptions shrink first, then the
 * summary; null if it still cannot fit.
 */
export function fitApprovalEnvelope(kind, base, rawQuestions, wire) {
  const fitted = fitWith(kind, base, rawQuestions, wire);
  if (fitted || typeof base.summary !== "string" || base.summary.length <= SUMMARY_FIT_MAX) return fitted;
  return fitWith(kind, { ...base, summary: `${base.summary.slice(0, SUMMARY_FIT_MAX - 1)}…` }, rawQuestions, wire);
}
