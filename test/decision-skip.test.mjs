// The UI's Skip action: closes an open approval, choice, question, limit card or task question without answering it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { broadcastTopic, loadProjects } from "../lib/config.mjs";
import { alertLimit, cardFile, chooseLimit, readCard } from "../lib/limit-alert.ts";
import { addTask, askTask, openTasks, readStore, taskStoreFile, writeStore } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const SESSION = "aabbccddeeff0011";
const OTHER = "1111222233334444";
const PERMISSION = "aaaaaaaaaaaa";
const CHOICE = "bbbbbbbbbbbb";
const QUESTION = "cccccccccccc";
const OWNED = "dddddddddddd";
const TOPIC = broadcastTopic("demo");

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-skip-"));
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,codex" }]));
  const env = { HOME: home, PATH: process.env.PATH, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha" }, 1);
  addTask(doc, { id: "beta", title: "Beta" }, 1);
  askTask(doc, "alpha", { text: "Ship it?", options: ["Yes", "No"], by: `claude#${SESSION}` }, 2);
  writeStore(taskStoreFile("demo", env), doc);
  const projects = loadProjects(env, { host: "operator" });
  const ui = createUi({ projects, env });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const post = (action, body) => ui.handle(new Request(`${base}/api/${action}`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", ...body }),
  }), action);
  async function stateWhere(query, check) {
    for await (const { event, data } of sse(ui.events(new Request(`${base}/api/events?${query}`, { signal: ctrl.signal })))) {
      if (event === "problem") throw new Error(data.error);
      if (event === "state" && check(data)) return data;
    }
    throw new Error("stream ended");
  }
  return { fake, env, cfg: projects[0], post, stateWhere };
}

const approval = (id, extra = {}) => JSON.stringify({ v: 1, kind: "approval", from: "claude", session: SESSION, harness: "claude", id, tool: "Bash", summary: "git push", expiresAt: Date.now() + 600_000, ...extra });
const ends = (fake) => fake.state.publishes.flatMap((p) => { try { const m = parseWireEnvelope(p.message); return m.kind === "approval-end" ? [m] : []; } catch { return []; } });

test("Skip closes a permission request and a question with a skipped end, and sends no reply", async (t) => {
  const { fake, post, stateWhere } = await setup(t);
  fake.inject(TOPIC, approval(PERMISSION));
  fake.inject(TOPIC, approval(CHOICE, { tool: "AskUserQuestion", summary: "Which?", questions: [{ question: "Which?", header: "", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] }));
  fake.inject(TOPIC, `Question from claude#${SESSION}\n\nShip it?\n\nReply in this topic: reply ${QUESTION} YOUR ANSWER`);
  fake.inject(TOPIC, approval(OWNED, { owned: true }));
  await stateWhere("view=home", (d) => d.decisions?.length === 4);

  assert.equal((await post("skip", { id: PERMISSION })).status, 201);
  assert.equal((await post("skip", { id: CHOICE })).status, 201);
  assert.equal((await post("skip", { id: QUESTION })).status, 201);
  assert.deepEqual(ends(fake).map((m) => [m.id, m.reason, m.from]), [[PERMISSION, "skipped", "operator"], [CHOICE, "skipped", "operator"], [QUESTION, "skipped", "operator"]]);
  assert.ok(!fake.state.publishes.some((p) => p.message.startsWith("reply ")), "a skip is not an answer");

  assert.equal((await post("skip", { id: PERMISSION })).status, 409, "a skipped request is closed");
  assert.equal((await post("approve", { id: PERMISSION, decision: "allow" })).status, 409, "a skipped request takes no answer");
  assert.equal((await post("skip", { id: QUESTION })).status, 409);
  assert.equal((await post("reply", { question: QUESTION, body: "Yes" })).status, 409);
  assert.equal((await post("skip", { id: OWNED })).status, 409, "a runner session has no terminal prompt to fall back on");
  assert.equal((await post("skip", { id: "nope" })).status, 400);

  const home = await stateWhere("view=home", (d) => d.decisions?.length === 1);
  assert.deepEqual(home.decisions.map((d) => d.key), [OWNED]);
  const chat = await stateWhere("project=demo", (d) => d.messages?.some((m) => m.question === QUESTION && m.skipped));
  const states = Object.fromEntries(chat.messages.filter((m) => m.kind === "Approval").map((m) => [m.approval.id, m.approval.state]));
  assert.deepEqual(states, { [PERMISSION]: "skipped", [CHOICE]: "skipped", [OWNED]: "pending" });
});

test("Skip clears a task question with a progress line and posts nothing to the channel", async (t) => {
  const { fake, env, post } = await setup(t);
  const sent = fake.state.publishes.length;
  assert.equal((await post("skip", { taskId: "alpha" })).status, 201);
  const alpha = readStore(taskStoreFile("demo", env)).tasks.find((task) => task.id === "alpha");
  assert.equal(alpha.question, undefined);
  assert.deepEqual([alpha.progress.at(-1).by, alpha.progress.at(-1).text], ["operator", "Skipped by operator"]);
  assert.equal((await post("skip", { taskId: "alpha" })).status, 409, "the question is gone");
  assert.equal((await post("skip", { taskId: "beta" })).status, 409, "a task with no question has nothing to skip");
  assert.equal(fake.state.publishes.length, sent);
});

test("Skip succeeds without publishing or writing progress when the decision record is gone", async (t) => {
  const { fake, env, post } = await setup(t);
  await openTasks("demo", env).remove("alpha");
  const before = readStore(taskStoreFile("demo", env));
  const sent = fake.state.publishes.length;
  const decision = await post("skip", { id: QUESTION });
  assert.equal(decision.status, 201);
  assert.deepEqual(await decision.json(), { status: "Skipped" });
  const task = await post("skip", { taskId: "alpha" });
  assert.equal(task.status, 201);
  assert.deepEqual(await task.json(), { status: "Skipped", detail: "alpha" });
  assert.deepEqual(readStore(taskStoreFile("demo", env)), before);
  assert.equal(fake.state.publishes.length, sent);
});

test("Skip closes a visible limit card whose stored record was removed", async (t) => {
  const { fake, cfg, post, stateWhere } = await setup(t);
  const deps = { listed: async () => ({ claude: ["sonnet"] }), available: () => ["claude", "codex"] };
  const limit = { window: null, windowName: null, resetsAt: null, wording: true, verified: true, source: "test" };
  const card = await alertLimit({ ...cfg, peer: "codex", session: SESSION }, { harness: "codex", limit, ...deps });
  await stateWhere("view=home", (d) => d.decisions?.some((x) => x.key === card.id));
  unlinkSync(cardFile(cfg, card.id));
  const response = await post("skip", { id: card.id });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { status: "Skipped" });
  assert.equal(readCard(cfg, card.id), null);
  assert.deepEqual(ends(fake).map((m) => [m.id, m.reason]), [[card.id, "skipped"]]);
});

