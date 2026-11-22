// A2UI operations for approval and question cards, and the mapping of a surface action back to an answer.
// Protocol v0.9.1: @a2ui/react 0.15.0 accepts v0.9 and v0.9.1 only; no v1.0 renderer exists yet.
export const A2UI_ACTIVITY = "a2ui-surface";
export const A2UI_VERSION = "v0.9.1";
export const A2UI_CATALOG_ID = "urn:ai-collab:a2ui:catalog:1";
const ENDED = {
  allowed: "Allowed from the phone", denied: "Denied from the phone", answered: "Answered from the phone",
  timeout: "Timed out: the terminal prompt took over", "afk-off": "AFK turned off: the terminal prompt took over",
  cancelled: "Closed: answered in the terminal or the agent stopped", terminal: "Answered in the terminal",
};
export const IN_TERMINAL = "Answer in the terminal";
const HEX12 = /^[a-f0-9]{12}$/;

/** Outcome line for an approval: its end reason, "sent", or expiry; "" while it waits for an answer. */
export function approvalOutcome(approval, now) {
  if (ENDED[approval.state]) return ENDED[approval.state];
  if (approval.expiresAt && approval.expiresAt < now) return approval.decision ? "Expired before the agent read the answer" : "Expired: answered in the terminal or timed out";
  if (approval.state === "sent") return approval.decision === "deny" ? "Deny sent, waiting for the agent" : "Answer sent, waiting for the agent";
  return "";
}

export const approvalSurfaceId = id => "approval-" + id;
export const questionSurfaceId = question => "question-" + question;

const op = (kind, body) => ({ version: A2UI_VERSION, [kind]: body });
const text = (id, value) => ({ id, component: "Text", text: value });
const column = (id, children) => ({ id, component: "Column", children });
const button = (id, label, variant, name, context, checks) => [
  { id, component: "Button", child: id + "-label", variant, action: { event: { name, context } }, ...(checks ? { checks } : {}) },
  text(id + "-label", label),
];
// A question is answered when its picks or its Other text is non-empty; Submit stays disabled until all are.
const answered = i => ({ call: "or", args: { values: [
  { call: "required", args: { value: { path: `/picks/${i}` } } },
  { call: "required", args: { value: { path: `/other/${i}` } } },
] }, returnType: "boolean" });
const withBy = (outcome, by) => outcome + (by ? " · " + by : "");

// createSurface, then the components, then the data model the components bind to.
function surfaceOps(surfaceId, components, model) {
  return [
    op("createSurface", { surfaceId, catalogId: A2UI_CATALOG_ID }),
    op("updateComponents", { surfaceId, components }),
    op("updateDataModel", { surfaceId, path: "/", value: model }),
  ];
}

// A closed request shows a muted badge: "answered" when someone answered it, else "closed"; none while open.
const ANSWERED = ["allowed", "denied", "answered", "sent"];
const badgeOf = (approval, open) => open ? "" : ANSWERED.includes(approval.state) ? "answered" : "closed";
// The title line, with the badge beside it when closed; pushes its components and returns the child ids.
function titleRow(components, title, badge) {
  components.push(text("title", title));
  if (!badge) return ["title"];
  components.push({ id: "badge", component: "Chip", text: badge, tone: "muted" });
  components.push({ id: "heading", component: "Row", children: ["title", "badge"], justify: "spaceBetween", align: "center" });
  return ["heading"];
}

// Permission request: tool line and summary, then Allow and Deny while open, else the terminal note or the outcome.
function permissionOps(approval, open, outcome, terminal) {
  const components = [column("root", [])];
  const children = titleRow(components, "Permission · " + approval.tool, badgeOf(approval, open));
  if (approval.summary) { components.push(text("summary", approval.summary)); children.push("summary"); }
  if (open && !terminal) {
    components.push({ id: "actions", component: "Row", children: ["allow", "deny"], justify: "end" });
    components.push(...button("allow", "Allow", "primary", "decide", { id: approval.id, decision: "allow" }));
    components.push(...button("deny", "Deny", "default", "decide", { id: approval.id, decision: "deny" }));
    children.push("actions");
  } else {
    components.push(text("status", open ? IN_TERMINAL : withBy(outcome, approval.by)));
    children.push("status");
  }
  components[0].children = children;
  return surfaceOps(approvalSurfaceId(approval.id), components, {});
}

