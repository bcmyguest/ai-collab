import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { runRecorder, streamTrace, traceStream } from "../lib/cursor-trace.ts";

const json = (event) => JSON.stringify(event);

test("traceStream: passes every chunk through to out unchanged, including a line split across chunks", async () => {
  const line = json({ type: "system", model: "gpt-x" });
  const result = json({ type: "result", is_error: false, usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const chunks = [line.slice(0, 10), line.slice(10) + "\n" + result.slice(0, 20), result.slice(20) + "\n"];
  const stream = Readable.from(chunks);
  const seen = [];
  traceStream(stream, { out: { write: (chunk) => seen.push(chunk) }, address: "cursor#t", role: "r", model: "m" });
  await new Promise((resolve) => stream.on("end", resolve));
  assert.equal(seen.join(""), chunks.join(""));
});

test("runRecorder: a toolEnd with no arguments for a call never started gives one tool span named tool", () => {
  let t = 0;
  const rec = runRecorder({ address: "cursor#a", role: "r", model: "m", now: () => ++t });
  rec.toolEnd("never-started");
  const spans = rec.spans();
  assert.equal(spans.length, 3);
  assert.equal(spans[0].name, "cursor-agent run");
  assert.equal(spans[1].name, "cursor llm");
  assert.equal(spans[2].name, "tool tool");
});

test("streamTrace: token counts from a result event reach the LLM span as prompt, completion and total", () => {
  const trace = streamTrace({ address: "cursor#b", role: "r", model: "m", now: () => 1000 });
  trace.line(json({ type: "result", is_error: false, usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 13 } }));
  const llm = trace.spans().find((s) => s.name === "cursor llm");
  assert.equal(llm.attrs["llm.token_count.prompt"], 29);
  assert.equal(llm.attrs["llm.token_count.completion"], 7);
  assert.equal(llm.attrs["llm.token_count.total"], 36);
  assert.equal(llm.attrs["llm.token_count.prompt_details.cache_read"], 11);
  assert.equal(llm.attrs["llm.token_count.prompt_details.cache_write"], 13);
});
