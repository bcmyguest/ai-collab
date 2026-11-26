import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { broadcastTopic, loadConfig, sessionLabel } from "../lib/config.mjs";
import { publishActivity } from "../lib/activity.mjs";
import { publishStatus } from "../lib/inbox.mjs";
import { cleanName, sessionName } from "../lib/sessions.ts";
import { listSessions, recordSession } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { fallbackName, isOpenGroup, listedGroups, sessionCounts, sessionState, sessionTree, visibleWake } from "../web/lib/session-state.js";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const NOW = 1_800_000_000_000;
const self = () => {
  const text = readFileSync("/proc/self/stat", "utf8");
  return { pid: process.pid, start: text.slice(text.lastIndexOf(")") + 2).split(" ")[19] };
};

// State events from a UI stream until one passes the check.
async function stateWhere(ui, query, check, signal) {
  const response = ui.events(new Request(`${base}/api/events?${query}`, { signal }));
  for await (const { event, data } of sse(response)) {
    if (event === "problem") throw new Error(data.error);
    if (event === "state" && check(data)) return data;
  }
  throw new Error("stream ended");
}

test("session state: waiting, AFK hold, working by open call or recent activity, idle, offline", () => {
  const online = { online: true };
  assert.equal(sessionState({ ...online, pending: [{ blocking: true }] }, NOW), "waiting");
  assert.equal(sessionState({ ...online, pending: [{ blocking: true, expiresAt: NOW - 1 }] }, NOW), "idle", "an expired approval no longer waits");
  assert.equal(sessionState({ ...online, pending: [{ blocking: false }] }, NOW), "idle", "a plain question does not block");
  assert.equal(sessionState({ ...online, afkHold: true, lastActivityAt: NOW - 1000 }, NOW), "afk");
  assert.equal(sessionState({ online: false, afkHold: true }, NOW), "offline");
  assert.equal(sessionState({ ...online, openCallAt: NOW - 10 * 60_000 }, NOW), "working");
  assert.equal(sessionState({ ...online, openCallAt: NOW - 16 * 60_000 }, NOW), "idle");
  assert.equal(sessionState({ ...online, lastActivityAt: NOW - 59_000 }, NOW), "working");
  assert.equal(sessionState({ ...online, lastActivityAt: NOW - 61_000 }, NOW), "idle");
  assert.equal(sessionState({ online: false, lastActivityAt: NOW - 1000 }, NOW), "working", "registry liveness can lag a fresh event");
  assert.equal(sessionState({ online: false }, NOW), "offline");
  assert.equal(sessionState({ online: true, harness: "opencode", event: "Stop" }, NOW), "offline", "a stopped OpenCode session is not active while its server stays up");
  assert.equal(sessionState({ online: true, harness: "claude", event: "Stop" }, NOW), "idle");
  assert.equal(sessionCounts([{ online: true, harness: "opencode", event: "Stop" }, { online: true, harness: "claude", event: "Stop" }], NOW).running, 0);
  assert.equal(sessionCounts([{ online: true, lastActivityAt: NOW - 1000 }], NOW).running, 1);
});

test("wake banner hides once the session reports after the wake began, or is back online after it ended", () => {
  const waking = { status: "waking", at: NOW };
  assert.equal(visibleWake(waking, { seenAt: NOW - 5, online: false }), waking);
  assert.equal(visibleWake(waking, { seenAt: NOW + 5, online: true }), null, "a hook ran after the wake began");
  assert.equal(visibleWake(waking, { seenAt: NOW - 5, statusAt: NOW + 5 }), null, "a status start after the wake began");
  assert.equal(visibleWake({ status: "succeeded", at: NOW }, { seenAt: NOW - 5, online: true }), null);
  const failed = { status: "failed", at: NOW };
  assert.equal(visibleWake(failed, { seenAt: NOW - 5, online: true }), failed, "a failure keeps its Retry");
  assert.equal(visibleWake(undefined, {}), null);
});

