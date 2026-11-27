// Codex adapter against a fake `codex app-server` (test/helpers/fake-codex-app-server.mjs): no real CLI, no tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import { sessionLabel } from "../lib/config.mjs";
import codexAdapter, { APP_SERVER_ARGS } from "../runner/adapters/codex.mjs";
import { APPROVAL_REQUESTED, APPROVAL_RESOLVED, ERROR, NOTICE, eventProblem, permissionSettings } from "../runner/contract.mjs";

const FAKE = fileURLToPath(new URL("./helpers/fake-codex-app-server.mjs", import.meta.url));

function setup() {
  const logFile = join(mkdtempSync(join(tmpdir(), "codex-adapter-")), "fake.log");
  const events = [];
  const ctx = { emit: (event) => events.push(event), log: () => {}, signal: new AbortController().signal };
  const adapter = codexAdapter({ command: { file: process.execPath, args: [FAKE, ...APP_SERVER_ARGS], version: [FAKE, "--version"] } });
  const env = { PATH: process.env.PATH, FAKE_CODEX_LOG: logFile };
  return { adapter, events, ctx, logFile, env };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const requests = (file, method) => lines(file).filter((e) => e.kind === "request" && e.method === method);
const responses = (file) => lines(file).filter((e) => e.kind === "response");
const starts = (file) => lines(file).filter((e) => e.kind === "start");

async function until(check, ms = 5000) {
  const began = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - began > ms) throw new Error("timed out waiting for an event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const finished = (events, runId) => events.find((e) => e.type === EventType.RUN_FINISHED && e.runId === runId);
const modeOptions = (env, mode = "auto", place = "folder") => ({
  project: "p", cwd: "/tmp", place, permissionMode: mode, permission: permissionSettings("codex", mode, place).settings, env,
});

function expectValid(events) {
  for (const event of events) assert.equal(eventProblem(event), null, JSON.stringify(event));
}

test("the app-server child starts with the thread unload override and the owned marker", () => {
  assert.deepEqual(APP_SERVER_ARGS, ["app-server", "-c", "thread_unload_delay_secs=0"]);
});

test("available reports the CLI version from --version", async () => {
  const { adapter } = setup();
  const result = await adapter.available(process.env);
  assert.equal(result.ok, true);
  assert.match(result.detail, /codex-cli 0\.171\.0/);
});

test("open starts a thread with the mode's policy and sends no prompt", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env, "auto"), ctx);
    assert.equal(handle.nativeId, "thr-1");
    const [start] = requests(logFile, "thread/start");
    assert.equal(start.params.cwd, "/tmp");
    assert.equal(start.params.approvalPolicy, "on-request");
    assert.equal(start.params.approvalsReviewer, "auto_review");
    assert.equal(start.params.sandbox, "workspace-write");
    assert.equal(start.params.ephemeral, false);
    assert.deepEqual(starts(logFile).map((s) => s.owned), ["codex"]);
    assert.deepEqual(starts(logFile)[0].argv, APP_SERVER_ARGS);
    assert.equal(requests(logFile, "turn/start").length, 0);
    assert.equal(events.length, 0);
  } finally {
    await adapter.shutdown();
  }
});

test("full-access maps to the granular policy and danger-full-access", async () => {
  const { adapter, ctx, logFile, env } = setup();
  try {
    await adapter.open(modeOptions(env, "full-access"), ctx);
    const [start] = requests(logFile, "thread/start");
    assert.equal(start.params.sandbox, "danger-full-access");
    assert.equal(start.params.approvalsReviewer, "user");
    assert.deepEqual(Object.keys(start.params.approvalPolicy), ["granular"]);
  } finally {
    await adapter.shutdown();
  }
});

test("an OpenShell session runs with no approvals (never) and full access, so it needs no experimental granular policy", async () => {
  const { adapter, ctx, logFile, env } = setup();
  try {
    const options = modeOptions(env, "full-access", "openshell");
    await assert.rejects(adapter.open(options, ctx), /prepared OpenShell launcher/);
    await assert.rejects(adapter.open({ ...options, sandboxArgv: [process.execPath, FAKE] }, ctx), /prepared OpenShell launcher/);
    assert.deepEqual(starts(logFile), []);
    const openshell = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
    const sandboxArgv = [openshell, "sandbox", "exec", "--no-tty", "-n", "fake", "--", "node", relative(process.cwd(), FAKE), ...APP_SERVER_ARGS];
    const handle = await adapter.open({ ...options, sandboxArgv }, ctx);
    const [start] = requests(logFile, "thread/start");
    assert.equal(start.params.approvalPolicy, "never");
    assert.equal(start.params.sandbox, "danger-full-access");
    await handle.send({ text: "go", runId: "r-openshell" });
    const [turn] = await until(() => { const t = requests(logFile, "turn/start"); return t.length ? t : null; });
    assert.equal(turn.params.approvalPolicy, "never");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
    await handle.close();
  } finally {
    await adapter.shutdown();
  }
});

