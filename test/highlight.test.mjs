import assert from "node:assert/strict";
import { test } from "node:test";
import { activityEvents } from "../lib/activity.mjs";
import { HIGHLIGHT_MAX_BYTES, highlight, languageOf } from "../web/lib/highlight.js";
import { inputBlocks, resultLanguage } from "../web/lib/activity-rows.js";

test("tool inputs and results get a language only when it is clear", () => {
  assert.deepEqual(inputBlocks("Bash", JSON.stringify({ command: "npm test", description: "Run tests" })),
    [{ code: "npm test", language: "bash" }, { code: "{\n  \"description\": \"Run tests\"\n}", language: "json" }]);
  assert.deepEqual(inputBlocks("exec_command", JSON.stringify({ cmd: ["git", "status"] })), [{ code: "git status", language: "bash" }]);
  assert.deepEqual(inputBlocks("Grep", "{\"pattern\":\"x\""), [{ code: "{\"pattern\":\"x\"", language: "json" }], "truncated JSON stays JSON");
  assert.deepEqual(inputBlocks("Task", "plain words"), [{ code: "plain words", language: "" }]);
  assert.equal(resultLanguage("Read", JSON.stringify({ file_path: "/src/app.tsx" }), "export const x = 1;"), "tsx");
  assert.equal(resultLanguage("Bash", "{}", "ok"), "bash");
  assert.equal(resultLanguage("Bash", "{}", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"), "diff");
  assert.equal(resultLanguage("WebFetch", "{}", "<html>"), "");
  assert.equal(resultLanguage("Edit", "{}", "{\"ok\":true}"), "json");
  // Claude's Read result travels as the file's content, not the response JSON.
  assert.deepEqual(activityEvents("claude", "posttooluse", { tool_name: "Read", tool_use_id: "t", tool_response: { type: "text", file: { filePath: "/a.js", content: "let a;" } } }),
    [{ type: "tool_result", tool: "Read", callId: "t", output: "let a;" }]);
});

test("shiki highlights with dual themes in the JavaScript engine, and caps the input", async () => {
  assert.equal(languageOf("sh"), "shellscript");
  assert.equal(languageOf("plaintext"), "");
  const html = await highlight("const a = 1;", "js");
  assert.match(html, /^<pre class="shiki shiki-themes github-light github-dark"/);
  assert.match(html, /--shiki-dark:/);
  assert.equal(await highlight("x".repeat(HIGHLIGHT_MAX_BYTES + 1), "js"), null);
  assert.equal(await highlight("a", "cobol"), null);
  assert.doesNotMatch(await highlight("<b>&</b>", "md"), /<b>/, "code is escaped");
});
