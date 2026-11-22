// The sidebar's agent list: sessions that set an identity name, the PM first, then the rest alphabetically.
const PM = /^pm$/i;

/** The set_identity name of a session, or "" when it only has a harness title or a fallback name. */
export function agentName(agent) {
  return typeof agent?.identityName === "string" ? agent.identityName.trim() : "";
}

/** Sessions with a set_identity name, PM first, then by name; each opens its own direct chat. */
export function namedAgents(agents = []) {
  return agents.filter(agent => agentName(agent))
    .sort((a, b) => Number(PM.test(agentName(b))) - Number(PM.test(agentName(a))) || agentName(a).localeCompare(agentName(b)) || a.id.localeCompare(b.id));
}

/** The rest of the project's sessions, in the order the server sent them. */
export function unnamedAgents(agents = []) {
  return agents.filter(agent => !agentName(agent));
}
