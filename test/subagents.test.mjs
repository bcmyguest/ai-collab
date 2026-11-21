import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activityEvents } from "../lib/activity.mjs";
import { activityTopic, loadConfig, sessionLabel } from "../lib/config.mjs";
import { createUi } from "../web/server/ui.mjs";
import { activityRows, groupSubagents, interleave, runState, runningSubagents, subagentLabel } from "../web/lib/activity-rows.js";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const base = "http://127.0.0.1:8795";

function runHook(host, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "--activity", "--host", host], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("subagent hooks publish start, tagged tool calls, and a stop row with the last message", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude" });
  const sub = { session_id: "s-parent", cwd: "/tmp", agent_id: "agent-7", agent_type: "Explore" };
  for (const input of [
    { ...sub, hook_event_name: "SubagentStart" },
    { ...sub, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "toolu_1" },
    { ...sub, hook_event_name: "SubagentStop", agent_transcript_path: "/tmp/SECRET.jsonl", last_assistant_message: "Found 3 call sites." + "y".repeat(5000) },
    { session_id: "s-parent", cwd: "/tmp", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "toolu_2" },
  ]) assert.deepEqual(JSON.parse((await runHook("claude", input, env)).out), {});
  const rows = fake.state.publishes.filter((p) => p.topic === activityTopic("demo")).map((p) => JSON.parse(p.message));
  assert.deepEqual(rows.map((e) => [e.type, e.agent, e.session]), [
    ["start", { id: "agent-7", type: "Explore" }, sessionLabel("s-parent")],
    ["tool_call", { id: "agent-7", type: "Explore" }, sessionLabel("s-parent")],
    ["stop", { id: "agent-7", type: "Explore" }, sessionLabel("s-parent")],
    ["tool_call", undefined, sessionLabel("s-parent")],
  ]);
  assert.equal(rows[0].input, "subagent started · Explore");
  assert.match(rows[2].output, /^Found 3 call sites\.y+…\[truncated \d+ bytes\]$/);
  assert.ok(!JSON.stringify(fake.state.publishes).includes("SECRET"), "the subagent transcript path is never published");
  // Codex tags tool calls inside a subagent the same way.
  assert.deepEqual(activityEvents("codex", "pretooluse", { agent_id: "a1", agent_type: "worker", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "c" }),
    [{ type: "tool_call", tool: "Bash", input: { command: "ls" }, callId: "c", agent: { id: "a1", type: "worker" } }]);
});

test("UI rows carry the subagent run; grouping folds each run into one row outside the parent's stream", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude" });
  const sub = { session_id: "s-parent", cwd: "/tmp", agent_id: "agent-7", agent_type: "Explore" };
  await runHook("claude", { ...sub, hook_event_name: "SubagentStart" }, env);
  await runHook("claude", { ...sub, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "toolu_1" }, env);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const reader = ui.events(new Request(`${base}/api/events?view=activity`, { signal: ctrl.signal })).body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!/event: activity\ndata: (.*)\n\n/.test(text)) text += (await reader.read()).value;
  const { items } = JSON.parse(/event: activity\ndata: (.*)\n\n/.exec(text)[1]);
  assert.deepEqual(items.map((i) => i.subagent), [{ id: "agent-7", type: "Explore" }, { id: "agent-7", type: "Explore" }]);

  const a = "claude#0000000000000001";
  const run = { id: "r1", type: "Explore" };
  const rows = groupSubagents(activityRows([
    { id: "1", time: 1, agent: a, type: "tool_call", tool: "Agent", callId: "p" },
    { id: "2", time: 2, agent: a, type: "start", subagent: run },
    { id: "3", time: 3, agent: a, type: "tool_call", tool: "Grep", callId: "g", subagent: run },
    { id: "4", time: 4, agent: a, type: "text", output: "parent note" },
    { id: "5", time: 5, agent: a, type: "tool_result", callId: "g", output: "hit", subagent: run },
    { id: "6", time: 6, agent: a, type: "tool_call", tool: "Read", callId: "r", subagent: { id: "r2", type: "Plan" } },
  ]));
  assert.deepEqual(rows.map((r) => [r.id, r.type]), [["1", "tool_call"], [`subagent:${a}|r1`, "subagent"], ["4", "text"], [`subagent:${a}|r2`, "subagent"]]);
  assert.deepEqual(rows[1].rows.map((r) => [r.id, r.result?.id]), [["2", undefined], ["3", "5"]]);
  assert.deepEqual([rows[1].kind, rows[1].done, rows[1].steps], ["Explore", false, 1]);
  assert.deepEqual([...runningSubagents(rows)], [[a, 2]]);
  const done = groupSubagents([...rows[1].rows, { id: "7", time: 7, agent: a, type: "stop", subagent: run }]);
  assert.equal(done[0].done, true);
  assert.equal(runningSubagents(done).size, 0);
  const thread = interleave([{ id: "m", time: 3 }], rows);
  assert.deepEqual(thread.map((x) => (x.message || x.activity).id), ["1", `subagent:${a}|r1`, "m", "4", `subagent:${a}|r2`], "a run sits at its first row's time");
});

