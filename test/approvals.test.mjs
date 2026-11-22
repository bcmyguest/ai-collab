import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../lib/config.mjs";
import { approvalMessage, approvalOutput, approvalRequest, decideApproval, parseChoice } from "../lib/approvals.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const QUESTIONS = [{
  question: "Which framework?", header: "Framework", multiSelect: false,
  options: [{ label: "React", description: "Component library", preview: "<App/>" }, { label: "Vue", description: "Progressive framework" }],
}];

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const envelopes = (fake, kind) => fake.state.publishes.map(p => { try { return { ...JSON.parse(p.message), topic: p.topic, title: p.title }; } catch { return null; } })
  .filter(m => m?.kind === kind);

async function published(fake, kind) {
  for (let i = 0; i < 200; i++) {
    const found = envelopes(fake, kind)[0];
    if (found) return found;
    await delay(10);
  }
  throw new Error(`no ${kind} envelope published`);
}

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const env = peerEnv(fake, { peer: "claude", AI_COLLAB_PEERS: "claude,codex,cursor", ...extra });
  return { fake, env, cfg: { ...loadConfig(env), session: SESSION } };
}

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("requests and outputs take each harness's documented shape", () => {
  const bash = approvalRequest("claude", "permissionrequest", { tool_name: "Bash", tool_input: { command: "rm -rf build\necho done", description: "clean" } });
  assert.deepEqual([bash.tool, bash.summary], ["Bash", "rm -rf build"]);
  assert.equal(approvalRequest("codex", "permissionrequest", { tool_name: "shell", tool_input: { command: ["git", "push"] } }).summary, "git push");
  assert.equal(approvalRequest("cursor", "beforeshellexecution", { command: "npm publish", cwd: "/x" }).summary, "npm publish");
  assert.equal(approvalRequest("cursor", "beforemcpexecution", { tool_name: "create_issue", tool_input: "{\"title\":\"x\"}" }).tool, "create_issue");
  assert.equal(approvalRequest("claude", "pretooluse", { tool_name: "Bash" }), null);
  assert.equal(approvalRequest("claude", "permissionrequest", { tool_name: "AskUserQuestion", tool_input: { questions: "bad" } }), null);
  assert.equal(approvalRequest("claude", "permissionrequest", { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }).questions.length, 1);

  assert.deepEqual(approvalOutput("claude", { behavior: "allow" }), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  const deny = approvalOutput("codex", { behavior: "deny" }).hookSpecificOutput.decision;
  assert.deepEqual(Object.keys(deny).sort(), ["behavior", "message"]);
  assert.deepEqual(approvalOutput("claude", null), {});
  assert.deepEqual(approvalOutput("cursor", null), { permission: "ask" });
  assert.equal(approvalOutput("cursor", { behavior: "allow" }).permission, "allow");
  assert.equal(approvalOutput("cursor", { behavior: "deny" }).permission, "deny");
});

test("choice answers: JSON per question, plain text for one question, labels matched, incomplete ignored", () => {
  assert.deepEqual(parseChoice(QUESTIONS, "react"), { "Which framework?": "React" });
  assert.deepEqual(parseChoice(QUESTIONS, "Svelte, please"), { "Which framework?": "Svelte, please" });
  const two = [...QUESTIONS, { question: "Which tests?", header: "Tests", multiSelect: true, options: [{ label: "Unit" }, { label: "E2E" }] }];
  assert.equal(parseChoice(two, "React"), null);
  assert.deepEqual(parseChoice(two, JSON.stringify({ "Which framework?": "Vue", "Which tests?": "unit,e2e" })), { "Which framework?": "Vue", "Which tests?": "Unit, E2E" });
  assert.equal(parseChoice(two, JSON.stringify({ "Which framework?": "Vue" })), null);
});

test("an approval envelope stays within ntfy's limit by shrinking previews", () => {
  const cfg = { peer: "claude", session: SESSION };
  const big = [{ ...QUESTIONS[0], options: Array.from({ length: 4 }, (_, i) => ({ label: "L" + i, description: "d".repeat(300), preview: "p".repeat(2000) })) }];
  const req = approvalRequest("claude", "permissionrequest", { tool_name: "AskUserQuestion", tool_input: { questions: big } });
  const message = approvalMessage(cfg, "claude", req, { id: "0123456789ab", expiresAt: 1 });
  assert.ok(Buffer.byteLength(message) <= 4095);
  assert.equal(JSON.parse(message).questions[0].options.length, 4);
});

test("AFK off: no publish and no decision, so the terminal prompt shows", async (t) => {
  const { fake, cfg } = await setup(t);
  const input = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } };
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input }), {});
  assert.deepEqual(await decideApproval(cfg, { host: "cursor", key: "beforeshellexecution", input: { command: "ls" } }), { permission: "ask" });
  assert.equal(envelopes(fake, "approval").length, 0);
});

