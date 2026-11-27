import test, { after as afterAll } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sessionLabel } from "../lib/config.mjs";
import { classifyCall, isRefusal, isRunCodeFailure, claudeSource, codexSource, opencodeSource, cursorSource, journalSource } from "../lib/analyze-sources.ts";
import { aggregate, classifyRole, parseSelectors, matchesSelectors, periodOf, priceTurn, isoWeek, renderReport, analyze } from "../lib/analyze-run-code.ts";
import { encodeTraceRequest } from "../lib/analyze-otlp.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const home = () => tempDir({ after: afterAll }, "arc-");
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const jl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const MCP = "mcp__plugin_ai-collab_ai-collab__";
const CODE = "mcp__plugin_ai-collab_ai-collab-code__";
const REFUSAL = 'Call task_list through run_code (ai-collab-code server), batching: { "code": "..." }. Direct reads are off on this machine (defaults.json readsThroughRunCode).';

test("classifyCall sorts read paths", () => {
  const c = (name, input, extra) => classifyCall({ name, input, ...extra }).path;
  assert.equal(c(`${MCP}task_list`, {}), "mcp_read");
  assert.equal(c("mcp__ai-collab__list_agents", {}), "mcp_read");
  assert.equal(c(`${MCP}send_to_all`, {}), null);
  assert.equal(c(`${CODE}run_code`, {}), "run_code");
  assert.equal(c(`${CODE}run_read_code`, {}), "run_read_code");
  assert.equal(c("ai-collab-code_run_code", {}), "run_code");
  assert.equal(c("Bash", { command: "cd /x && ai-collab task list open" }), "cli_read");
  assert.equal(c("Bash", { command: "ai-collab team status core | head" }), "cli_read");
  assert.equal(c("Bash", { command: "/usr/bin/ai-collab pattern list" }), "cli_read");
  assert.equal(c("Bash", { command: "AI_COLLAB_X=1 ai-collab sessions" }), "cli_read");
  assert.equal(c("Bash", { command: "ai-collab send peer hi" }), null);
  assert.equal(c("Bash", { command: 'git commit -m "ai-collab task list"' }), null);
  assert.equal(c("Read", { file_path: "/home/b/.local/share/ai-collab/tasks/ai-collab.json" }), "bypass_read");
  assert.equal(c("Grep", { pattern: "x", path: "/home/b/.local/state/ai-collab" }), "bypass_read");
  assert.equal(c("Bash", { command: "cat ~/.local/share/ai-collab/tasks/p.json | jq ." }), "bypass_read");
  assert.equal(c("Bash", { command: "ls ~/.local/state/ai-collab/builders/x" }), null);
  assert.equal(c("Read", { file_path: "/home/b/src/a.js" }), null);
  assert.equal(c("exec", 'const r = sh("ai-collab task show x")', { loose: true }), "cli_read");
});

test("refusal and failure detection", () => {
  assert.equal(isRefusal(REFUSAL), true);
  assert.equal(isRefusal("ai-collab: reads go through run_code on this machine (defaults.json readsThroughRunCode)."), true);
  assert.equal(isRefusal("fine"), false);
  assert.equal(isRunCodeFailure('{"ok":false,"error":"timed out"}', false), true);
  assert.equal(isRunCodeFailure("run_code could not stage node in sandbox x", true), true);
  assert.equal(isRunCodeFailure('{"ok":true,"result":1}', false), false);
  assert.equal(isRunCodeFailure(REFUSAL, true), false);
});