test("Skip closes a visible limit card whose stored record is corrupt", async (t) => {
  const { fake, cfg, post, stateWhere } = await setup(t);
  const deps = { listed: async () => ({ claude: ["sonnet"] }), available: () => ["claude", "codex"] };
  const limit = { window: null, windowName: null, resetsAt: null, wording: true, verified: true, source: "test" };
  const card = await alertLimit({ ...cfg, peer: "codex", session: SESSION }, { harness: "codex", limit, ...deps });
  await stateWhere("view=home", (d) => d.decisions?.some((x) => x.key === card.id));
  writeFileSync(cardFile(cfg, card.id), "{\"id\": \"truncated");
  const response = await post("skip", { id: card.id });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { status: "Skipped" });
  assert.equal(readCard(cfg, card.id), null);
  assert.deepEqual(ends(fake).map((m) => [m.id, m.reason]), [[card.id, "skipped"]]);
});

test("Skip closes a limit card: no pick is possible afterwards, and the next report opens a fresh card", async (t) => {
  const { fake, cfg, post, stateWhere } = await setup(t);
  const deps = { listed: async () => ({ claude: ["sonnet"] }), available: () => ["claude", "codex"] };
  const untyped = { window: null, windowName: null, resetsAt: null, wording: true, verified: true, source: "test" };
  const card = await alertLimit({ ...cfg, peer: "codex", session: SESSION }, { harness: "codex", limit: untyped, ...deps });
  await stateWhere("view=home", (d) => d.decisions?.some((x) => x.key === card.id));
  assert.equal((await post("skip", { id: card.id })).status, 201);
  assert.equal(readCard(cfg, card.id).skipped, true);
  assert.equal(ends(fake).at(-1).reason, "skipped");
  assert.equal((await chooseLimit(cfg, { id: card.id, label: "claude:sonnet", start: async () => ({ status: "started", session: "x#y" }) })).status, "failed");
  const next = await alertLimit({ ...cfg, peer: "codex", session: OTHER }, { harness: "codex", limit: untyped, ...deps });
  assert.equal(next.status, "sent");
  assert.equal(next.sessions, 1, "a skipped card takes no new sessions");
});
