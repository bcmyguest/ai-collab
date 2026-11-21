import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { loadConfig } from "../lib/config.mjs";
import { sendMessage } from "../lib/inbox.mjs";

const HOOK = fileURLToPath(new URL("../scripts/ai-collab-hook.mjs", import.meta.url));

function runHook(args, input, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { errOut += d; });
    child.on("close", (code) => resolve({ code, out, errOut, ms: Date.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function setup(t, extra = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const aliceEnv = peerEnv(fake, { peer: "alice", ...extra });
  const bobEnv = peerEnv(fake, { peer: "bob", ...extra });
  return { fake, aliceEnv, bobEnv };
}

test("claude SessionStart: publishes start status, injects labelled inbox, one stdout line", async (t) => {
  const { fake, aliceEnv, bobEnv } = await setup(t);
  await sendMessage(loadConfig(bobEnv), "alice", "ping from bob");

  const r = await runHook(["--host", "claude"], {
    hook_event_name: "SessionStart",
    session_id: "s-1",
    cwd: "/home/secret-user/private-project",
    transcript_path: "/tmp/SECRET-TRANSCRIPT.jsonl",
    prompt: "SECRET-PROMPT",
  }, aliceEnv);

  assert.equal(r.code, 0);
  assert.equal(r.out.trim().split("\n").length, 1);
  const obj = JSON.parse(r.out);
  assert.equal(obj.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(obj.hookSpecificOutput.additionalContext, /from=bob/);
  assert.match(obj.hookSpecificOutput.additionalContext, /body="ping from bob"/);
  assert.match(obj.hookSpecificOutput.additionalContext, /untrusted data/);

  const statusPub = fake.state.publishes.find((p) => p.topic === "ai-collab-demo--status");
  assert.ok(statusPub, "status published");
  const status = JSON.parse(statusPub.message);
  assert.equal(status.event, "start");
  assert.equal(status.harness, "claude");
  const everything = JSON.stringify(fake.state.publishes);
  for (const leak of ["/home/secret-user", "private-project", "SECRET-TRANSCRIPT", "SECRET-PROMPT", "session_id", "s-1"]) {
    assert.ok(!everything.includes(leak), `leaked ${leak}`);
  }
});

test("claude UserPromptSubmit: throttled inbox read, publishes the prompt only as activity", async (t) => {
  const { fake, aliceEnv, bobEnv } = await setup(t);
  await sendMessage(loadConfig(bobEnv), "alice", "first");
  const r = await runHook(["--host", "claude"], { hook_event_name: "UserPromptSubmit", prompt: "SECRET-PROMPT" }, aliceEnv);
  const obj = JSON.parse(r.out);
  assert.equal(obj.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(obj.hookSpecificOutput.additionalContext, /body="first"/);
  assert.equal(fake.state.publishes.some((p) => p.topic !== "ai-collab-demo--activity" && p.message.includes("SECRET-PROMPT")), false);

  await sendMessage(loadConfig(bobEnv), "alice", "second");
  const again = await runHook(["--host", "claude"], { hook_event_name: "UserPromptSubmit" }, aliceEnv);
  assert.deepEqual(JSON.parse(again.out), {}, "inside the throttle window nothing is fetched");
});

test("claude PostToolUse returns hookSpecificOutput with PostToolUse; tool data is ignored", async (t) => {
  const { aliceEnv, bobEnv } = await setup(t);
  await sendMessage(loadConfig(bobEnv), "alice", "after tool");
  const r = await runHook(["--host", "claude"], {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo SECRET-COMMAND" },
    tool_response: { stdout: "SECRET-OUTPUT" },
  }, aliceEnv);
  const obj = JSON.parse(r.out);
  assert.equal(obj.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(obj.hookSpecificOutput.additionalContext, /after tool/);
  assert.doesNotMatch(obj.hookSpecificOutput.additionalContext, /SECRET-COMMAND|SECRET-OUTPUT/);
});

test("claude Stop publishes a stop status and returns {} (never blocks the agent)", async (t) => {
  const { fake, aliceEnv } = await setup(t);
  const r = await runHook(["--host", "claude"], { hook_event_name: "Stop", stop_hook_active: false }, aliceEnv);
  assert.equal(r.out.trim(), "{}");
  const pub = fake.state.publishes.find((p) => p.topic === "ai-collab-demo--status");
  assert.equal(JSON.parse(pub.message).event, "stop");
});

test("cursor sessionStart and postToolUse use additional_context; stop publishes", async (t) => {
  const { fake, aliceEnv, bobEnv } = await setup(t);
  await sendMessage(loadConfig(bobEnv), "alice", "cursor msg");
  const s = await runHook(["--host", "cursor"], { hook_event_name: "sessionStart", conversation_id: "c1" }, aliceEnv);
  const so = JSON.parse(s.out);
  assert.equal(so.hookSpecificOutput, undefined);
  assert.match(so.additional_context, /body="cursor msg"/);

  await sendMessage(loadConfig(bobEnv), "alice", "tool msg");
  const p = await runHook(["--host", "cursor"], { hook_event_name: "postToolUse" }, { ...aliceEnv, AI_COLLAB_POLL_INTERVAL_MS: "0" });
  assert.match(JSON.parse(p.out).additional_context, /body="tool msg"/);

  const st = await runHook(["--host", "cursor"], { hook_event_name: "stop" }, aliceEnv);
  assert.equal(st.out.trim(), "{}");
  assert.ok(fake.state.publishes.some((x) => JSON.parse(x.message).event === "stop"));
});

test("codex SessionStart and UserPromptSubmit use the codex host label", async (t) => {
  const { fake, aliceEnv } = await setup(t);
  const r = await runHook(["--host", "codex"], { hook_event_name: "SessionStart" }, aliceEnv);
  assert.equal(r.out.trim(), "{}", "empty inbox yields no context");
  const st = fake.state.publishes.find((p) => p.topic === "ai-collab-demo--status");
  assert.equal(JSON.parse(st.message).harness, "codex");
});

test("disabled (no project/peer): prints {} and makes no requests", async (t) => {
  const { fake } = await setup(t);
  const before = fake.state.requests;
  const r = await runHook(["--host", "claude"], { hook_event_name: "SessionStart" }, { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "ai-collab-home-")), AI_COLLAB_URL: fake.url });
  assert.equal(r.out.trim(), "{}");
  assert.equal(r.code, 0);
  assert.equal(fake.state.requests, before);
});

test("fail open: unreachable server returns {} quickly with exit 0", async (t) => {
  const { aliceEnv } = await setup(t, { AI_COLLAB_URL: "http://127.0.0.1:1", AI_COLLAB_TIMEOUT_MS: "500" });
  const r = await runHook(["--host", "claude"], { hook_event_name: "SessionStart" }, aliceEnv);
  assert.equal(r.code, 0);
  assert.equal(r.out.trim(), "{}");
  assert.ok(r.ms < 8000, `took ${r.ms}ms`);
});

test("malformed stdin, unknown events, and PreToolUse all return {}; only PreToolUse publishes, as activity", async (t) => {
  const { fake, aliceEnv } = await setup(t);
  const before = fake.state.requests;
  assert.equal((await runHook(["--host", "codex"], "not json", aliceEnv)).out.trim(), "{}");
  assert.equal((await runHook(["--host", "claude"], { hook_event_name: "constructor" }, aliceEnv)).out.trim(), "{}");
  assert.equal(fake.state.requests, before);
  assert.equal((await runHook(["--host", "claude"], { hook_event_name: "PreToolUse" }, aliceEnv)).out.trim(), "{}");
  assert.deepEqual(fake.state.publishes.map((p) => p.topic), ["ai-collab-demo--activity"]);
});

test("configured hooks deliver phone posts to each session and identify outbound messages", async (t) => {
  const fake = await startFakeNtfy({ token: "fixture-only" });
  const root = mkdtempSync(join(tmpdir(), "ai-collab-hooks-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); return fake.close(); });
  const config = join(root, "ai-collab");
  const cwd = join(root, "source");
  const tokenFile = join(root, "token");
  mkdirSync(config);
  writeFileSync(tokenFile, "fixture-only");
  writeFileSync(join(config, "projects.json"), JSON.stringify([
    { root: cwd, project: "fixture", url: fake.url, tokenFile },
  ]));
  const env = { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root, AI_COLLAB_POLL_INTERVAL_MS: "0" };
  fake.inject("ai-collab-fixture--to--all", "Please post a status update");

  const sessions = [
    ["cursor", "postToolUse", { conversation_id: "raw-cursor-1" }],
    ["cursor", "postToolUse", { conversation_id: "raw-cursor-2" }],
    ["codex", "UserPromptSubmit", { session_id: "raw-codex" }],
    ["claude", "UserPromptSubmit", { session_id: "raw-claude" }],
  ];
  const labels = [];
  for (const [host, event, ids] of sessions) {
    const input = { cwd: join(cwd, "subdir"), hook_event_name: event, ...ids };
    const out = JSON.parse((await runHook(["--host", host], input, env)).out);
    const first = { additional_context: out.hookSpecificOutput?.additionalContext ?? out.additional_context };
    assert.match(first.additional_context, /from=ntfy.*Please post a status update/);
    const label = first.additional_context.match(/AI_COLLAB_SESSION=([a-f0-9]{16})/)?.[1];
    assert.ok(label);
    labels.push(label);
    assert.doesNotMatch(first.additional_context, /raw-cursor|raw-codex|raw-claude/);
    assert.deepEqual(JSON.parse((await runHook(["--host", host], input, env)).out), {});
  }
  assert.equal(new Set(labels).size, sessions.length);

  const outside = { cwd: cwd + "-other", hook_event_name: "UserPromptSubmit", session_id: "outside" };
  assert.deepEqual(JSON.parse((await runHook(["--host", "codex"], outside, env)).out), {});

  const firstCursor = loadConfig({ ...env, AI_COLLAB_PEER: "cursor", AI_COLLAB_SESSION: labels[0] }, { cwd });
  await sendMessage(firstCursor, "all", "Here is my status");
  assert.match(fake.state.publishes.at(-1).title, new RegExp(`cursor#${labels[0]}`));
  const secondCursor = JSON.parse((await runHook(["--host", "cursor"], {
    cwd, hook_event_name: "postToolUse", conversation_id: "raw-cursor-2",
  }, env)).out);
  assert.match(secondCursor.additional_context, new RegExp(`from=cursor#${labels[0]}.*Here is my status`));
});