const T0 = "2026-11-23T01:00:00.000Z";
const T1 = "2026-11-23T02:45:00.000Z";
const T2 = "2026-11-23T04:00:00.000Z";
const usage = (o, extra = {}) => ({ input_tokens: 10, output_tokens: o, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 }, ...extra });
const asst = (ts, id, req, content, u, model = "claude-opus-5-5") => ({ type: "assistant", timestamp: ts, sessionId: "sess-1", cwd: "/home/b/proj", requestId: req, message: { id, role: "assistant", model, content, usage: u } });
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, content, isError = false) => ({ type: "user", timestamp: T0, sessionId: "sess-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });

function claudeHome() {
  const h = home();
  put(join(h, ".claude/projects/p/sess-1.jsonl"), jl(
    asst(T0, "m1", "r1", [use("t1", `${MCP}task_list`, {})], usage(5)),
    asst(T0, "m1", "r1", [use("t2", "Bash", { command: "ai-collab task list" })], usage(50)),
    result("t1", REFUSAL, true),
    result("t2", "Exit code 3\nai-collab: reads go through run_code on this machine"),
    asst(T1, "m2", "r2", [use("t3", `${CODE}run_code`, { code: "x" })], usage(7)),
    result("t3", "run_code could not stage node in sandbox y", true),
    asst(T2, "m3", "r3", [use("t4", `${CODE}run_read_code`, { code: "x" }), use("t5", "Read", { file_path: "/home/b/.local/share/ai-collab/tasks/a.json" })], usage(9)),
    result("t4", '{"ok":true}'),
    asst(T2, "m4", "r4", [{ type: "text", text: "done" }], usage(3), "claude-sonnet-5-5"),
    asst(T2, "m5", "r5", [], usage(1), "<synthetic>"),
  ));
  put(join(h, ".claude/projects/p/sess-1/subagents/agent-a.jsonl"), jl(
    { ...asst(T2, "s1", "q1", [{ type: "text", text: "x" }], usage(4)), isSidechain: true },
  ));
  return h;
}

test("claude source dedupes by message id and request id keeping max output, merges tool calls", async () => {
  const { turns } = await claudeSource({ home: claudeHome() }).load({});
  const main = turns.filter((t) => !t.sub);
  assert.equal(main.length, 4);
  const m1 = main.find((t) => t.ts === Date.parse(T0));
  assert.equal(m1.tok.output, 50);
  assert.equal(m1.tok.cacheRead, 100);
  assert.equal(m1.tok.cw5, 20);
  assert.deepEqual(m1.calls.map((c) => c.path).sort(), ["cli_read", "mcp_read"]);
  assert.deepEqual(m1.calls.map((c) => c.refused), [true, true]);
  assert.equal(m1.native, "sess-1");
  assert.equal(m1.cwd, "/home/b/proj");
  const rc = main.find((t) => t.ts === Date.parse(T1));
  assert.equal(rc.calls[0].failed, true);
  assert.equal(main.find((t) => t.ts === Date.parse(T2) && t.calls.length === 2).calls.map((c) => c.path).sort().join(), "bypass_read,run_read_code");
  assert.equal(turns.filter((t) => t.sub).length, 1);
});

test("codex source: one turn per response_id, calls attach to the next usage record", async () => {
  const h = home();
  const usageRec = (ts, rid, i, c, o) => ({ timestamp: ts, type: "token_usage_record", payload: { turn_id: "u1", response_id: rid, usage: { input_tokens: i, cached_input_tokens: c, output_tokens: o } } });
  put(join(h, ".codex/sessions/2026/11/23/rollout-a.jsonl"), jl(
    { timestamp: T0, type: "session_meta", payload: { id: "thread-9", cwd: "/home/b/x", source: "cli" } },
    { timestamp: T0, type: "turn_context", payload: { turn_id: "u1", model: "gpt-6.2-sol", cwd: "/home/b/x" } },
    { timestamp: T0, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "ai-collab agents" }) } },
    { timestamp: T0, type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ai-collab: reads go through run_code on this machine" } },
    usageRec(T0, "resp1", 1000, 600, 50),
    usageRec(T0, "resp1", 1000, 600, 50),
    usageRec(T2, "resp2", 2000, 1000, 70),
  ));
  const { turns } = await codexSource({ home: h }).load({});
  assert.equal(turns.length, 2);
  assert.equal(turns[0].native, "thread-9");
  assert.equal(turns[0].model, "gpt-6.2-sol");
  assert.deepEqual(turns[0].tok, { input: 400, cw5: 0, cw1: 0, cacheRead: 600, output: 50 });
  assert.equal(turns[0].calls[0].path, "cli_read");
  assert.equal(turns[0].calls[0].refused, true);
  assert.equal(turns[1].calls.length, 0);
});

