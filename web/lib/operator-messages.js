// Operator chat messages for terminal prompts and for answers to agent questions.

// A typed prompt within this many seconds of an operator message with the same text is that message echoed back.
export const ECHO_WINDOW_S = 300;

const peerOf = address => String(address || "").split("#")[0];

// A sent message reaches the prompt's session: addressed to it, its peer, or all.
const reaches = (message, agent) => !message.to || message.to === agent || message.to === peerOf(agent) || message.to === "all";

/** Terminal prompts as operator messages, minus those echoing an operator message in sent. */
export function terminalMessages(prompts, sent) {
  const operator = sent.filter(message => message.from === "operator");
  return prompts
    .filter(item => !operator.some(message => message.body.trim() === item.input.trim() && reaches(message, item.agent) && Math.abs(message.time - item.time) <= ECHO_WINDOW_S))
    .map(item => ({ id: item.id, time: item.time, kind: "Message", sender: "operator", from: "operator", to: item.agent, body: item.input, terminal: true }));
}

/** The text of an operator answer: the chosen labels, the decision, or the typed reply when no decision applies. */
export function answerText(decision, typed) {
  if (!decision) return typed;
  if (decision.answers) return Object.values(decision.answers).join(", ");
  return decision.behavior;
}

/** An operator answer as a chat message to the asking session, linked to its question by replyTo. */
export function answerMessage({ id, time, asker, question, body, by }) {
  return { id, time, kind: "Message", sender: "operator", from: "operator", to: asker, body, replyTo: question, ...(by ? { by } : {}) };
}
