// A question card in the chat leaves the agent's name to the message header above it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement, createContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const plain = ({ children }) => createElement("span", null, children);
const card = kind => function Card({ head }) { return createElement("section", { "data-card": kind }, head ?? "no head"); };
const dependencies = {
  "@assistant-ui/react": { MessagePrimitive: { Root: ({ children }) => createElement("div", null, children), Content: () => null } },
  "lucide-react": new Proxy({}, { get: () => () => null }),
  "@/components/ui/badge": { Badge: plain },
  "@/components/chat/thread": { BubbleContext: createContext(null), BubbleText: plain },
  "@/components/ui/button": { Button: plain },
  "@/components/ui/markdown": { remarkPluginsFor: () => [] },
  "@/lib/utils": { cn: (...names) => names.filter(Boolean).join(" ") },
  "@/lib/mentions": { withMentions: body => body },
  "./chat-image": { ChatImage: () => null },
  "./cards": { QuestionCard: card("question"), ApprovalCard: card("approval") },
  "./quote": { Quote: () => null },
  "./chat-shared": { Avatar: () => null, ago: () => "now", clock: { format: () => "" }, short: id => id.slice(0, 15) },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/chat-message.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)((id) => dependencies[id] ?? require(id), exports);
const { ChatMessage } = exports;

test("a question card carries no copy of the asking agent's name", () => {
  const message = { id: "m1", from: "claude#1234567890abcdef", kind: "Question", question: "123456789abc", body: "Ship it?", time: 1 };
  const html = renderToStaticMarkup(createElement(ChatMessage, { message, operator: "operator", name: "Reviewer", now: 2000, open: () => {} }));
  assert.equal([...html.matchAll(/Reviewer/g)].length, 1, "the header names the agent once");
  assert.match(html, /<section data-card="question">no head<\/section>/);
});