test("opencode source reads message tokens and tool parts", async () => {
  const h = home();
  const file = join(h, ".local/share/opencode/opencode.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("create table session (id text, directory text, parent_id text); create table message (id text, session_id text, time_created integer, data text); create table part (id text, message_id text, session_id text, time_created integer, data text)");
  db.prepare("insert into session values ('ses_a','/home/b/p',null),('ses_b','/home/b/p','ses_a')").run();
  const msg = (id, ses, t, o) => db.prepare("insert into message values (?,?,?,?)").run(id, ses, t, JSON.stringify({ role: "assistant", modelID: "gpt-x", providerID: "openai", tokens: { input: 10, output: o, reasoning: 2, cache: { read: 5, write: 1 } } }));
  msg("m1", "ses_a", Date.parse(T0), 20);
  msg("m2", "ses_b", Date.parse(T2), 30);
  db.prepare("insert into message values ('m3','ses_a',?,?)").run(Date.parse(T0), JSON.stringify({ role: "user" }));
  db.prepare("insert into part values ('p1','m1','ses_a',?,?)").run(Date.parse(T0), JSON.stringify({ type: "tool", tool: "bash", state: { status: "completed", input: { command: "ai-collab task show x" }, output: "reads go through run_code on this machine" } }));
  db.close();
  const { turns } = await opencodeSource({ home: h }).load({});
  assert.equal(turns.length, 2);
  const a = turns.find((t) => t.native === "ses_a");
  assert.deepEqual(a.tok, { input: 10, cw5: 1, cw1: 0, cacheRead: 5, output: 22 });
  assert.equal(a.calls[0].path, "cli_read");
  assert.equal(a.calls[0].refused, true);
  assert.equal(turns.find((t) => t.native === "ses_b").sub, true);
});

test("cursor source counts tool calls with no usage, dated by session creation", async () => {
  const h = home();
  const file = join(h, ".cursor/chats/w/conv/store.db");
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("create table blobs (id text primary key, data blob); create table meta (key text primary key, value text)");
  db.prepare("insert into meta values ('0',?)").run(Buffer.from(JSON.stringify({ agentId: "conv-1", createdAt: Date.parse(T2) })).toString("hex"));
  const blob = (id, o) => db.prepare("insert into blobs values (?,?)").run(id, Buffer.from(JSON.stringify(o)));
  blob("b1", { role: "assistant", content: [{ type: "text", text: "x", providerOptions: { cursor: { modelName: "composer-2.5" } } }, { type: "tool-call", toolCallId: "k1", toolName: "CallMcpTool", args: { server: "ai-collab", toolName: "task_list", arguments: {} } }] });
  blob("b2", { role: "tool", content: [{ type: "tool-result", toolCallId: "k1", toolName: "CallMcpTool", result: REFUSAL }] });
  blob("b3", { role: "assistant", content: [{ type: "tool-call", toolCallId: "k2", toolName: "Shell", args: { command: "ai-collab task list" } }] });
  db.close();
  const { turns } = await cursorSource({ home: h }).load({});
  assert.equal(turns.length, 2);
  assert.equal(turns[0].tok, null);
  assert.equal(turns[0].model, "composer-2.5");
  assert.equal(turns[0].native, "conv-1");
  assert.equal(turns[0].calls[0].path, "mcp_read");
  assert.equal(turns[0].calls[0].refused, true);
  assert.equal(turns[1].calls[0].path, "cli_read");
});

test("journal source parses schedule run lines", async () => {
  const lines = [
    { __REALTIME_TIMESTAMP: String(Date.parse(T0) * 1000), MESSAGE: "ai-collab-runner: pm: ok in 24115 ms" },
    { __REALTIME_TIMESTAMP: String(Date.parse(T2) * 1000), MESSAGE: "ai-collab-runner: pm: failed in 900000 ms" },
    { __REALTIME_TIMESTAMP: String(Date.parse(T2) * 1000), MESSAGE: "something else" },
  ];
  const { scheduleRuns } = await journalSource({ run: () => lines.map((l) => JSON.stringify(l)).join("\n") }).load({});
  assert.deepEqual(scheduleRuns.map((r) => [r.name, r.ok, r.ms]), [["pm", true, 24115], ["pm", false, 900000]]);
});

test("period split, price and iso week", () => {
  const cut = { partial: Date.parse("2026-11-23T02:30:00Z"), cutover: Date.parse("2026-11-23T03:15:00Z") };
  assert.equal(periodOf(Date.parse(T0), cut), "before");
  assert.equal(periodOf(Date.parse(T1), cut), "partial");
  assert.equal(periodOf(Date.parse(T2), cut), "after");
  assert.equal(periodOf(Date.parse(T1), { partial: null, cutover: cut.cutover }), "before");
  const usd = priceTurn("claude", "claude-opus-5-5", { input: 1e6, cw5: 1e6, cw1: 0, cacheRead: 1e6, output: 1e6 });
  assert.equal(usd, 4 + 5 + 0.2 + 20);
  assert.equal(priceTurn("claude", "unknown-model", { input: 1, cw5: 0, cw1: 0, cacheRead: 0, output: 1 }), null);
  assert.equal(priceTurn("opencode", "gpt-x", { input: 1, cw5: 0, cw1: 0, cacheRead: 0, output: 1 }), null);
  assert.equal(isoWeek(Date.parse("2026-11-23T03:00:00Z"), "UTC"), "2026-W48");
  assert.equal(isoWeek(Date.parse("2026-11-23T03:00:00Z"), "America/Toronto"), "2026-W47");
});

test("selector parsing and matching", () => {
  const label = sessionLabel("sess-1");
  assert.deepEqual(parseSelectors([`claude#${label}`, "codex", "pm"]), [
    { type: "address", value: `claude#${label}` }, { type: "harness", value: "codex" }, { type: "role", value: "pm" }]);
  assert.throws(() => parseSelectors(["claude#xyz"]), /selector/);
  assert.throws(() => parseSelectors(["wizard"]), /selector/);
  const row = { agent: `claude#${label}`, harness: "claude", role: "pm" };
  assert.equal(matchesSelectors(row, []), true);
  assert.equal(matchesSelectors(row, parseSelectors(["claude"])), true);
  assert.equal(matchesSelectors(row, parseSelectors(["codex"])), false);
  assert.equal(matchesSelectors(row, parseSelectors(["codex", "claude"])), true);
  assert.equal(matchesSelectors(row, parseSelectors(["claude", "builder"])), false);
  assert.equal(matchesSelectors(row, parseSelectors([`claude#${label}`, "pm"])), true);
});

test("role classification", () => {
  const pm = new Set([sessionLabel("pm-id")]);
  assert.equal(classifyRole({ native: "pm-id", cwd: "/home/b/ai-collab", sub: false }, { pmLabels: pm }), "pm");
  assert.equal(classifyRole({ native: "x", cwd: "/home/b/ai-collab-wt-fix-it", sub: false }, { pmLabels: pm }), "builder");
  assert.equal(classifyRole({ native: "x", cwd: "/sandbox/wt", sub: false }, { pmLabels: pm }), "builder");
  assert.equal(classifyRole({ native: "x", cwd: "/home/b/ai-collab", sub: true }, { pmLabels: pm }), "subagent");
  assert.equal(classifyRole({ native: "pm-id", cwd: "/", sub: true }, { pmLabels: pm }), "subagent");
  assert.equal(classifyRole({ native: "x", cwd: "/home/b/proj", sub: false }, { pmLabels: pm }), "interactive");
});

test("aggregate: rows carry agent, harness, model, role; read vs plain turns split", async () => {
  const { turns } = await claudeSource({ home: claudeHome() }).load({});
  const cut = { partial: Date.parse("2026-11-23T02:30:00Z"), cutover: Date.parse("2026-11-23T03:15:00Z") };
  const rows = aggregate(turns, { cut, tz: "UTC", pmLabels: new Set(), selectors: [] });
  const label = sessionLabel("sess-1");
  for (const r of rows) assert.ok(r.agent && r.harness && r.model && r.role);
  const before = rows.find((r) => r.period === "before");
  assert.equal(before.agent, `claude#${label}`);
  assert.equal(before.role, "interactive");
  assert.equal(before.turns, 1);
  assert.equal(before.readTurns.n, 1);
  assert.equal(before.reads.mcp_read, 1);
  assert.equal(before.reads.cli_read, 1);
  assert.equal(before.refusals.mcp, 1);
  assert.equal(before.refusals.cli, 1);
  const partial = rows.find((r) => r.period === "partial");
  assert.equal(partial.runCodeErrors, 1);
  const after = rows.filter((r) => r.period === "after" && r.role === "interactive");
  const opus = after.find((r) => r.model === "claude-opus-5-5");
  assert.equal(opus.reads.run_read_code, 1);
  assert.equal(opus.reads.bypass_read, 1);
  assert.equal(opus.tok.output, 9);
  assert.equal(after.find((r) => r.model === "claude-sonnet-5-5").plainTurns.n, 1);
  assert.ok(rows.some((r) => r.role === "subagent"));
  const only = aggregate(turns, { cut, tz: "UTC", pmLabels: new Set(), selectors: parseSelectors(["subagent"]) });
  assert.ok(only.length && only.every((r) => r.role === "subagent"));
  const md = renderReport(rows, { cut, tz: "UTC", since: null, until: null, scheduleRuns: [], tasks: null, notes: [], generated: "2026-11-23" });
  assert.match(md, /## Per-agent/);
  assert.ok(md.includes(`claude#${label}`));
});

test("otlp encoder emits a length-delimited ExportTraceServiceRequest", () => {
  const empty = encodeTraceRequest([], { project: "p" });
  assert.ok(empty.length > 0);
  const spans = [{ traceId: "a".repeat(32), spanId: "b".repeat(16), name: "claude turn", startMs: 1000, endMs: 1001, attrs: { "llm.model_name": "m", "llm.token_count.prompt": 5, ok: true, f: 1.5 } }];
  const buf = encodeTraceRequest(spans, { project: "p" });
  assert.equal(buf[0], 0x0a);
  assert.ok(buf.includes(Buffer.from("claude turn")));
  assert.ok(buf.includes(Buffer.from("llm.model_name")));
  assert.ok(buf.length > empty.length);
});

test("analyze end to end writes markdown and jsonl", async () => {
  const h = claudeHome();
  const out = join(h, "r.md");
  const jsonl = join(h, "r.jsonl");
  const lines = [];
  const io = { env: { HOME: h }, stdout: { write: (s) => lines.push(s) }, stderr: { write: (s) => lines.push(s) }, journal: () => "" };
  const code = await analyze(["--out", out, "--jsonl", jsonl, "--agent", "claude"], io);
  assert.equal(code, 0);
  const md = readFileSync(out, "utf8");
  assert.match(md, /2026-11-23T03:15:00/);
  const rows = readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.length > 2);
  assert.ok(rows.every((r) => r.agent && r.harness && r.model && r.role && r.period));
  assert.equal(await analyze(["--agent", "nope"], io), 2);
});
