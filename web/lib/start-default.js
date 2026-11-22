// New-session draft: the configured harness and model when available, else the first available harness.

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
