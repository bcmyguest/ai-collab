// The project rail and the phone's bottom bar, rendered from the real web/app/project-nav.jsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectNavigation } from "../web/lib/selection.js";

const require = createRequire(import.meta.url);
const dependencies = {
  "@/lib/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
  "lucide-react": new Proxy({}, { get: (_, name) => props => createElement("svg", { "data-icon": String(name), ...props }) }),
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/project-nav.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)(id => dependencies[id] ?? require(id), exports);
const { ProjectNav } = exports;

const counts = { tasks: 4, waiting: 2, patterns: 3 };
const links = projectNavigation("demo", "tasks", counts);
const anchors = html => [...html.matchAll(/<a [^>]*>/g)].map(match => match[0]);

test("the project nav is one list of Chat, Tasks and Teams, scoped to the project", () => {
  const html = renderToStaticMarkup(createElement(ProjectNav, { links }));
  const tags = anchors(html);
  assert.equal(tags.length, 3);
  assert.deepEqual([...html.matchAll(/<span class="max-w-full truncate">([^<]+)<\/span>/g)].map(m => m[1]), ["Chat", "Tasks", "Teams"]);
  assert.deepEqual(tags.map(tag => /href="([^"]*)"/.exec(tag)[1].replaceAll("&amp;", "&")), links.map(link => link.href));
  // Exactly one view is current, and it is the one the hash opened.
  assert.deepEqual(tags.map(tag => /aria-current="page"/.test(tag)), [false, true, false]);
  assert.match(html, /aria-label="Project views"/);
});

test("the tasks link counts every task and says how many wait on a decision", () => {
  const html = renderToStaticMarkup(createElement(ProjectNav, { links }));
  assert.match(html, /aria-label="Chat"/);
  assert.match(html, /aria-label="Tasks, 2 waiting on you"/);
  assert.match(html, /aria-label="Teams, 3"/);
  // The badge names what the operator must act on, so two waiting tasks show 2, not the store's four.
  assert.match(html, />2</, "the Tasks badge shows the two tasks waiting on a decision");
  assert.doesNotMatch(html, />4</, "a waiting count replaces the total");
  assert.match(html, />3</, "the Teams badge shows its three patterns");
  assert.match(html, /bg-amber-500/, "a task waiting on a decision is amber");
  // With nothing waiting the badge falls back to the project's whole task count.
  const idle = renderToStaticMarkup(createElement(ProjectNav, { links: projectNavigation("demo", "project", { tasks: 4, patterns: 3 }) }));
  assert.match(idle, />4</);
  assert.doesNotMatch(idle, /bg-amber-500/);
});

test("a computer gets the rail on the left, a phone the bar under the composer", () => {
  const rail = anchors(renderToStaticMarkup(createElement(ProjectNav, { links, rail: true })))[0];
  const bar = anchors(renderToStaticMarkup(createElement(ProjectNav, { links })))[0];
  // The rail is a desktop column; the bar is hidden from md up and sits above the phone's safe area.
  assert.match(rail, /min-h-14/);
  assert.match(bar, /min-h-11/, "a phone tap target is at least 44 px tall");
  const railNav = /<nav [^>]*>/.exec(renderToStaticMarkup(createElement(ProjectNav, { links, rail: true })))[0];
  const barNav = /<nav [^>]*>/.exec(renderToStaticMarkup(createElement(ProjectNav, { links })))[0];
  assert.match(railNav, /hidden|md:flex/);
  assert.match(railNav, /md:flex/);
  assert.match(barNav, /md:hidden/);
});

test("no project views, no nav", () => {
  assert.equal(renderToStaticMarkup(createElement(ProjectNav, { links: [] })), "");
});

test("the console places the rail beside the sidebar and the bar under the composer, from one link list", () => {
  const chat = readFileSync(new URL("../web/app/chat-console.jsx", import.meta.url), "utf8");
  // Both layouts draw the same links, so the phone and the computer can never drift apart.
  assert.match(chat, /const navLinks = projectNavigation\(project, level, viewCounts\);/);
  assert.match(chat, /<ProjectNav links=\{navLinks\} rail\/>/);
  assert.match(chat, /<ProjectNav links=\{navLinks\}\/>/);
  // The rail follows the projects sidebar, and the phone's bar is the last thing in the column, under the composer.
  assert.match(chat, /<aside aria-label="Projects and sessions" className="hidden w-72[^"]*md:block"><Sidebar \{\.\.\.sidebarProps\}\/><\/aside>\s*\n\s*<ProjectNav links=\{navLinks\} rail\/>/);
  assert.match(chat, /\}\/>\}\s*\n\s*<\/>\s*\n\s*<\/ChatRuntimeProvider>\)\}\s*\n\s*<ProjectNav links=\{navLinks\}\/>\s*\n\s*<\/main>/);
  // The sidebar no longer repeats Tasks and Teams, so the three views live in exactly one place.
  assert.doesNotMatch(chat, />Tasks<\/span>/);
  assert.doesNotMatch(chat, /Patterns and teams/);
  // Every project view's header reads the same: a "Project · <name>" kicker over the view's name.
  assert.match(chat, /const projectView = level === "project" \? "Chat" : level === "tasks" \? "Tasks" : level === "patterns" \? "Teams" : "";/);
  assert.match(chat, /\{home \? "All projects" : project \? "Project · " \+ project : "Project"\}/);
  // An empty header row would only add a gap, so the header's extra row is gone when it has nothing to show.
  assert.match(chat, /if \(!\(selected\.level === "session" && selected\.session\) && !compact\) return null;/);
});
