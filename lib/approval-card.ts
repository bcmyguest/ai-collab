/**
 * Approval cards on the wire: question cleaning and the size fit every card goes through. A leaf module, so the
 * approval, question and limit-alert modules can share it without importing one another.
 */
import { encodeEnvelope } from "./agui.mjs";
import { MESSAGE_MAX_BYTES } from "./config.mjs";
import { stripControl } from "./format.ts";
// oxlint-disable-next-line typescript/no-explicit-any -- harness question JSON; each field is checked before use
type Json = any;

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface CleanQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

const QUESTION_MAX = 500;
const HEADER_MAX = 40;
const LABEL_MAX = 100;
const QUESTIONS_MAX = 4;
const OPTIONS_MAX = 6;
// Last resort: a summary longer than this is cut before the card is refused (a limit card lists every joined session).
const SUMMARY_FIT_MAX = 200;

export const text = (value: unknown, max: number): string => typeof value === "string" ? stripControl(value).slice(0, max) : "";

/** AskUserQuestion questions with every field type-checked and capped, or null when the shape is wrong. */
export function cleanQuestions(raw: unknown, { descriptionMax = 300, previewMax = 2000 }: { descriptionMax?: number; previewMax?: number } = {}): CleanQuestion[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > QUESTIONS_MAX) return null;
  const out: CleanQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q.question !== "string" || !q.question.trim() || !Array.isArray(q.options) || !q.options.length) return null;
    const options: QuestionOption[] = q.options.slice(0, OPTIONS_MAX).map((o: Json) => ({
      label: text(o?.label, LABEL_MAX),
      ...(descriptionMax && text(o?.description, descriptionMax) ? { description: text(o.description, descriptionMax) } : {}),
      ...(previewMax && text(o?.preview, previewMax) ? { preview: text(o.preview, previewMax) } : {}),
    }));
    if (options.some((o) => !o.label)) return null;
    out.push({ question: text(q.question, QUESTION_MAX), header: text(q.header, HEADER_MAX), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

function fitWith(kind: string, base: Record<string, unknown>, rawQuestions: unknown, wire: unknown): string | null {
  const tries: Array<[number, number]> = rawQuestions ? [[300, 2000], [200, 400], [100, 0], [0, 0]] : [[0, 0]];
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
export function fitApprovalEnvelope(kind: string, base: Record<string, unknown>, rawQuestions: unknown, wire: unknown): string | null {
  const fitted = fitWith(kind, base, rawQuestions, wire);
  if (fitted || typeof base.summary !== "string" || base.summary.length <= SUMMARY_FIT_MAX) return fitted;
  return fitWith(kind, { ...base, summary: `${base.summary.slice(0, SUMMARY_FIT_MAX - 1)}…` }, rawQuestions, wire);
}
