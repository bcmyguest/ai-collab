// Fenced code blocks in chat markdown carry a copy button that copies the raw code.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { codeText, copyText } from "../web/lib/copy-text.ts";
import { cn } from "../web/lib/utils.js";

const require = createRequire(import.meta.url);
await swc.loadBindings();

async function load(file, syntax, dependencies) {
  const parser = syntax === "typescript" ? { syntax, tsx: true } : { syntax, jsx: true };
  const { code } = await swc.transform(readFileSync(new URL(file, import.meta.url), "utf8"), {
    jsc: { parser, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const exports = {};
  new Function("require", "exports", code)(id => dependencies[id] ?? require(id), exports);
  return exports;
}

const { CopyButton } = await load("../web/components/ui/copy-button.tsx", "typescript", {
  "@/components/ui/button": { buttonVariants: () => "btn" },
  "@/lib/utils": { cn },
  "@/lib/copy-text": { copyText },
});
const { MARKDOWN_COMPONENTS } = await load("../web/components/ui/markdown.jsx", "ecmascript", {
  "@/lib/utils": { cn },
  "@/lib/task-tags": { remarkTaskLinks: () => {} },
  "@/lib/copy-text": { codeText },
  "./code-block": {
    CodeBlock: ({ children }) => createElement("div", null, children),
    CodeBlockGroup: ({ children }) => createElement("div", null, children),
    CodeBlockCode: ({ code }) => createElement("pre", null, code),
  },
  "./copy-button": { CopyButton: ({ text }) => createElement("button", { "data-copy": text }) },
});

function fakeDocument({ copies = true } = {}) {
  const calls = { appended: [], removed: 0, commands: [] };
  const area = { style: {}, select() { calls.selected = this.value; }, remove() { calls.removed++; } };
  return {
    calls,
    document: {
      body: { append: node => calls.appended.push(node) },
      createElement: tag => { calls.tag = tag; return area; },
      execCommand: command => { calls.commands.push(command); return copies; },
    },
  };
}

test("every fenced block gets a copy button with the raw code; inline code gets none", () => {
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { components: MARKDOWN_COMPONENTS },
    "Run `npm test` first.\n\n```bash\nnpm run build\necho \"done\"\n```\n\n```\nplain\n```\n"));
  const copies = [...html.matchAll(/data-copy="([^"]*)"/g)].map(match => match[1]);
  assert.deepEqual(copies, ["npm run build\necho &quot;done&quot;", "plain"]);
});

test("the copy button is a labelled native button visible without hover", () => {
  const html = renderToStaticMarkup(createElement(CopyButton, { text: "x" }));
  const button = html.match(/<button[^>]*>/)?.[0] ?? "";
  assert.match(button, /type="button"/);
  assert.match(button, /aria-label="Copy code"/);
  assert.doesNotMatch(html, /opacity-0|group-hover/);
  assert.match(html, /role="status"[^>]*aria-live="polite"/);
});

test("codeText drops only the newline that closes the fence", () => {
  assert.equal(codeText("a\n\n"), "a\n");
  assert.equal(codeText(["a", "b\n"]), "ab");
  assert.equal(codeText(undefined), "");
});

test("copyText uses the async clipboard in a secure context", async () => {
  const written = [];
  const { document, calls } = fakeDocument();
  const ok = await copyText("ls -la", { isSecureContext: true, document,
    navigator: { clipboard: { writeText: async text => { written.push(text); } } } });
  assert.equal(ok, true);
  assert.deepEqual(written, ["ls -la"]);
  assert.deepEqual(calls.commands, []);
});

test("copyText falls back to execCommand on a plain-http page and removes its textarea", async () => {
  const { document, calls } = fakeDocument();
  const ok = await copyText("ls -la", { isSecureContext: false, document, navigator: {} });
  assert.equal(ok, true);
  assert.equal(calls.tag, "textarea");
  assert.equal(calls.selected, "ls -la");
  assert.deepEqual(calls.commands, ["copy"]);
  assert.equal(calls.removed, 1);
});

test("copyText falls back when the clipboard rejects, and reports a failed copy", async () => {
  const { document, calls } = fakeDocument({ copies: false });
  const ok = await copyText("x", { isSecureContext: true, document,
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } } });
  assert.equal(ok, false);
  assert.deepEqual(calls.commands, ["copy"]);
  assert.equal(calls.removed, 1);
  assert.equal(await copyText("x", {}), false);
});
