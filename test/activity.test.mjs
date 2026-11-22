import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITY_MAX_BYTES, activityEvents, buildActivity, publishActivity } from "../lib/activity.mjs";
import { activityTopic, loadConfig } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { pollCached, publish, querySafe } from "../lib/ntfy.mjs";
import { createUi } from "../web/server/ui.mjs";
import { activityRows, interleave, summarize } from "../web/lib/activity-rows.js";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const base = "http://127.0.0.1:8795";
const TOPIC = activityTopic("demo");

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

const activity = (fake) => fake.state.publishes.filter((p) => p.topic === TOPIC).map((p) => JSON.parse(p.message));
const strip = ({ ts, ...rest }) => rest;
const cfgFor = (peer, session) => ({ ...loadConfig(peerEnv({ url: "http://127.0.0.1:1" }, { peer })), session });

test("envelopes fit 4096 bytes with an explicit marker, strip control and bidi characters, and attach large results", () => {
  const cfg = cfgFor("claude", "aabbccddeeff0011");
  const output = "line ✓ ‮evil\u0007\n".repeat(2000);
  const { message, attach } = buildActivity(cfg, "claude", { type: "tool_result", tool: "Bash", callId: "toolu_1", output });
  assert.ok(Buffer.byteLength(message) <= ACTIVITY_MAX_BYTES, `${Buffer.byteLength(message)} bytes`);
  const envelope = JSON.parse(message);
  assert.deepEqual(Object.keys(envelope), ["v", "kind", "from", "session", "harness", "ts", "type", "tool", "callId", "output"]);
  assert.equal(envelope.kind, "activity");
  const cleaned = output.replace(/[‮\u0007]/g, "");
  const marker = /…\[truncated (\d+) bytes\]$/.exec(envelope.output);
  assert.ok(marker, "truncation marker");
  const kept = envelope.output.slice(0, marker.index);
  assert.ok(cleaned.startsWith(kept));
  assert.equal(Number(marker[1]), Buffer.byteLength(cleaned) - Buffer.byteLength(kept));
  assert.doesNotMatch(envelope.output, /[‮\u0007]/);
  assert.ok(Buffer.byteLength(querySafe(message)) <= ACTIVITY_MAX_BYTES, "fits after query-string respelling");
  const tricky = JSON.stringify({ a: "line\nnext \\n literal \\\\n \"q\" é" });
  assert.doesNotMatch(querySafe(tricky), /\\n/);
  assert.deepEqual(JSON.parse(querySafe(tricky).replaceAll("\\n", "\n")), JSON.parse(tricky), "survives ntfy's \\n unescape");
  assert.equal(querySafe("plain \\n text"), "plain \\n text", "non-JSON messages are untouched");
  assert.equal(attach.filename, "output.txt");
  assert.equal(attach.data.toString("utf8"), cleaned);

  const call = buildActivity(cfg, "claude", { type: "tool_call", tool: "Write", input: { file_path: "/x", content: "\"quoted\"\\".repeat(3000) } });
  assert.ok(Buffer.byteLength(call.message) <= ACTIVITY_MAX_BYTES);
  assert.match(JSON.parse(call.message).input, /…\[truncated \d+ bytes\]$/);
  assert.equal(call.attach, undefined, "only results and errors attach");

  const both = buildActivity(cfg, "codex", { type: "tool_result", input: "short input", output: "x".repeat(10_000) });
  assert.equal(JSON.parse(both.message).input, "short input", "the smaller field is kept whole");

  const small = buildActivity(cfg, "cursor", { type: "prompt", input: "hello" });
  assert.deepEqual(strip(JSON.parse(small.message)), { v: 1, kind: "activity", from: "claude", session: "aabbccddeeff0011", harness: "cursor", type: "prompt", input: "hello" });
});

