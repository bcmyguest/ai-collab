import { taskTags } from "./task-tags.js";

const MENTION = /(^|[^\w#-])@([a-z0-9-]{1,24}(?:#[a-f0-9]{16}(?:\/[A-Za-z0-9_-]{1,64})?|:[A-Za-z0-9][A-Za-z0-9._/-]{0,119})?)(?![\w-])/g;

/** Session addresses, subagent runs (@session/run), harness names and harness:model pairs tagged with @ in a post, limited to the project's peers. */
export function mentionedNames(body, peers = [], teams = []) {
  // A full stop after @harness:model ends the sentence, not the model name.
  const teamSet = new Set(teams);
  const names = new Set([...String(body).matchAll(MENTION)].map(match => match[2].replace(/\.+$/, "")));
  return [...names].filter(name => {
    if (teamSet.has(name)) return false;
    const peer = name.split(/[#:]/)[0];
    return peer !== "operator" && peer !== "all" && (!peers.length || peers.includes(peer));
  });
}

/**
 * True when a post addresses only the sessions its tags start: at least one @harness:model tag, every tag a model start,
 * and no team or pattern tagged. Such a post must not reach, or wake, a session that is already running.
 */
export function startOnlyMentions(body, peers = [], otherNames = []) {
  const names = mentionedNames(body, peers, otherNames);
  return names.length > 0 && names.every((name) => name.includes(":")) && !otherNames.some((name) => mentions(body, name));
}

/** Team names tagged with @ in a post. */
export function mentionedTeams(body, teams = []) {
  return teams.filter((name) => mentions(body, name));
}

export const mentions = (body, name) => new RegExp(`(^|[^\\w#-])@${name}(?![\\w-])`).test(body);

export function messageDestinations(text, target, listTasks) {
  const ids = new Set(taskTags(text).map(match => match[2]));
  const tagged = ids.size && listTasks ? listTasks().filter(task => ids.has(task.id)) : [];
  return { tagged, destinations: new Set(tagged.length ? tagged.map(task => task.owner || "all") : [target]) };
}

export function composerDestination({
  project, target, text, tasks, peers, agents, teams, patterns, startable, models, hosted, quoted,
}) {
  if (!target) return "Pick a session first";
  const { destinations } = messageDestinations(text, target, () =>
    tasks.map(task => task.inferredOwner ? { ...task, owner: "" } : task));
  const names = [...teams.map(team => team.id), ...patterns.map(pattern => pattern.name)];
  const [primary] = destinations;
  const startOnly = !hosted && !quoted && destinations.size === 1 && destinations.has("all")
    && startOnlyMentions(text, peers, names);
  const shortAddress = address => address.replace(/(#[a-f0-9]{8})[a-f0-9]{8}(?=\/|$)/, "$1");
  const direct = new Set([...destinations].filter(to => to !== "all"));
  const starts = [];
  if (!hosted) {
    const sessions = agents.filter(agent => agent.registered);
    for (const name of mentionedNames(text, peers, names)) {
      if (name === primary) continue;
      if (name.includes(":")) {
        const [harness, model] = name.split(":");
        if (startable.includes(harness) && models[harness]?.includes(model)) starts.push(name);
      } else if (name.includes("#")) {
        if (sessions.some(agent => agent.id === name.split("/")[0])) direct.add(name);
      } else {
        const running = sessions.filter(agent => agent.peer === name && agent.online);
        for (const agent of running) direct.add(agent.id);
        if (!running.length && !sessions.some(agent => agent.peer === name && destinations.has(agent.id))
          && startable.includes(name)) starts.push(name);
      }
    }
  }
  const labels = [];
  if (destinations.has("all")) labels.push(startOnly ? "Project chat in " + project : "Everyone in " + project);
  if (direct.size) labels.push("Direct to " + [...direct].map(shortAddress).join(", "));
  if (starts.length) labels.push("Start " + starts.join(", "));
  if (!hosted) {
    const invocations = mentionedTeams(text, patterns.filter(pattern => !pattern.legacy).map(pattern => pattern.name));
    if (primary === "all" && startable.includes("claude")) {
      invocations.push(...mentionedTeams(text, teams.map(team => team.id)));
    }
    if (invocations.length) labels.push("Run " + [...new Set(invocations)].join(", "));
  }
  return labels.join(" · ");
}
