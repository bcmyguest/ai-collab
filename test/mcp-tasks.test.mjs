import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { addTask, createFileBackend, taskStoreFile, writeStore } from "../lib/tasks.ts";
import { tempDir } from "./helpers/tmp.mjs";

const LABEL = "aabbccddeeff0123";

test("task_list and task_update read and change the store through MCP", { timeout: 15000 }, async (t) => {
  const fake = await startFakeNtfy();
  const home = tempDir(t, "ai-collab-mcp-tasks-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, "config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { ...peerEnv(fake, { peer: "claude", stateDir: path.join(home, "state") }), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), HOME: home };
  const store = taskStoreFile("demo", env);
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha", status: "open" }, 1);
  addTask(doc, { id: "beta", title: "Beta", status: "done" }, 1);
  writeStore(store, doc);

  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function call(name, args) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return JSON.parse((await output.next()).value).result;
  }
  const json = (result) => JSON.parse(result.content[0].text);

  const all = json(await call("task_list", { session: LABEL }));
  assert.deepEqual(all.tasks.map((task) => task.id), ["alpha", "beta"]);
  assert.deepEqual(json(await call("task_list", { session: LABEL, status: "done" })).tasks.map((task) => task.id), ["beta"]);

  const updated = json(await call("task_update", { id: "alpha", status: "building", owner: `claude#${LABEL}`, session: LABEL, progress: "z".repeat(600) }));
  assert.equal(updated.task.status, "building");
  assert.equal(updated.task.owner, `claude#${LABEL}`);
  assert.equal([...updated.task.last.text].length, 500);
  assert.match(updated.notes[0], /clipped to 500 characters/);

  const blocked = await call("task_update", { id: "alpha", block_on: "missing-task", session: LABEL });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /not a task/);
  assert.equal(createFileBackend(store).get("alpha").blockers.length, 0);

  // A blank progress note fails the whole update: the status change is not saved either.
  const mixed = await call("task_update", { id: "alpha", status: "done", progress: "   ", session: LABEL });
  assert.equal(mixed.isError, true);
  assert.equal(createFileBackend(store).get("alpha").status, "building");
});