test("each harness's documented hook input maps to activity events; thinking is never read", () => {
  // Claude Code: https://code.claude.com/docs/en/hooks
  assert.deepEqual(activityEvents("claude", "pretooluse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1" }),
    [{ type: "tool_call", tool: "Bash", input: { command: "ls" }, callId: "toolu_1" }]);
  assert.deepEqual(activityEvents("claude", "posttooluse", {
    tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_1",
    tool_response: { stdout: "a\nb", stderr: "", interrupted: false },
  }), [{ type: "tool_result", tool: "Bash", callId: "toolu_1", output: "a\nb", input: { command: "ls" } }]);
  assert.deepEqual(activityEvents("claude", "posttoolusefailure", { tool_name: "Bash", tool_use_id: "toolu_2", error: "Exit code 1" }),
    [{ type: "error", tool: "Bash", callId: "toolu_2", output: "Exit code 1" }]);
  assert.deepEqual(activityEvents("claude", "userpromptsubmit", { prompt: "fix it" }), [{ type: "prompt", input: "fix it" }]);
  assert.deepEqual(activityEvents("claude", "messagedisplay", { message_id: "m-1", index: 2, final: false, delta: "Here\n" }),
    [{ type: "text", output: "Here\n", callId: "m-1#2" }]);
  assert.deepEqual(activityEvents("claude", "messagedisplay", { message_id: "m-1", index: 3, final: true, delta: "" }), []);
  assert.deepEqual(activityEvents("claude", "stop", { stop_hook_active: false, last_assistant_message: "already streamed" }),
    [{ type: "stop", input: "turn ended" }]);
  assert.deepEqual(activityEvents("claude", "sessionend", { reason: "prompt_input_exit" }), [{ type: "stop", input: "session ended · prompt_input_exit" }]);
  assert.deepEqual(activityEvents("claude", "sessionstart", { source: "startup" }), [{ type: "start", input: "session started · startup" }]);
  assert.deepEqual(activityEvents("claude", "notification", { message: "Claude needs your permission to use Bash" }),
    [{ type: "text", tool: "Notification", output: "Claude needs your permission to use Bash" }]);

  // Codex: https://learn.chatgpt.com/docs/hooks
  assert.deepEqual(activityEvents("codex", "posttooluse", { turn_id: "t", tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "ls" }, tool_response: "a\nb" }),
    [{ type: "tool_result", tool: "Bash", callId: "call_1", output: "a\nb", input: { command: "ls" } }]);
  assert.deepEqual(activityEvents("codex", "stop", { turn_id: "t", stop_hook_active: false, last_assistant_message: "Done." }),
    [{ type: "text", output: "Done." }, { type: "stop", input: "turn ended" }]);

  // Cursor: https://cursor.com/docs/agent/hooks
  assert.deepEqual(activityEvents("cursor", "beforesubmitprompt", { prompt: "go", attachments: [] }), [{ type: "prompt", input: "go" }]);
  assert.deepEqual(activityEvents("cursor", "afteragentresponse", { text: "Answer" }), [{ type: "text", output: "Answer" }]);
  assert.deepEqual(activityEvents("cursor", "afteragentthought", { text: "secret reasoning" }), []);
  assert.deepEqual(activityEvents("cursor", "pretooluse", { tool_name: "Shell", tool_input: {} }), [], "Cursor's preToolUse decides permissions; not used");
  assert.deepEqual(activityEvents("cursor", "posttooluse", { tool_name: "Shell", tool_input: { command: "ls" }, tool_output: "{\"stdout\":\"a\"}", tool_use_id: "c1" }), [
    { type: "tool_call", tool: "Shell", input: { command: "ls" }, callId: "c1" },
    { type: "tool_result", tool: "Shell", callId: "c1", output: "a" },
  ]);
  assert.deepEqual(activityEvents("cursor", "posttoolusefailure", { tool_name: "Shell", tool_input: "x", tool_use_id: "c2", error_message: "boom", failure_type: "timeout" })[1],
    { type: "error", tool: "Shell", callId: "c2", output: "timeout: boom" });
  assert.deepEqual(activityEvents("cursor", "stop", { status: "completed", loop_count: 0 }), [{ type: "stop", input: "turn ended · completed" }]);
});

