// Pure helper: the muted detail shown after an agent's address in chat.

/** The model then the place, joined by a middle dot: "composer-2.5 · cursor-teams"; "" when neither is known. */
export function agentDetail(agent) {
  return [agent?.model, agent?.where].filter(Boolean).join(" · ");
}