test("names fall back to folder and first prompt words; harness names are cleaned", () => {
  assert.equal(fallbackName("demo", "  Fix the   flaky login test in CI today please "), "demo: Fix the flaky login test in");
  assert.equal(fallbackName("demo", undefined), "demo");
  assert.equal(fallbackName("", ""), "");
  assert.equal(cleanName("Fix\nlogin‮ bug "), "Fix login bug");
  assert.equal(sessionName("claude", { session_title: "Refactor home view" }), "Refactor home view");
  assert.equal(sessionName("cursor", { session_title: "x" }), "");
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-names-"));
  writeFileSync(path.join(home, "session_index.jsonl"), [
    { id: "t-1", thread_name: "add codex to mise", updated_at: "1" }, { id: "t-2", thread_name: "Other", updated_at: "2" },
    { id: "t-1", thread_name: "Add Codex to mise config", updated_at: "3" },
  ].map(line => JSON.stringify(line)).join("\n") + "\n");
  assert.equal(sessionName("codex", { session_id: "t-1" }, { CODEX_HOME: home }), "Add Codex to mise config", "the newest entry wins");
  assert.equal(sessionName("codex", { session_id: "t-9" }, { CODEX_HOME: home }), "");
});

test("session tree: urgent groups first, children nest under their parent and lift its group, cycles stay flat", () => {
  const tree = sessionTree([
    { id: "claude#1", online: true, seenAt: 5 },
    { id: "codex#2", online: true, parent: "claude#1", pending: [{ blocking: true }] },
    { id: "cursor#3", online: false, seenAt: 9 },
    { id: "codex#4", online: true, lastActivityAt: NOW - 1000 },
    { id: "a#5", parent: "a#6" }, { id: "a#6", parent: "a#5" },
  ], NOW);
  assert.deepEqual(tree.map(n => [n.id, n.group]), [["claude#1", "waiting"], ["codex#4", "working"], ["cursor#3", "offline"], ["a#5", "offline"], ["a#6", "offline"]]);
  assert.equal(tree[0].state, "idle");
  assert.deepEqual(tree[0].children.map(n => [n.id, n.state]), [["codex#2", "waiting"]]);
  assert.equal(tree.filter(n => n.id.startsWith("a#")).length, 2, "a parent cycle keeps both at the top level");
});

test("an idle online session is not in an open group", () => {
  const tree = sessionTree([
    { id: "cursor#idle", online: true, seenAt: NOW - 120_000 },
    { id: "cursor#work", online: true, lastActivityAt: NOW - 1000 },
    { id: "cursor#off", online: false, seenAt: NOW },
  ], NOW);
  assert.equal(tree.find(node => node.id === "cursor#idle").state, "idle");
  assert.equal(isOpenGroup("idle"), false);
  const { open, idle } = listedGroups(tree);
  assert.deepEqual(idle.map(node => node.id), ["cursor#idle"]);
  assert.deepEqual([...open.values()].flat().map(node => node.id), ["cursor#work"]);
  assert.equal(open.has("idle"), false);
});