test("hooks publish each harness's activity to the activity topic only, and Cursor's prompt hook allows the prompt", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude" });
  const claude = async (input) => JSON.parse((await runHook(["--activity", "--host", "claude"], { session_id: "s-claude", ...input }, env)).out);
  assert.deepEqual(await claude({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a" }, tool_use_id: "toolu_9" }), {});
  assert.deepEqual(await claude({ hook_event_name: "MessageDisplay", message_id: "m", index: 0, final: true, delta: "Reading it." }), {});
  const cursor = await runHook(["--activity", "--host", "cursor"], { hook_event_name: "beforeSubmitPrompt", conversation_id: "c-1", prompt: "hi" }, { ...env, AI_COLLAB_PEER: "cursor" });
  assert.deepEqual(JSON.parse(cursor.out), { continue: true });
  const codex = await runHook(["--host", "codex"], { hook_event_name: "Stop", session_id: "s-codex", last_assistant_message: "All done", stop_hook_active: false }, { ...env, AI_COLLAB_PEER: "codex" });
  assert.deepEqual(JSON.parse(codex.out), {});

  assert.deepEqual(activity(fake).map((e) => [e.from, e.harness, e.type, e.tool || e.input || e.output]), [
    ["claude", "claude", "tool_call", "Read"],
    ["claude", "claude", "text", "Reading it."],
    ["cursor", "cursor", "prompt", "hi"],
    ["codex", "codex", "text", "All done"],
    ["codex", "codex", "stop", "turn ended"],
  ]);
  assert.ok(activity(fake).every((e) => /^[a-f0-9]{16}$/.test(e.session) && !JSON.stringify(e).includes("s-claude")));
  const other = fake.state.publishes.filter((p) => p.topic !== TOPIC);
  assert.ok(other.every((p) => !p.message.includes("All done") && !p.message.includes("/tmp/a")));
});

test("AI_COLLAB_ACTIVITY=off or projects.json activity off publishes nothing", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const off = peerEnv(fake, { peer: "claude", AI_COLLAB_ACTIVITY: "off" });
  await runHook(["--activity", "--host", "claude"], { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {} }, off);
  await runHook(["--host", "claude"], { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "secret" }, off);
  assert.deepEqual(activity(fake), []);
  assert.equal(loadConfig(peerEnv(fake)).activity, true, "on by default");

  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-activity-"));
  mkdirSync(path.join(root, "ai-collab"));
  writeFileSync(path.join(root, "ai-collab", "projects.json"), JSON.stringify([{ root: "/srv/p", project: "p", url: fake.url, activity: "off" }]));
  assert.equal(loadConfig({ XDG_CONFIG_HOME: root }, { cwd: "/srv/p", host: "claude" }).activity, false);
  assert.equal(loadConfig({ XDG_CONFIG_HOME: root, AI_COLLAB_ACTIVITY: "on" }, { cwd: "/srv/p", host: "claude" }).activity, true, "env overrides");
  assert.equal(await publishActivity({ ...loadConfig(peerEnv(fake)), activity: false }, "claude", [{ type: "prompt", input: "x" }]), 0);
});

test("a slow ntfy server delays an activity-only hook by at most the 1.5 s cap", async (t) => {
  // Accepts connections and never answers.
  const silent = http.createServer(() => {});
  await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => { silent.closeAllConnections(); silent.close(); });
  const r = await runHook(["--activity", "--host", "claude"], { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {} },
    peerEnv({ url: `http://127.0.0.1:${silent.address().port}` }, { peer: "claude", AI_COLLAB_TIMEOUT_MS: "15000" }));
  assert.equal(r.out.trim(), "{}");
  assert.ok(r.ms < 3000, `took ${r.ms}ms`);
});

