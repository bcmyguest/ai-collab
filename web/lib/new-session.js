// Choices behind the new-agent composer: the model menu grouped by harness, the mode pill, the place pill.
// The harness is carried by the model choice, so nothing about it is typed into the prompt.
import { fuzzyRank } from "./fuzzy.js";
import { MODE_LABELS, startModes } from "./start-mode.js";
import { modelsOf } from "./start-default.js";

export const HARNESS_LABELS = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
/** The place pill's short label, and the full name its menu and aria-label use. */
export const PLACE_LABELS = { folder: "Folder", worktree: "Worktree", openshell: "OpenShell" };
export const PLACE_NAMES = { folder: "Local folder", worktree: "New git worktree", openshell: "OpenShell sandbox" };

/** After the harness changes: its listed model stays if it has one, else its first model. */
export function chooseHarness(choice, harness, models = {}) {
  if (choice?.harness === harness) return choice;
  const listed = modelsOf(models, harness);
  return { harness, model: listed.includes(choice?.model) ? choice.model : listed[0] || "" };
}

/** A mode the harness supports, or its first one; "agent" when the harness names none. */
export function modeChoice(mode, harness) {
  const modes = startModes(harness);
  return modes.includes(mode) ? mode : modes[0] || "agent";
}

/** The mode pill's menu: only modes the harness supports, labelled Agent / Ask / Plan. */
export function modeOptions(harness) {
  return startModes(harness).map(id => ({ id, label: MODE_LABELS[id] || id }));
}

/** The place pill's menu: only the places the server says this project can start in. */
export function placeOptions(places = []) {
  return places.map(id => ({ id, label: PLACE_LABELS[id] || id, name: PLACE_NAMES[id] || id }));
}

/** What the model pill shows: the model, or its harness name while no model has loaded. */
export function modelLabel(choice) {
  return choice?.model || HARNESS_LABELS[choice?.harness] || "Model";
}

/**
 * The model menu, grouped by harness: every startable harness with a loaded model list, in the order given. A query
 * filters across groups by the model name, its harness label and its harness id; an empty query lists everything.
 */
export function modelGroups({ startable = [], models = {}, query = "", limit = 300 } = {}) {
  const all = startable.flatMap(harness => modelsOf(models, harness).map(model => ({ harness, model })));
  const text = String(query || "").trim();
  const ranked = text ? fuzzyRank(text, all, item => [item.model, HARNESS_LABELS[item.harness], item.harness], limit) : all.slice(0, limit);
  const groups = [];
  for (const item of ranked) {
    const group = groups.find(entry => entry.harness === item.harness);
    if (group) group.models.push(item.model);
    else groups.push({ harness: item.harness, label: HARNESS_LABELS[item.harness] || item.harness, models: [item.model] });
  }
  return groups;
}

/** The groups flattened in menu order, for keyboard selection. */
export function flatModels(groups) {
  return groups.flatMap(group => group.models.map(model => ({ harness: group.harness, model })));
}

/** The row a keyboard move lands on, wrapping past either end; 0 for an empty list. */
export function moveActive(active, delta, length) {
  if (length <= 0) return 0;
  return (((active + delta) % length) + length) % length;
}

/** The model Enter picks at the keyboard position, or null when the menu lists nothing. */
export function activeModel(listed, active) {
  if (!listed.length) return null;
  return listed[Math.min(Math.max(active, 0), listed.length - 1)];
}
