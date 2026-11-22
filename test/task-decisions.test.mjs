import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../lib/cli.mjs";
import { loadProjects } from "../lib/config.mjs";
import { addTask, answerTask, askTask, needsDecision, readStore, taskStoreFile, validateTasks, writeStore } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8795";
const PM = "cursor#0123456789abcdef";

test("a task question waits on the operator until answered; the answer also lands as a progress line", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha" }, 1);
  askTask(doc, "alpha", { text: "Ship behind a flag?", options: ["Yes", " No "], by: PM }, 2);
  validateTasks(doc);
  const task = doc.tasks[0];
  assert.deepEqual(task.question, { text: "Ship behind a flag?", by: PM, at: 2, options: ["Yes", "No"] });
  assert.equal(needsDecision(task), true);
  answerTask(doc, "alpha", { text: "No", by: "operator" }, 3);
  validateTasks(doc);
  assert.deepEqual(task.question.answer, { text: "No", by: "operator", at: 3 });
  assert.equal(needsDecision(task), false);
  assert.deepEqual(task.progress.at(-1), { at: 3, by: "operator", text: "Decision: No" });
  askTask(doc, "alpha", null, 4);
  assert.equal(task.question, undefined, "null clears the question");
  assert.throws(() => answerTask(doc, "alpha", { text: "x", by: "operator" }, 5), /no question/);
});

test("the store refuses a malformed question", () => {
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha" }, 1);
  doc.tasks[0].question = { text: "two\nlines", by: PM, at: 1 };
  assert.throws(() => validateTasks(doc), /question/);
  doc.tasks[0].question = { text: "ok", by: PM, at: 1, options: Array(7).fill("x") };
  assert.throws(() => validateTasks(doc), /options/);
});

test("task ask puts a question with options on a task, and --clear removes it", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-task-ask-"));
  mkdirSync(path.join(home, "repo"));
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: path.join(home, "repo"), project: "demo" }]));
  const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "cursor", AI_COLLAB_SESSION: "0123456789abcdef", AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const cli = (...argv) => runCli(["task", ...argv], { env, stdout: { write() {} }, stderr: { write() {} } });
  const store = taskStoreFile("demo", env);
  assert.equal(await cli("add", "Alpha"), 0);
  assert.equal(await cli("ask", "alpha", "Which", "store?", "--option", "SQLite", "--option", "JSON file"), 0);
  assert.deepEqual(readStore(store).tasks[0].question.options, ["SQLite", "JSON file"]);
  assert.equal(readStore(store).tasks[0].question.text, "Which store?");
  assert.equal(readStore(store).tasks[0].question.by, PM);
  assert.equal(await cli("ask", "alpha", "--bogus"), 1);
  assert.equal(await cli("ask", "alpha", "--clear"), 0);
  assert.equal(readStore(store).tasks[0].question, undefined);
});

test("the UI decide route stores the operator's answer on the task without starting any agent", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-ui-decide-"));
  const root = path.join(home, "project");
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  mkdirSync(root);
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { HOME: home, PATH: process.env.PATH, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha" }, 1);
  addTask(doc, { id: "beta", title: "Beta" }, 1);
  askTask(doc, "alpha", { text: "Ship it?", options: ["Yes", "No"], by: PM }, 2);
  writeStore(taskStoreFile("demo", env), doc);
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env });
  t.after(() => ui.close());
  const post = body => ui.handle(new Request(`${base}/api/decide`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", ...body }),
  }), "decide");
  const sent = fake.published?.length ?? 0;
  assert.equal((await post({ id: "alpha", answer: "Yes" })).status, 201);
  const alpha = readStore(taskStoreFile("demo", env)).tasks.find(task => task.id === "alpha");
  assert.equal(alpha.question.answer.text, "Yes");
  assert.equal(alpha.question.answer.by, "operator");
  assert.equal((await post({ id: "beta", answer: "Yes" })).status, 400, "a task with no question cannot be answered");
  assert.equal((await post({ id: "alpha", answer: "  " })).status, 400);
  assert.equal(fake.published?.length ?? 0, sent, "nothing is posted to the channel");
});
