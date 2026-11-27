import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { broadcastTopic, loadConfig, sessionLabel } from "../lib/config.ts";
import { publishActivity } from "../lib/activity.ts";
import { recordSession } from "../lib/sessions/registry.ts";
import { createUi } from "../web/server/ui.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

async function stateWhere(ui, query, check, signal) {
  const response = ui.events(new Request(`${base}/api/events?${query}`, { signal }));
  for await (const { event, data } of sse(response)) {
    if (event === "problem") throw new Error(data.error);
    if (event === "state" && check(data)) return data;
  }
  throw new Error("stream ended");
}

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = tempDir(t, "ai-collab-redesign-");
  const env = (project, peer) => peerEnv(fake, { peer, stateDir, AI_COLLAB_PROJECT: project, AI_COLLAB_PEERS: "claude" });
  const root = tempDir(t, "ai-collab-redesign-root-");
  mkdirSync(path.join(root, "app"));
  return { fake, env, folder: path.join(root, "app") };
}

test("each agent carries its finished subagent runs, newest first, capped at 10, apart from the running ones", async (t) => {
  const { env, folder } = await setup(t);
  const id = "22222222-0000-4000-8000-000000000001";
  const claude = { ...loadConfig(env("demo", "claude")), session: sessionLabel(id) };
  await recordSession(claude, { id, cwd: folder, harness: "claude", event: "SessionStart", proc: self() });
  const events = [];
  for (let index = 0; index < 12; index++) {
    events.push({ type: "tool_result", tool: "Grep", callId: "g" + index, input: { pattern: "x" }, output: "hit", agent: { id: "run-" + index, type: "Explore" } });
    events.push({ type: "tool_result", tool: "Agent", callId: "a" + index, output: JSON.stringify({ status: "completed", agentId: "run-" + index, description: "Task " + index }) });
  }
  events.push({ type: "tool_result", tool: "Agent", callId: "live", output: JSON.stringify({ status: "async_launched", agentId: "run-live", description: "Still going" }) });
  events.push({ type: "tool_result", tool: "Grep", callId: "gl", input: { pattern: "y" }, output: "hit", agent: { id: "run-live", type: "Plan" } });
  await publishActivity(claude, "claude", events);
  const ui = createUi({ projects: [loadConfig(env("demo", "operator"))] });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const address = `claude#${claude.session}`;
  const data = await stateWhere(ui, "project=demo", d => d.agents?.find(a => a.id === address)?.finishedSubagents?.length === 10, ctrl.signal);
  const agent = data.agents.find(a => a.id === address);
  assert.deepEqual(agent.finishedSubagents.map(run => run.description), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map(i => "Task " + i));
  assert.ok(agent.finishedSubagents.every(run => run.done));
  assert.deepEqual(agent.subagents.map(run => run.description), ["Still going"], "the picker's list keeps only unfinished runs");
});

test("a project scope carries every shown project's decisions for the bell", async (t) => {
  const { fake, env } = await setup(t);
  fake.inject(broadcastTopic("second"), JSON.stringify({ v: 1, kind: "approval", from: "claude", harness: "claude", id: "abcdefabcdef", tool: "Bash", summary: "git push", expiresAt: Date.now() + 60_000 }));
  fake.inject(broadcastTopic("demo"), "Question from claude\n\nIMPORTANT, the agent waits for this answer: Ship it?\n\nReply in this topic: reply 123456789abc YOUR ANSWER");
  const ui = createUi({ projects: [loadConfig(env("demo", "operator")), loadConfig(env("second", "operator"))] });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "project=demo", d => d.decisions?.length === 2, ctrl.signal);
  assert.deepEqual(data.decisions.map(item => item.project).sort(), ["demo", "second"]);
  assert.equal(data.view.scope, undefined, "a plain project view, not home");
});

test("createUi takes a thread client per project, so threads work without the postgres store", async (t) => {
  const { env } = await setup(t);
  const thread = { id: "t1", project: "demo", title: "Redesign", sessions: ["claude#0123456789abcdef"], leadSession: "claude#0123456789abcdef" };
  const asked = [];
  const client = cfg => ({
    list: async project => { asked.push(project); return project === cfg.project ? [thread] : []; },
    sync: async () => ({}), get: async () => thread, create: async () => thread, update: async () => thread,
    moveSession: async () => thread, attachPr: async () => thread, detachPr: async () => thread,
  });
  const ui = createUi({ projects: [loadConfig(env("demo", "operator"))], threadClient: client });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "project=demo", d => d.threads?.length === 1, ctrl.signal);
  assert.equal(data.threads[0].title, "Redesign");
  assert.ok(asked.includes("demo"));
});
