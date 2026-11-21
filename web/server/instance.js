// Node loads the messaging server unbundled, so lib/*.mjs keeps its own module graph and optional imports.
export async function ui() {
  const { ui: instance } = await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ process.env.AI_COLLAB_UI_SERVER);
  return instance();
}