test("claimInbox never reads the activity topic and ignores activity envelopes elsewhere", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const alice = loadConfig(peerEnv(fake, { peer: "alice" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  await publishActivity(bob, "claude", [{ type: "prompt", input: "do the thing" }, { type: "text", output: "@alice look" }]);
  fake.inject("ai-collab-demo--to--all", JSON.stringify({ v: 1, kind: "activity", from: "bob", session: bob.session, type: "text", output: "stray" }));
  await sendMessage(bob, "alice", "real message");
  assert.deepEqual((await claimInbox(alice)).map((m) => m.body), ["real message"]);
  assert.ok(fake.state.polls.every((p) => p.topic !== TOPIC));
});

test("UI streams activity per session and as a project overview, never as chat, and serves a large result's attachment", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "operator" }));
  const bob = { ...loadConfig(peerEnv(fake, { peer: "bob" })), session: "0000000000000001" };
  const carol = { ...loadConfig(peerEnv(fake, { peer: "carol" })), session: "0000000000000003" };
  await publishActivity(bob, "claude", [{ type: "tool_call", tool: "Bash", input: { command: "ls" }, callId: "t1" }]);
  await publishActivity(carol, "codex", [{ type: "prompt", input: "carol prompt" }]);
  await sendMessage(bob, "all", "chat only");
  const ui = createUi({ cfg });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const open = (query) => sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })));
  const next = async (stream, name) => {
    for (;;) {
      const { value, done } = await stream.next();
      if (done) return undefined;
      if (value.event === name) return value.data;
    }
  };

  const session = open(`session=${encodeURIComponent(`bob#${bob.session}`)}&view=activity`);
  const state = await next(session, "state");
  assert.deepEqual(state.messages.map((m) => m.body), ["chat only"]);
  const first = await next(session, "activity");
  assert.equal(first.reset, true);
  assert.deepEqual(first.items.map((i) => [i.agent, i.type, i.tool, i.callId]), [[`bob#${bob.session}`, "tool_call", "Bash", "t1"]]);

  const overview = open("view=activity");
  await next(overview, "state");
  assert.deepEqual((await next(overview, "activity")).items.map((i) => i.agent), [`bob#${bob.session}`, `carol#${carol.session}`]);

  const chat = open("");
  const chatState = await next(chat, "state");
  assert.deepEqual(chatState.messages.map((m) => m.body), ["carol prompt", "chat only"]);

  const big = "result line\n".repeat(1000);
  await publishActivity(bob, "claude", [{ type: "tool_result", tool: "Bash", output: big, callId: "t1" }]);
  const live = await next(session, "activity");
  assert.equal(live.reset, false);
  const [result] = live.items;
  assert.equal(result.type, "tool_result");
  assert.match(result.output, /…\[truncated \d+ bytes\]$/);
  assert.equal(result.attachment.type, "text/plain; charset=utf-8");
  assert.equal((await next(overview, "activity")).items[0].id, result.id, "overview gets the same delta");

  const served = await ui.file(result.attachment.file);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await served.text(), big);
  assert.equal((await ui.file("f999.txt")).status, 404, "only attachments in activity history are served");
  assert.equal((await ui.file("../secret.txt")).status, 404);

  // A text file sent on a chat topic is never served, and images are never served from the activity topic.
  await publish(bob, "ai-collab-demo--to--all", JSON.stringify({ v: 1, kind: "msg", from: "bob", to: "all", body: "notes" }),
    { attach: { filename: "notes.txt", data: Buffer.from("chat text file") } });
  const withText = await next(chat, "state");
  assert.deepEqual(withText.messages.map((m) => [m.body, m.attachment]), [["carol prompt", undefined], ["chat only", undefined], ["notes", undefined]]);
  assert.equal((await ui.file("f2.txt")).status, 404, "a text file on a chat topic is never served");

  const rows = activityRows([...first.items, ...live.items]);
  assert.equal(rows.length, 1, "the result joins its call by callId");
  assert.equal(rows[0].result.id, result.id);
});

