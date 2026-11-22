// New-session defaults from the configured startDefault: the old @harness:model prefill, and the picker's opening choice.

/** The models one harness lists, dropping anything that is not a name. */
export const modelsOf = (models, harness) => (Array.isArray(models?.[harness]) ? models[harness].filter(id => typeof id === "string" && id) : []);

/** "@harness:model " for the configured default, "@harness " for the first available harness, or "" when none can start. */
export function startDefaultDraft({ startable = [], models = {}, setting = {} }) {
  const { harness, model } = setting;
  if (startable.includes(harness)) {
    // Models not loaded yet: keep the configured default; once loaded, it must list the model.
    const known = Array.isArray(models[harness]) ? models[harness] : null;
    if (!known || known.includes(model)) return `@${harness}:${model} `;
  }
  return startable.length ? `@${startable[0]} ` : "";
}

/**
 * What the new-agent dialogue opens on: the configured harness and model when that harness can start here and lists
 * the model (or has not loaded yet), else the first startable harness with its first listed model. The harness is
 * carried by this choice, so the picker needs no @tag typed into the prompt.
 */
export function initialChoice({ startable = [], models = {}, setting = {} }) {
  const first = harness => modelsOf(models, harness)[0] || "";
  const harness = typeof setting?.harness === "string" ? setting.harness : "";
  const model = typeof setting?.model === "string" ? setting.model : "";
  if (startable.includes(harness)) {
    // Models not loaded yet: keep the configured model; once loaded, the harness must list it.
    const known = Array.isArray(models?.[harness]);
    if (!model) return { harness, model: first(harness) };
    if (!known || models[harness].includes(model)) return { harness, model };
    return { harness, model: first(harness) };
  }
  const fallback = startable[0] || "";
  return { harness: fallback, model: fallback ? first(fallback) : "" };
}
