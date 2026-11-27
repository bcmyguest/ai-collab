// Portions © 2026 T3 Tools Inc., MIT License, from pingdotgg/t3code@452d8f0 packages/provider-acp/src/server/adapter.ts and packages/provider-acp/src/server/elicitationForm.ts
// ACP session/request_permission: which option answers a decision, and the requests that are questions in disguise.

export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";
export interface PermissionOption { optionId: string; name?: string; kind: PermissionKind | string }
export interface PermissionToolCall { toolCallId?: string; title?: string | null; kind?: string | null; content?: unknown; rawInput?: unknown }
export interface PermissionRequest { sessionId?: string; toolCall?: PermissionToolCall; options?: PermissionOption[] }
/** accept: allow once; acceptForSession: allow for the rest of the session; decline: reject once. */
export type PermissionDecision = "accept" | "acceptForSession" | "decline";

/** A question card: the AskUserQuestion shape the runner publishes, and the optionId each label answers with. */
export interface PermissionQuestion {
  question: { question: string; header: string; multiSelect: false; options: Array<{ label: string }> };
  optionIds: Map<string, string>;
  skipOptionId?: string;
}

// Cursor's ask_question fallback when the client does not serve `cursor/ask_question`: one allow_once per choice, then this skip.
export const CURSOR_SKIP_OPTION_ID = "__ask_question_skip__";
// The card limits in lib/approval-card.ts, applied here so the label an answer names is the one mapped below.
const HEADER_MAX = 40;
const QUESTION_MAX = 500;
const LABEL_MAX = 100;

/** The option that answers decision; undefined when the agent offers none of that kind. */
export function selectPermissionOptionId(request: PermissionRequest, decision: PermissionDecision): string | undefined {
  const optionIdOfKind = (kind: PermissionKind) => request.options?.find((option) => option.kind === kind)?.optionId;
  if (decision === "acceptForSession") {
    // Agents may offer only allow_once, and answering "cancelled" would stop the turn the user approved.
    return optionIdOfKind("allow_always") ?? optionIdOfKind("allow_once");
  }
  return optionIdOfKind(decision === "accept" ? "allow_once" : "reject_once");
}

/** The key an "always for this session" grant covers: the tool kind, or the title for a kind as broad as `other` (one MCP tool, not every one). */
export function grantKey(toolCall: PermissionToolCall | undefined): string {
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind : "";
  const title = typeof toolCall?.title === "string" ? toolCall.title : "";
  return kind && kind !== "other" ? `kind:${kind}` : `title:${title}`;
}

// The first text block of a tool call's content, where Cursor puts the question prompt.
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    const text = block?.type === "content" ? block.content?.text : block?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

// Unique labels for the choices: trimmed names, quoted with JSON when two collide or one is blank (as elicitationForm enumOptions).
function uniqueLabels(names: string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.trim(), (counts.get(name.trim()) ?? 0) + 1);
  const labels = names.map((name) => (name.trim() !== "" && counts.get(name.trim()) === 1 ? name.trim() : JSON.stringify(name)));
  return new Set(labels).size === labels.length ? labels : names.map((name) => JSON.stringify(name));
}

/**
 * The question a permission request carries, or null for a plain tool approval. A request is a question when it has
 * Cursor's skip option, or more than one allow_once option and no allow_always (a tool approval allows one way).
 */
export function permissionQuestion(request: PermissionRequest): PermissionQuestion | null {
  const options = request.options ?? [];
  const skip = options.find((o) => o.optionId === CURSOR_SKIP_OPTION_ID);
  const choices = options.filter((o) => o.kind === "allow_once" && o !== skip);
  const shaped = skip !== undefined || (choices.length > 1 && !options.some((o) => o.kind === "allow_always"));
  if (!shaped || !choices.length) return null;
  const toolCall = request.toolCall ?? {};
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  const prompt = contentText(toolCall.content) || title;
  if (!prompt) return null;
  const labels = uniqueLabels(choices.map((o) => (typeof o.name === "string" && o.name ? o.name : o.optionId).slice(0, LABEL_MAX)));
  const optionIds = new Map(labels.map((label, i) => [label, choices[i].optionId]));
  const header = (title && title !== prompt ? title : "Question").slice(0, HEADER_MAX);
  return {
    question: { question: prompt.slice(0, QUESTION_MAX).trim(), header, multiSelect: false, options: labels.map((label) => ({ label })) },
    optionIds,
    ...(skip ? { skipOptionId: skip.optionId } : {}),
  };
}

/** The optionId the operator's answers pick for this question, or undefined when they name no listed label. */
export function answerOptionId(question: PermissionQuestion, answers: Record<string, string> | undefined): string | undefined {
  const label = answers?.[question.question.question];
  return typeof label === "string" ? question.optionIds.get(label.trim()) : undefined;
}