test("activity rows join streamed text batches in order and pair results that arrive before their call", () => {
  const a = "claude#0000000000000001";
  const rows = activityRows([
    { id: "1", agent: a, type: "text", output: "world\n", callId: "m#1" },
    { id: "2", agent: a, type: "text", output: "hello ", callId: "m#0" },
    { id: "3", agent: a, type: "tool_result", output: "ok", callId: "c" },
    { id: "4", agent: a, type: "tool_call", tool: "Bash", input: "{\"command\":\"ls -la\"}", callId: "c" },
    { id: "5", agent: a, type: "error", output: "boom" },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.type, r.output, r.result?.id]), [
    ["1", "text", "hello world\n", undefined], ["4", "tool_call", undefined, "3"], ["5", "error", "boom", undefined],
  ]);
  assert.equal(summarize("{\"command\":\"ls -la\"}"), "ls -la");
  const thread = interleave([{ id: "m1", time: 10 }, { id: "m2", time: 30 }], [{ id: "a1", time: 5 }, { id: "a2", time: 10 }, { id: "a3", time: 40 }]);
  assert.deepEqual(thread.map((x) => (x.message || x.activity).id), ["a1", "a2", "m1", "m2", "a3"], "by time; activity first on a tie");
  assert.equal(summarize("{\"file_path\":\"/a/b.txt\",\"content\":\"tru"), "/a/b.txt", "truncated JSON still summarizes");
});

test("activity history keeps the newest events when the cache exceeds the poll cap", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  for (let i = 0; i < 300; i += 1) fake.inject(TOPIC, JSON.stringify({ n: i, pad: "x".repeat(1000) }));
  const cfg = loadConfig(peerEnv(fake));
  const head = await pollCached(cfg, TOPIC, "all");
  assert.equal(JSON.parse(head[0].message).n, 0, "the default read keeps the oldest 256 KB");
  assert.ok(head.length < 300);
  const tail = await pollCached(cfg, TOPIC, "all", undefined, { tailBytes: 64 * 1024 });
  assert.equal(JSON.parse(tail.at(-1).message).n, 299);
  assert.ok(tail.length > 10 && tail.length < 100);
});

test("PreCompact publishes a compact row: /compact skips UserPromptSubmit, so this is the only trace", async (t) => {
  assert.deepEqual(activityEvents("claude", "precompact", { trigger: "manual", custom_instructions: "keep the API notes" }),
    [{ type: "compact", input: "compacting · manual · keep the API notes", compaction: { trigger: "manual", phase: "started" } }]);
  assert.deepEqual(activityEvents("codex", "precompact", { trigger: "auto", custom_instructions: "x".repeat(201) }),
    [{ type: "compact", input: "compacting · auto", compaction: { trigger: "auto", phase: "started" } }]);
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const r = await runHook(["--activity", "--host", "claude"], { hook_event_name: "PreCompact", session_id: "s", trigger: "manual", custom_instructions: "" }, peerEnv(fake, { peer: "claude" }));
  assert.deepEqual(JSON.parse(r.out), {});
  assert.deepEqual(activity(fake).map((e) => [e.type, e.input]), [["compact", "compacting · manual"]]);
});

test("a hand-back prompt shows as an agent message, a typed prompt as the operator's", () => {
  assert.deepEqual(activityEvents("claude", "userpromptsubmit", { prompt: "Another Claude session sent a message:\nreport" }),
    [{ type: "text", tool: "Agent message", output: "Another Claude session sent a message:\nreport" }]);
  assert.deepEqual(activityEvents("claude", "userpromptsubmit", { prompt: "ship it" }), [{ type: "prompt", input: "ship it" }]);
});