test("a run seen only through PostToolUse counts its steps and ends on the parent's task notification", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude" });
  const parent = { session_id: "s-parent", cwd: "/tmp", transcript_path: "/tmp/none.jsonl" };
  const sub = { ...parent, agent_id: "a7797af9c80e46d58", agent_type: "Explore" };
  // Real Claude 2.1.330 topics held no async PreToolUse or SubagentStart/Stop rows; these sync hooks did arrive.
  const launch = { isAsync: true, status: "async_launched", agentId: "a7797af9c80e46d58", description: "Build message read receipts", outputFile: "/tmp/x.output" };
  const notice = "<task-notification>\n<task-id>a7797af9c80e46d58</task-id>\n<status>completed</status>\n<summary>Agent \"Build message read receipts\" finished</summary>\n</task-notification>";
  for (const input of [
    { ...parent, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { description: "Build message read receipts", subagent_type: "Explore", prompt: "…" }, tool_response: launch, tool_use_id: "toolu_launch" },
    { ...sub, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a", stderr: "" }, tool_use_id: "toolu_s1" },
    { ...sub, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/tmp/a.js" }, tool_response: { file: { content: "x" } }, tool_use_id: "toolu_s2" },
    { ...sub, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/tmp/a.js" }, tool_response: "ok", tool_use_id: "toolu_s3" },
  ]) await runHook("claude", input, env);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const reader = ui.events(new Request(`${base}/api/events?view=activity`, { signal: ctrl.signal })).body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!/event: activity\ndata: (.*)\n\n/.test(text)) text += (await reader.read()).value;
  const { items } = JSON.parse(/event: activity\ndata: (.*)\n\n/.exec(text)[1]);
  const address = `claude#${sessionLabel("s-parent")}`;
  let [, run] = groupSubagents(activityRows(items));
  assert.deepEqual([run.type, run.kind, run.steps, run.done, run.description, run.last.tool], ["subagent", "Explore", 3, false, "Build message read receipts", "Edit"]);
  assert.equal(subagentLabel(run), `Explore · in ${address.slice(0, 15)} · running · 3 steps`);
  [, run] = groupSubagents(activityRows([...items, { id: "n", time: 9e9, agent: address, type: "prompt", input: notice }]));
  assert.equal(run.done, true);
  assert.equal(subagentLabel(run), `Explore · in ${address.slice(0, 15)} · done · 3 steps`);
  // A foreground run's Agent result carries status completed.
  const fg = groupSubagents(activityRows([
    { id: "1", time: 1, agent: address, type: "tool_result", tool: "Bash", callId: "b", subagent: { id: "f1", type: "Plan" } },
    { id: "2", time: 2, agent: address, type: "tool_result", tool: "Agent", callId: "p", output: JSON.stringify({ status: "completed", agentId: "f1" }) },
  ]));
  assert.equal(fg[0].done, true);
});

test("a run without a stop row counts as running only with a row in the last 2 minutes", () => {
  const a = "claude#0000000000000001";
  const rows = groupSubagents([
    { id: "1", time: 100, agent: a, type: "tool_result", tool: "Bash", callId: "b", subagent: { id: "r1", type: "Explore" } },
    { id: "2", time: 200, agent: a, type: "tool_result", tool: "Read", callId: "c", subagent: { id: "r1", type: "Explore" } },
    { id: "3", time: 150, agent: a, type: "tool_result", tool: "Grep", callId: "d", subagent: { id: "r2", type: "Plan" } },
    { id: "4", time: 160, agent: a, type: "stop", subagent: { id: "r2", type: "Plan" } },
  ]);
  assert.deepEqual(rows.map(r => runState(r, 200_000 + 119_000)), ["running", "done"]);
  assert.deepEqual(rows.map(r => runState(r, 200_000 + 121_000)), ["idle", "done"]);
  assert.deepEqual([...runningSubagents(rows, 200_000 + 60_000)], [[a, 1]]);
  assert.equal(runningSubagents(rows, 200_000 + 121_000).size, 0, "an inactive run no longer counts");
  assert.match(subagentLabel(rows[0], 200_000 + 121_000), /· idle · 2 steps$/);
  assert.match(subagentLabel(rows[1], 200_000), /· done · 1 step$/);
});
