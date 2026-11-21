// Lazy shiki highlighter: the JavaScript regex engine (no WASM, so no 'wasm-unsafe-eval'), dual themes, languages on demand.
export const HIGHLIGHT_MAX_BYTES = 20 * 1024;
const LANGS = {
  javascript: () => import("shiki/langs/javascript.mjs"), typescript: () => import("shiki/langs/typescript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"), tsx: () => import("shiki/langs/tsx.mjs"), json: () => import("shiki/langs/json.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"), python: () => import("shiki/langs/python.mjs"),
  diff: () => import("shiki/langs/diff.mjs"), markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"), css: () => import("shiki/langs/css.mjs"), html: () => import("shiki/langs/html.mjs"),
};
const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", mts: "typescript", cts: "typescript",
  bash: "shellscript", sh: "shellscript", shell: "shellscript", zsh: "shellscript", console: "shellscript",
  py: "python", patch: "diff", md: "markdown", yml: "yaml", htm: "html", jsonc: "json", json5: "json",
};
const THEMES = { light: "github-light", dark: "github-dark" };
const loaded = new Map();
let core;

/** Shiki's language id for a fence name or file extension, or "" when outside the bundled set. */
export function languageOf(name) {
  const key = String(name || "").toLowerCase();
  const id = ALIASES[key] || key;
  return Object.hasOwn(LANGS, id) ? id : "";
}

function highlighter() {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")])
    .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
      createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() }));
  return core;
}

/** HTML for code in a supported language, or null: unknown language, over HIGHLIGHT_MAX_BYTES, or a load failure. */
export async function highlight(code, name) {
  const lang = languageOf(name);
  if (!lang || !code || new Blob([code]).size > HIGHLIGHT_MAX_BYTES) return null;
  try {
    const shiki = await highlighter();
    if (!loaded.has(lang)) loaded.set(lang, LANGS[lang]().then(mod => shiki.loadLanguage(mod.default)));
    await loaded.get(lang);
    return shiki.codeToHtml(code, { lang, themes: THEMES, defaultColor: "light" });
  } catch {
    return null;
  }
}