// AskUserQuestion: per question a header chip, step, question, OptionPicker with the Other field as its last row; read-only once closed.
function choiceOps(approval, open, outcome, terminal) {
  const interactive = open && !terminal;
  const count = approval.questions.length;
  const components = [column("root", [])];
  const rootChildren = titleRow(components, count > 1 ? count + " questions" : "Question", badgeOf(approval, open));
  approval.questions.forEach((q, i) => {
    const group = "q" + i;
    const children = [];
    if (i > 0) { components.push({ id: group + "-rule", component: "Divider" }); rootChildren.push(group + "-rule"); }
    const top = [];
    if (q.header) { components.push({ id: group + "-chip", component: "Chip", text: q.header }); top.push(group + "-chip"); }
    if (count > 1) { components.push({ id: group + "-step", component: "Text", variant: "caption", text: `${i + 1} of ${count}` }); top.push(group + "-step"); }
    if (top.length) { components.push({ id: group + "-top", component: "Row", children: top, justify: "spaceBetween", align: "center" }); children.push(group + "-top"); }
    components.push(text(group + "-text", q.question));
    children.push(group + "-text");
    const options = q.options.map(o => ({
      label: o.label, value: o.label,
      ...(o.description ? { description: o.description } : {}), ...(o.preview ? { preview: o.preview } : {}),
    }));
    const multiSelect = q.multiSelect === true;
    if (interactive) {
      components.push({ id: group + "-pick", component: "OptionPicker", options, multiSelect, value: { path: `/picks/${i}` }, other: { path: `/other/${i}` }, otherChild: group + "-other" });
      components.push({ id: group + "-other", component: "TextField", label: "Other…", value: { path: `/other/${i}` } });
      children.push(group + "-pick");
    } else {
      const answer = String(approval.answers?.[q.question] ?? "");
      const chosen = answer ? answer.split(", ") : [];
      components.push({ id: group + "-pick", component: "OptionPicker", options, multiSelect, readOnly: true, value: chosen });
      children.push(group + "-pick");
      if (chosen.some(label => !q.options.some(o => o.label === label))) {
        components.push(text(group + "-answer", "Answer: " + answer));
        children.push(group + "-answer");
      }
    }
    components.push(column(group, children));
    rootChildren.push(group);
  });
  if (interactive) {
    const every = approval.questions.map((_, i) => answered(i));
    const condition = every.length === 1 ? every[0] : { call: "and", args: { values: every }, returnType: "boolean" };
    const checks = [{ condition, message: "Answer every question" }];
    components.push(...button("submit", "Submit", "primary", "answer", { id: approval.id, picks: { path: "/picks" }, other: { path: "/other" } }, checks));
    components.push({ id: "footer", component: "Row", children: ["submit"], justify: "end" });
    rootChildren.push("footer");
  } else {
    components.push(text("status", open ? IN_TERMINAL : withBy(outcome, approval.by)));
    rootChildren.push("status");
  }
  components[0].children = rootChildren;
  const model = { picks: approval.questions.map(() => []), other: approval.questions.map(() => "") };
  return surfaceOps(approvalSurfaceId(approval.id), components, model);
}

/** Operations for an approval (permission request or AskUserQuestion choice), with the outcome the chat card shows. */
export function approvalOperations(approval, now) {
  const outcome = approvalOutcome(approval, now);
  const open = !outcome;
  const terminal = approval.terminal === true;
  return approval.questions ? choiceOps(approval, open, outcome, terminal) : permissionOps(approval, open, outcome, terminal);
}

/** Operations for an ask_question post: its body, then an answer field, or the answer once given. */
export function questionOperations(question, body, answer, by) {
  const components = [column("root", []), text("body", body)];
  const children = ["body"];
  if (answer) {
    components.push(text("status", "Answered: " + answer + (by ? " · " + by : "")));
    children.push("status");
  } else {
    components.push({ id: "answer", component: "TextField", label: "Your answer…", value: { path: "/answer" } });
    components.push(...button("submit", "Submit", "primary", "reply", { question, answer: { path: "/answer" } }));
    children.push("answer", "submit");
  }
  components[0].children = children;
  return surfaceOps(questionSurfaceId(question), components, { answer: "" });
}

/** Surface id and operations for a chat entry shown as a card, or null for any other entry. */
export function surfaceOf(entry, now = Date.now()) {
  if (entry?.kind === "Approval" && entry.approval && HEX12.test(entry.approval.id)) {
    return { id: approvalSurfaceId(entry.approval.id), operations: approvalOperations(entry.approval, now) };
  }
  if (entry?.kind === "Question" && HEX12.test(entry.question || "")) {
    return { id: questionSurfaceId(entry.question), operations: questionOperations(entry.question, String(entry.body ?? ""), entry.answer, entry.answeredBy) };
  }
  return null;
}

const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");

/**
 * The answer a surface action carries: a permission decision, picks and Other text for a choice, or a question reply.
 * Null when the action matches no surface this module builds.
 */
export function surfaceAnswer(userAction) {
  const context = userAction?.context;
  if (!context || typeof context !== "object" || Array.isArray(context) || typeof userAction.surfaceId !== "string") return null;
  if (typeof context.id === "string" && HEX12.test(context.id) && userAction.surfaceId === approvalSurfaceId(context.id)) {
    if (userAction.name === "decide" && ["allow", "deny"].includes(context.decision)) return { kind: "approval", id: context.id, decision: context.decision };
    if (userAction.name === "answer" && Array.isArray(context.picks) && context.picks.every(strings) && strings(context.other)) {
      return { kind: "approval", id: context.id, picks: context.picks, other: context.other };
    }
    return null;
  }
  if (userAction.name === "reply" && typeof context.question === "string" && HEX12.test(context.question)
      && userAction.surfaceId === questionSurfaceId(context.question) && typeof context.answer === "string") {
    return { kind: "question", question: context.question, body: context.answer };
  }
  return null;
}

/**
 * The answers object a choice reply sends, keyed by question text as AskUserQuestion expects.
 * A typed Other answer replaces the picks of a single-select question, as the chat card does.
 */
export function choiceAnswers(questions, picks, other) {
  return Object.fromEntries(questions.map((q, i) => {
    const typed = typeof other[i] === "string" ? other[i].trim() : "";
    const chosen = Array.isArray(picks[i]) ? picks[i] : [];
    const values = q.multiSelect ? [...chosen, ...(typed ? [typed] : [])] : typed ? [typed] : chosen;
    return [q.question, values.join(", ")];
  }));
}
