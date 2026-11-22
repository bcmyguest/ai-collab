import assert from "node:assert/strict";
import { test } from "node:test";
import { contextMeter, filesRead, formatTokens } from "../web/lib/context-view.js";

test("formatTokens keeps small counts whole and abbreviates larger ones", () => {
  assert.equal(formatTokens(842), "842");
  assert.equal(formatTokens(9_500), "9.5k");
  assert.equal(formatTokens(11_594), "12k");
  assert.equal(formatTokens(258_400), "258k");
  assert.equal(formatTokens(1_200_000), "1.2M");
  assert.equal(formatTokens(2_000_000), "2M");
});

test("contextMeter shows a percentage only when the window is known", () => {
  assert.deepEqual(contextMeter({ tokens: 11_798, window: 258_400 }), { text: "12k of 258k · 5%", percent: 5, level: "ok" });
  assert.deepEqual(contextMeter({ tokens: 210_000, window: null }), { text: "210k tokens", percent: null, level: "unknown" });
  assert.deepEqual(contextMeter({ tokens: null, window: 258_400 }), { text: "", percent: null, level: "unknown" });
  assert.deepEqual(contextMeter({}), { text: "", percent: null, level: "unknown" });
});

test("contextMeter warns at 80% and marks full at 95%, capped at 100", () => {
  assert.equal(contextMeter({ tokens: 79, window: 100 }).level, "ok");
  assert.equal(contextMeter({ tokens: 80, window: 100 }).level, "warn");
  assert.equal(contextMeter({ tokens: 95, window: 100 }).level, "full");
  assert.equal(contextMeter({ tokens: 150, window: 100 }).percent, 100);
});

test("filesRead lists each file a read tool touched, most recent first, with its count", () => {
  const rows = [
    { type: "tool_call", tool: "Read", input: JSON.stringify({ file_path: "/w/a.md" }) },
    { type: "tool_call", tool: "Bash", input: JSON.stringify({ command: "ls" }) },
    { type: "tool_call", tool: "read_file", input: JSON.stringify({ path: "/w/b.js" }) },
    { type: "tool_call", tool: "Read", input: JSON.stringify({ file_path: "/w/a.md" }) },
    { type: "tool_result", tool: "Read", input: JSON.stringify({ file_path: "/w/c.md" }) },
  ];
  assert.deepEqual(filesRead(rows), [{ path: "/w/a.md", count: 2 }, { path: "/w/b.js", count: 1 }]);
});

test("filesRead accepts an object input and skips rows without a path", () => {
  assert.deepEqual(filesRead([{ type: "tool_call", tool: "Read", input: { filePath: " /w/x.md " } }, { type: "tool_call", tool: "Read", input: "not json" }]),
    [{ path: "/w/x.md", count: 1 }]);
  assert.deepEqual(filesRead(undefined), []);
});
