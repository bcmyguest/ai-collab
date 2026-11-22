import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { addTask, ownTask, readTasks, writeTasks } from "../lib/tasks.mjs";

const LABEL = "aabbccddeeff0123";
const OTHER = "1122334455667788";

test("a progress post from the owner session lands on its building task only", { timeout: 15000 }, async (t) => {
  const fake = await startFakeNtfy();
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-task-progress-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, "config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "mine", title: "Mine", status: "building" }, 1);
  ownTask(doc, "mine", `claude#${LABEL}`, 1);
  addTask(doc, { id: "theirs", title: "Theirs", status: "building" }, 1);
  ownTask(doc, "theirs", `claude#${OTHER}`, 1);
  addTask(doc, { id: "queued", title: "Queued", status: "open" }, 1);
  ownTask(doc, "queued", `claude#${LABEL}`, 1);
  writeTasks(root, doc);

  const env = { ...peerEnv(fake, { peer: "claude", stateDir: path.join(home, "state") }), XDG_CONFIG_HOME: path.join(home, "config"), HOME: home };
  const script = fileURLToPath(new URL("../scripts/ai-collab-mcp.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "claude"], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => { child.kill(); return fake.close(); });
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let rpcId = 0;
  async function call(name, args) {
    const id = ++rpcId;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const result = JSON.parse((await output.next()).value).result;
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  }

  assert.equal((await call("send_to_all", { body: "step one done", session: LABEL, progress: true })).sent, true);
  const after = readTasks(root).tasks;
  assert.equal(after.find((t) => t.id === "mine").progress.length, 1);
  assert.deepEqual(after.find((t) => t.id === "mine").progress[0].text, "step one done");
  assert.deepEqual(after.find((t) => t.id === "theirs").progress, []);
  assert.deepEqual(after.find((t) => t.id === "queued").progress, []);

  // A plain post (not progress) leaves the task alone.
  await call("send_to_all", { body: "an answer", session: LABEL });
  assert.equal(readTasks(root).tasks.find((t) => t.id === "mine").progress.length, 1);
  assert.ok(readFileSync(path.join(root, ".ai-collab", "tasks.json"), "utf8").includes("step one done"));
});
