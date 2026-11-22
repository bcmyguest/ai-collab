import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { parseSelection } from "../web/lib/selection.js";
import { remarkTaskLinks, taskLink } from "../web/lib/task-tags.js";

test("chat Markdown links known task tags to the matching task in the current project", () => {
  const project = "demo";
  const id = "build-it";
  const href = taskLink(project, id);
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [[remarkTaskLinks, { project, ids: new Set([id]) }]],
  }, "See (#build-it), #unknown, `#build-it`, and [#build-it](https://example.com)."));
  assert.match(html, /\(<a href="#project=demo&amp;level=tasks&amp;task=build-it">#build-it<\/a>\), #unknown, <code>#build-it<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com">#build-it<\/a>/);
  const selected = parseSelection(href.slice(1));
  assert.deepEqual([selected.project, selected.level, selected.task], [project, "tasks", id]);
});