test("send runs a turn and maps its output to AG-UI events", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "hello" });
    assert.equal(runId, "turn-1");
    await until(() => finished(events, runId));
    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    assert.equal(started.runId, "turn-1");
    assert.equal(started.input.messages[0].content, "hello");
    assert.equal(events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK).delta, "echo: hello");
    assert.deepEqual(events.find((e) => e.type === EventType.STATE_DELTA).delta, [
      { op: "replace", path: "/contextTokens", value: 1234 },
      { op: "replace", path: "/contextWindow", value: 200000 },
    ]);
    assert.deepEqual(finished(events, runId).outcome, { type: "success" });
    const [turn] = requests(logFile, "turn/start");
    assert.equal(turn.params.input[0].text, "hello");
    assert.equal(turn.params.approvalPolicy, "on-request");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite" });
    expectValid(events);
  } finally {
    await adapter.shutdown();
  }
});

test("an approval card allow sends accept and the tool call completes", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "approve: ls" });
    const card = await until(() => events.find((e) => e.name === APPROVAL_REQUESTED));
    assert.equal(card.value.toolCallName, "Bash");
    assert.equal(card.value.summary, "ls");
    await handle.respond(card.value.interruptId, { behavior: "allow" });
    await until(() => finished(events, runId));
    assert.deepEqual(lines(logFile).find((e) => e.kind === "response" && e.result?.decision).result, { decision: "accept" });
    assert.equal(events.find((e) => e.type === EventType.TOOL_CALL_RESULT).content, "ran ls");
    assert.equal(events.find((e) => e.name === APPROVAL_RESOLVED).value.reason, "allowed");
    expectValid(events);
  } finally {
    await adapter.shutdown();
  }
});

test("an approval card deny sends decline", async () => {
  const { adapter, events, ctx, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "approve: rm x" });
    const card = await until(() => events.find((e) => e.name === APPROVAL_REQUESTED));
    await handle.respond(card.value.interruptId, { behavior: "deny" });
    await until(() => finished(events, runId));
    assert.equal(events.find((e) => e.name === APPROVAL_RESOLVED).value.reason, "denied");
    assert.equal(events.find((e) => e.type === EventType.TOOL_CALL_RESULT).content, "");
  } finally {
    await adapter.shutdown();
  }
});

test("compact runs thread/compact/start on the session's own thread and reports its token counts", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    assert.equal(typeof handle.compact, "function");
    const counts = await handle.compact();
    assert.deepEqual(counts, { before: 90000, after: 20000 });
    const [compact] = requests(logFile, "thread/compact/start");
    assert.equal(compact.params.threadId, handle.nativeId);
    // A compaction turn is not a prompt run: it opens no RUN_STARTED/RUN_FINISHED of its own.
    assert.equal(events.filter((e) => e.type === EventType.RUN_STARTED).length, 0);
    // It still reports the compaction as a step so the timeline shows it.
    assert.ok(events.some((e) => e.type === EventType.STEP_FINISHED && e.stepName === "compact"));
    expectValid(events);
  } finally {
    await adapter.shutdown();
  }
});

test("compact refuses while a prompt turn is running", async () => {
  const { adapter, events, ctx, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    await handle.send({ text: "hang" });
    await until(() => events.find((e) => e.type === EventType.RUN_STARTED));
    await assert.rejects(() => handle.compact(), /finish the running turn/);
    await handle.interrupt();
  } finally {
    await adapter.shutdown();
  }
});

test("interrupt ends the run as cancelled", async () => {  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "hang" });
    await until(() => events.find((e) => e.type === EventType.RUN_STARTED));
    await handle.interrupt();
    await until(() => finished(events, runId));
    assert.deepEqual(finished(events, runId).outcome, { type: "cancelled" });
    assert.equal(requests(logFile, "turn/interrupt")[0].params.turnId, runId);
  } finally {
    await adapter.shutdown();
  }
});

test("steer adds input to the running turn with its id as the precondition", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "hang" });
    await until(() => events.find((e) => e.type === EventType.RUN_STARTED));
    await handle.steer({ text: "also this" });
    const [steer] = requests(logFile, "turn/steer");
    assert.equal(steer.params.expectedTurnId, runId);
    assert.equal(steer.params.input[0].text, "also this");
    await handle.interrupt();
    await until(() => finished(events, runId));
  } finally {
    await adapter.shutdown();
  }
});

test("a failed turn becomes RUN_ERROR carrying the run id", async () => {
  const { adapter, events, ctx, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "fail" });
    const error = await until(() => events.find((e) => e.type === EventType.RUN_ERROR));
    assert.equal(error.metadata.aiCollab.runId, runId);
    assert.equal(error.message, "fake turn failure");
    expectValid(events);
  } finally {
    await adapter.shutdown();
  }
});

test("contextUsage is null until a turn reports tokens, then the last count", async () => {
  const { adapter, events, ctx, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    assert.equal(await handle.contextUsage(), null);
    const { runId } = await handle.send({ text: "hi" });
    await until(() => finished(events, runId));
    assert.deepEqual(await handle.contextUsage(), { tokens: 1234, window: 200000 });
  } finally {
    await adapter.shutdown();
  }
});