test("home stream covers every project: names, states, subagents, parents, pending cards answered from home", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-home-"));
  const env = (project, peer) => peerEnv(fake, { peer, stateDir, AI_COLLAB_PROJECT: project, AI_COLLAB_PEERS: "claude,codex" });
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-home-root-"));
  const folder = path.join(root, "webapp");
  mkdirSync(folder);
  const ids = { parent: "11111111-0000-4000-8000-000000000001", child: "11111111-0000-4000-8000-000000000002", other: "11111111-0000-4000-8000-000000000003" };
  const claude = { ...loadConfig(env("demo", "claude")), session: sessionLabel(ids.parent) };
  const codex = { ...loadConfig(env("demo", "codex")), session: sessionLabel(ids.child) };
  const other = { ...loadConfig(env("second", "claude")), session: sessionLabel(ids.other) };
  await recordSession(claude, { id: ids.parent, cwd: folder, harness: "claude", event: "SessionStart", proc: self(), name: "Refactor billing" });
  await recordSession(codex, { id: ids.child, cwd: folder, harness: "codex", event: "SessionStart", proc: self(), parent: `claude#${claude.session}` });
  await recordSession(other, { id: ids.other, cwd: folder, harness: "claude", event: "SessionStart" });
  assert.equal(listSessions(claude).find(s => s.session === claude.session).name, "Refactor billing");
  await recordSession(claude, { id: ids.parent, cwd: folder, harness: "claude", event: "PostToolUse", proc: self() });
  assert.equal(listSessions(claude).find(s => s.session === claude.session).name, "Refactor billing", "a later hook without a name keeps it");
  await publishStatus(codex, { event: "start", harness: "codex" });
  await publishActivity(codex, "codex", [{ type: "prompt", input: "Write the migration for invoices table now" }, { type: "tool_call", tool: "Bash", input: { command: "npm test" }, callId: "c1" }]);
  await publishActivity(claude, "claude", [
    { type: "tool_result", tool: "Agent", callId: "p1", output: JSON.stringify({ status: "async_launched", agentId: "run-1", description: "Survey call sites" }) },
    { type: "tool_result", tool: "Grep", callId: "g1", input: { pattern: "invoice" }, output: "hit", agent: { id: "run-1", type: "Explore" } },
  ]);
  // The second project's session asks an important question and is waiting on an approval.
  const approvalId = "abcdefabcdef";
  fake.inject(broadcastTopic("second"), JSON.stringify({ v: 1, kind: "approval", from: "claude", session: other.session, harness: "claude", id: approvalId, tool: "Bash", summary: "git push", expiresAt: Date.now() + 60_000 }));
  fake.inject(broadcastTopic("second"), `Question from claude#${other.session}\n\nIMPORTANT, the agent waits for this answer: Ship it?\n\nReply in this topic: reply 123456789abc YOUR ANSWER`);

  const projects = [loadConfig(env("demo", "operator")), loadConfig(env("second", "operator"))];
  const ui = createUi({ projects });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "view=home", d => d.sessions?.length === 3 && d.sessions.some(s => s.pending.length === 2), ctrl.signal);
  assert.equal(data.view.scope, "home");
  assert.deepEqual(data.messages, []);
  const by = Object.fromEntries(data.sessions.map(s => [s.harness + ":" + s.project, s]));
  assert.equal(by["claude:demo"].name, "Refactor billing");
  assert.equal(by["codex:demo"].name, "webapp: Write the migration for invoices table", "fallback: folder and first prompt words");
  assert.equal(by["codex:demo"].parent, `claude#${claude.session}`);
  assert.ok(by["codex:demo"].openCallAt > 0, "an open tool call");
  assert.deepEqual(by["codex:demo"].lastAction, { tool: "Bash", summary: "npm test", time: by["codex:demo"].lastAction.time });
  assert.deepEqual(by["claude:demo"].subagents.map(r => [r.kind, r.steps, r.description]), [["Explore", 1, "Survey call sites"]]);
  assert.equal(by["claude:demo"].lastAction.subagent, "Explore");
  assert.equal(by["claude:second"].online, false);
  assert.deepEqual(by["claude:second"].pending.map(p => [p.kind, p.blocking, p.project]), [["Approval", true, "second"], ["Question", true, "second"]]);
  assert.deepEqual(data.decisions.map(item => [item.project, item.from, item.kind]), [
    ["second", `claude#${other.session}`, "Approval"], ["second", `claude#${other.session}`, "Question"],
  ]);
  const now = Date.now();
  const tree = sessionTree(data.sessions, now);
  assert.deepEqual(tree.map(n => [n.harness + ":" + n.project, n.group]), [["claude:second", "waiting"], ["claude:demo", "working"]]);
  assert.deepEqual(tree[1].children.map(n => n.harness), ["codex"]);

  // Answer the approval from home: the reply goes to that project's broadcast topic.
  const res = await ui.handle(new Request(`${base}/api/approve`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "second", id: approvalId, decision: "allow" }),
  }), "approve");
  assert.equal(res.status, 201);
  assert.ok(fake.state.publishes.some(p => p.topic === broadcastTopic("second") && p.message === `reply ${approvalId} allow`));
  const after = await stateWhere(ui, "view=home", d => d.sessions?.find(s => s.project === "second")?.pending.length === 1, ctrl.signal);
  assert.equal(after.sessions.find(s => s.project === "second").pending[0].kind, "Question");
  assert.deepEqual(after.decisions.map(item => item.question), ["123456789abc"]);
  const reply = () => ui.handle(new Request(`${base}/api/reply`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ project: "second", question: "123456789abc", body: "Ship it" }),
  }), "reply");
  const responses = await Promise.all([reply(), reply()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.deepEqual(fake.state.publishes.filter(item => item.message === "reply 123456789abc Ship it")
    .map(item => item.topic), [broadcastTopic("second")]);
  await stateWhere(ui, "view=home", data => data.decisions?.length === 0, ctrl.signal);
  const original = await stateWhere(ui, "project=second", data => data.messages.some(item => item.answer === "Ship it"), ctrl.signal);
  assert.equal(original.messages.find(item => item.question === "123456789abc").answer, "Ship it");

  // view=sessions lists one project's cards only.
  const one = await stateWhere(ui, "project=demo&view=sessions", d => d.sessions?.length === 2, ctrl.signal);
  assert.deepEqual(one.sessions.map(s => s.project), ["demo", "demo"]);
  assert.ok(one.agents.every(a => a.name), "every listed session has a name");
});

