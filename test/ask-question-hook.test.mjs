import { parseWireEnvelope } from "../lib/agui.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../lib/config.mjs";
import { decideApproval, decideQuestion } from "../lib/approvals.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));
const HOOKS = JSON.parse(readFileSync(fileURLToPath(new URL("../hooks/hooks.json", import.meta.url)), "utf8"));
const ALL = "ai-collab-demo--to--all";
const SESSION = "aabbccddeeff0011";
const QUESTIONS = [
  { question: "Which framework?", header: "Framework", multiSelect: false, options: [{ label: "React", description: "Component library" }, { label: "Vue" }] },
  { question: "Which tests?", header: "Tests", multiSelect: true, options: [{ label: "Unit" }, { label: "E2E", description: "Browser" }, { label: "None" }] },
];

const setMode = (fake, mode) => fake.inject(ALL, JSON.stringify({ v: 1, kind: "mode", from: "operator", mode, ts: Date.now() }));
const envelopes = (fake, kind) => fake.state.publishes.map((p) => { try { return { ...parseWireEnvelope(p.message), topic: p.topic, title: p.title }; } catch { return null; } })
  .filter((m) => m?.kind === kind);

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

test("PreToolUse has a blocking AskUserQuestion matcher beside the async activity entry", () => {
  const [activity, question] = HOOKS.hooks.PreToolUse;
  assert.equal(activity.hooks[0].async, true);
  assert.equal(activity.matcher, undefined);
  assert.equal(question.matcher, "AskUserQuestion");
  assert.equal(question.hooks[0].async, undefined);
  assert.match(question.hooks[0].command, /ai-collab-hook\.mjs" --host claude$/);
});

test("AFK on: the choice card carries every question, and the phone's answers come back as allow with updatedInput.answers", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "on");
  const pending = decideQuestion(cfg, { input: { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS }, tool_use_id: "toolu_a" } });
  const asked = await published(fake, "approval");
  assert.deepEqual(asked.questions.map((q) => [q.multiSelect, q.options.length]), [[false, 2], [true, 3]]);
  assert.equal(asked.questions[1].options[1].description, "Browser");
  fake.inject(ALL, `reply ${asked.id} ${JSON.stringify({ "Which framework?": "Vue", "Which tests?": "Unit, Other tests" })}`);
  assert.deepEqual(await pending, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow",
      updatedInput: { questions: QUESTIONS, answers: { "Which framework?": "Vue", "Which tests?": "Unit, Other tests" } },
    },
  });
  assert.equal(envelopes(fake, "approval-end")[0].reason, "answered");
});

test("AFK off: a view-only card, and the terminal dialog answers (no decision)", async (t) => {
  const { fake, cfg } = await setup(t);
  setMode(fake, "off");
  const out = await decideQuestion(cfg, { input: { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS }, tool_use_id: "toolu_b" } });
  assert.deepEqual(out, {});
  const view = await published(fake, "approval-view");
  assert.equal(view.mode, "terminal");
  assert.equal(view.questions.length, 2);
  assert.equal(envelopes(fake, "approval").length, 0);
});

test("a PreToolUse without an answer posts no second card from its PermissionRequest", async (t) => {
  const { fake, cfg } = await setup(t, { AI_COLLAB_APPROVAL_S: "1" });
  setMode(fake, "on");
  const input = { tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS }, tool_use_id: "toolu_c" };
  assert.deepEqual(await decideQuestion(cfg, { input }), {});
  assert.deepEqual(await decideApproval(cfg, { host: "claude", key: "permissionrequest", input }), {});
  assert.equal(envelopes(fake, "approval").length, 1);
});

test("the hook script answers a PreToolUse AskUserQuestion with the phone's answers", async (t) => {
  const { fake, env } = await setup(t);
  setMode(fake, "on");
  const running = runHook(["--host", "claude"], {
    hook_event_name: "PreToolUse", session_id: "s-ask", cwd: "/tmp", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS }, tool_use_id: "toolu_d",
  }, env);
  const asked = await published(fake, "approval");
  fake.inject(ALL, `reply ${asked.id} ${JSON.stringify({ "Which framework?": "React", "Which tests?": "None" })}`);
  const out = JSON.parse((await running).out);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(out.hookSpecificOutput.updatedInput.answers, { "Which framework?": "React", "Which tests?": "None" });
});