test("resume reattaches by native id with turns excluded, then takes input", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const nativeId = "thr-9";
    const record = { nativeId, address: `codex#${sessionLabel(nativeId)}`, cwd: "/tmp", place: "folder", permissionMode: "auto" };
    const handle = await adapter.resume(record, ctx, env);
    const [resume] = requests(logFile, "thread/resume");
    assert.equal(resume.params.threadId, "thr-9");
    assert.equal(resume.params.excludeTurns, true);
    const { runId } = await handle.send({ text: "again" });
    await until(() => finished(events, runId));
    assert.equal(requests(logFile, "turn/start")[0].params.threadId, "thr-9");
  } finally {
    await adapter.shutdown();
  }
});

test("a child exit mid-run ends the run as an error, and the next input resumes the thread", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    const { runId } = await handle.send({ text: "crash" });
    const error = await until(() => events.find((e) => e.type === EventType.RUN_ERROR));
    assert.equal(error.metadata.aiCollab.runId, runId);
    const next = await handle.send({ text: "after" });
    await until(() => finished(events, next.runId));
    assert.equal(starts(logFile).length, 2);
    assert.equal(requests(logFile, "thread/resume").at(-1).params.threadId, "thr-1");
    assert.ok(events.some((e) => e.type === EventType.TEXT_MESSAGE_CHUNK && e.delta === "echo: after"));
  } finally {
    await adapter.shutdown();
  }
});

test("a server request the runner does not answer gets a JSON-RPC error and a notice", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    await handle.send({ text: "ask" });
    await until(() => responses(logFile).find((e) => e.error));
    assert.match(responses(logFile).find((e) => e.error).error.message, /does not answer item\/tool\/requestUserInput/);
    assert.ok(events.some((e) => e.name === NOTICE));
  } finally {
    await adapter.shutdown();
  }
});

test("close unsubscribes the thread and declines its open approval", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    await handle.send({ text: "approve: rm -rf x" });
    await until(() => events.find((e) => e.name === APPROVAL_REQUESTED));
    await handle.close();
    assert.equal(responses(logFile).find((e) => e.result?.decision)?.result.decision, "decline");
    assert.equal(requests(logFile, "thread/unsubscribe")[0].params.threadId, "thr-1");
  } finally {
    await adapter.shutdown();
  }
});

test("setPermissionMode emits the mode and applies its policy to the next turn", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  try {
    const handle = await adapter.open(modeOptions(env), ctx);
    await handle.setPermissionMode("full-access");
    assert.deepEqual(events.find((e) => e.type === EventType.STATE_DELTA).delta, [{ op: "replace", path: "/permissionMode", value: "full-access" }]);
    const { runId } = await handle.send({ text: "hi" });
    await until(() => finished(events, runId));
    const [turn] = requests(logFile, "turn/start");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "dangerFullAccess" });
    await assert.rejects(handle.setPermissionMode("bogus"), /no permission mode bogus/);
  } finally {
    await adapter.shutdown();
  }
});

test("listModels and listCommands map the app-server results", async () => {
  const { adapter, env } = setup();
  try {
    assert.deepEqual(await adapter.listModels(env), [{ id: "gpt-fake", label: "GPT Fake", default: true }]);
    assert.deepEqual(await adapter.listCommands("/tmp", env), [{ name: "fake-skill", description: "a fake skill" }]);
  } finally {
    await adapter.shutdown();
  }
});

test("shutdown stops the shared child, and the next open starts a new one", async () => {
  const { adapter, ctx, logFile, env } = setup();
  await adapter.open(modeOptions(env), ctx);
  await adapter.shutdown();
  await adapter.open(modeOptions(env), ctx);
  try {
    assert.equal(starts(logFile).length, 2);
  } finally {
    await adapter.shutdown();
  }
});

test("a session temp dir reaches the thread's commands and sandbox, not the shared app-server", async () => {
  const { adapter, events, ctx, logFile, env } = setup();
  const tmp = mkdtempSync(join(tmpdir(), "codex-session-tmp-"));
  try {
    const handle = await adapter.open(modeOptions({ ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, AI_COLLAB_SESSION_TMPDIR: tmp }, "auto"), ctx);
    const [start] = requests(logFile, "thread/start");
    assert.deepEqual(start.params.config, {
      "shell_environment_policy.set.TMPDIR": tmp, "shell_environment_policy.set.TMP": tmp, "shell_environment_policy.set.TEMP": tmp,
    });
    assert.equal(starts(logFile)[0].tmpdir, process.env.TMPDIR ?? null);
    const { runId } = await handle.send({ text: "hello" });
    await until(() => finished(events, runId));
    const [turn] = requests(logFile, "turn/start");
    assert.deepEqual(turn.params.sandboxPolicy, { type: "workspaceWrite", writableRoots: [tmp] });
  } finally {
    await adapter.shutdown();
  }
});