test("AFK on: the phone allows; the hook allows, sends a receipt, and closes the request", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const input = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } };
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input });
  const asked = await published(fake, "approval");
  assert.equal(asked.topic, ALL);
  assert.deepEqual([asked.from, asked.session, asked.harness, asked.tool, asked.summary], ["claude", SESSION, "claude", "Bash", "npm test"]);
  assert.match(asked.title, /Approve Bash for claude#aabbccddeeff0011: npm test/);
  fake.inject(ALL, `reply ${asked.id} maybe`);
  const reply = fake.inject(ALL, `reply ${asked.id} allow`);
  assert.deepEqual(await pending, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.equal(envelopes(fake, "approval-end")[0].reason, "allowed");
  await delay(50);
  assert.ok(envelopes(fake, "receipt").some(r => r.ids.includes(reply.id)));
});

test("Codex deny carries only behavior and message", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_PEER: "codex" });
  setMode(fake, "quiet");
  const pending = decideApproval(cfg, { host: "codex", key: "permissionrequest", input: { tool_name: "shell", tool_input: { command: "git push" } } });
  fake.inject(ALL, `reply ${(await published(fake, "approval")).id} deny`);
  assert.deepEqual(Object.keys((await pending).hookSpecificOutput.decision).sort(), ["behavior", "message"]);
  assert.equal(envelopes(fake, "approval-end")[0].reason, "denied");
});

test("no answer, AFK turned off, or the hook killed: no decision", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  const input = { tool_name: "Bash", tool_input: { command: "ls" } };
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input }), {});
  assert.equal(envelopes(fake, "approval-end")[0].reason, "timeout");

  const long = { ...cfg, approvalS: 60 };
  const off = decideApproval(long, { host: "claude", key: "permissionrequest", input });
  await delay(100);
  await published(fake, "approval");
  setMode(fake, "off");
  assert.deepEqual(await off, {});
  assert.equal(envelopes(fake, "approval-end")[1].reason, "afk-off");

  setMode(fake, "on");
  const ctrl = new AbortController();
  const killed = decideApproval(long, { host: "claude", key: "permissionrequest", input, signal: ctrl.signal });
  await delay(100);
  ctrl.abort();
  assert.deepEqual(await killed, {});
  assert.equal(envelopes(fake, "approval-end")[2].reason, "cancelled");
});

test("Claude AskUserQuestion: the phone's answers come back in updatedInput with the questions", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const input = { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } };
  const pending = decideApproval(cfg, { host: "claude", key: "permissionrequest", input });
  const asked = await published(fake, "approval");
  assert.equal(asked.questions[0].options[0].preview, "<App/>");
  fake.inject(ALL, `reply ${asked.id} ${JSON.stringify({ "Which framework?": "Vue" })}`);
  const { decision } = (await pending).hookSpecificOutput;
  assert.deepEqual(decision, { behavior: "allow", updatedInput: { questions: QUESTIONS, answers: { "Which framework?": "Vue" } } });
  assert.equal(envelopes(fake, "approval-end")[0].reason, "answered");
});