test("a direct message to an online session carries no wake note; urgent envelopes show as urgent", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-urgent-"));
  const id = "33333333-0000-4000-8000-000000000001";
  const claude = { ...loadConfig(peerEnv(fake, { peer: "claude", stateDir, AI_COLLAB_PEERS: "claude" })), session: sessionLabel(id) };
  await recordSession(claude, { id, cwd: stateDir, harness: "claude", event: "SessionStart", proc: self() });
  fake.inject(broadcastTopic("demo"), JSON.stringify({ v: 1, kind: "msg", from: "operator", to: "all", body: "stop now", urgent: true }));
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "", d => d.messages.length === 1, ctrl.signal);
  assert.equal(data.messages[0].urgent, true);
  const res = await ui.handle(new Request(`${base}/api/send`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ target: `claude#${claude.session}`, body: "hi", urgent: true }),
  }), "send");
  assert.deepEqual((await res.json()).wake, { status: "online" });
});

test("AFK hold: a turn end whose row lands after its stop status is not a hold", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-afk-race-"));
  const id = "22222222-0000-4000-8000-000000000002";
  const claude = { ...loadConfig(peerEnv(fake, { peer: "claude", stateDir, AI_COLLAB_PEERS: "claude" })), session: sessionLabel(id) };
  await recordSession(claude, { id, cwd: stateDir, harness: "claude", event: "Stop", proc: self() });
  fake.inject(broadcastTopic("demo"), JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  await publishStatus(claude, { event: "stop", harness: "claude" });
  await new Promise(r => setTimeout(r, 1100));
  await publishActivity(claude, "claude", [{ type: "stop", input: "turn ended" }]);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "view=sessions", d => d.sessions?.length === 1 && d.sessions[0].lastActivityAt > 0, ctrl.signal);
  assert.equal(data.sessions[0].afkHold, false);
});

test("AFK hold: the Stop hook published hold, the turn ended, and AFK mode is on", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "ai-collab-afk-"));
  const id = "22222222-0000-4000-8000-000000000001";
  const claude = { ...loadConfig(peerEnv(fake, { peer: "claude", stateDir, AI_COLLAB_PEERS: "claude" })), session: sessionLabel(id) };
  await recordSession(claude, { id, cwd: stateDir, harness: "claude", event: "Stop", proc: self() });
  await publishStatus(claude, { event: "hold", harness: "claude" });
  fake.inject(broadcastTopic("demo"), JSON.stringify({ v: 1, kind: "mode", from: "operator", mode: "on", ts: Date.now() }));
  await new Promise(r => setTimeout(r, 1100));
  await publishActivity(claude, "claude", [{ type: "stop", input: "turn ended" }]);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", stateDir, AI_COLLAB_PEERS: "claude" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const data = await stateWhere(ui, "view=sessions", d => d.sessions?.length === 1, ctrl.signal);
  assert.equal(data.sessions[0].afkHold, true);
  assert.equal(sessionState(data.sessions[0], Date.now() + 120_000), "afk");
  await publishStatus(claude, { event: "stop", harness: "claude" });
  const released = await stateWhere(ui, "view=sessions", d => d.sessions?.[0]?.afkHold === false, ctrl.signal);
  assert.equal(sessionState(released.sessions[0], Date.now() + 120_000), "idle");
});