test("the hook script maps PermissionRequest and Cursor permission events", async (t) => {
  const { fake, env } = await setup(t);
  const claude = await runHook(["--host", "claude"], { hook_event_name: "PermissionRequest", session_id: "s-1", cwd: "/tmp", tool_name: "Bash", tool_input: { command: "ls" } }, env);
  assert.deepEqual(JSON.parse(claude.out), {});
  const cursorEnv = { ...env, AI_COLLAB_PEER: "cursor" };
  const cursor = await runHook(["--host", "cursor"], { hook_event_name: "beforeShellExecution", conversation_id: "c-1", cwd: "/tmp", command: "ls" }, cursorEnv);
  assert.deepEqual(JSON.parse(cursor.out), { permission: "ask" });
  const disabled = await runHook(["--host", "cursor"], { hook_event_name: "beforeMCPExecution", command: "x" }, { PATH: process.env.PATH, HOME: env.HOME });
  assert.deepEqual(JSON.parse(disabled.out), { permission: "ask" });

  setMode(fake, "on");
  const running = runHook(["--host", "claude"], { hook_event_name: "PermissionRequest", session_id: "s-2", cwd: "/tmp", tool_name: "Write", tool_input: { file_path: "/tmp/x" } }, env);
  fake.inject(ALL, `reply ${(await published(fake, "approval")).id} yes`);
  assert.equal(JSON.parse((await running).out).hookSpecificOutput.decision.behavior, "allow");
});

test("the UI shows approval cards with their outcome and answers them through the phone reply", async (t) => {
  const { fake, cfg } = await setup(t);
  const ui = createUi({ cfg: loadConfig(peerEnv(fake, { peer: "operator", AI_COLLAB_PEERS: "claude,codex,cursor" })) });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const base = "http://127.0.0.1:8795";
  const post = (body) => ui.handle(new Request(`${base}/api/approve`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "approve");
  setMode(fake, "on");
  const bash = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "Bash", tool_input: { command: "make" } } });
  const asked = await published(fake, "approval");
  const choice = decideApproval(cfg, { host: "claude", key: "permissionrequest", input: { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } } });
  await delay(50);
  const choiceId = envelopes(fake, "approval").find(e => e.questions).id;

  // Reads state events until check holds for the approval cards.
  const stream = sse(ui.events(new Request(`${base}/api/events`, { signal: ctrl.signal })));
  async function until(check) {
    for (;;) {
      const { done, value } = await stream.next();
      if (done) throw new Error("stream ended");
      if (value.event === "problem") throw new Error(value.data.error);
      if (value.event !== "state") continue;
      const state = value.data;
      const cards = state.messages.filter(m => m.kind === "Approval");
      if (check(cards)) return { cards, state };
    }
  }
  const { cards } = await until(list => list.length === 2);
  assert.deepEqual(cards.map(c => c.approval.state), ["pending", "pending"]);
  assert.equal(cards[0].from, `claude#${SESSION}`);
  assert.equal(cards[0].approval.tool, "Bash");

  assert.equal((await post({ id: asked.id, decision: "maybe" })).status, 400);
  assert.equal((await post({ id: "ffffffffffff", decision: "allow" })).status, 404);
  assert.equal((await post({ id: choiceId, answers: { "Other question?": "x" } })).status, 400);
  assert.equal((await post({ id: asked.id, decision: "deny" })).status, 201);
  assert.equal((await bash).hookSpecificOutput.decision.behavior, "deny");
  assert.equal((await post({ id: choiceId, answers: { "Which framework?": "Vue" } })).status, 201);
  assert.equal((await choice).hookSpecificOutput.decision.updatedInput.answers["Which framework?"], "Vue");

  const done = await until(list => list.every(c => !["pending", "sent"].includes(c.approval.state)));
  assert.deepEqual(done.cards.map(c => [c.approval.state, c.approval.decision]), [["denied", "deny"], ["answered", "allow"]]);
  assert.deepEqual(done.cards[1].approval.answers, { "Which framework?": "Vue" });
  assert.ok(!done.state.messages.some(m => m.kind === "Reply"), "approval replies fold into their card");
  assert.equal((await post({ id: asked.id, decision: "allow" })).status, 409, "a closed request takes no answer");
});
