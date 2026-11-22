import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { addTask, ownTask, readStore, taskStoreFile, writeStore } from "../lib/tasks.mjs";

const LABEL = "aabbccddeeff0123";
const OTHER = "1122334455667788";

test("a progress post from the owner session lands on its building task only", { timeout: 15000 }, async (t) => {
  const fake = await startFakeNtfy();
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-task-progress-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, "config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, "config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude" }]));
  const env = { ...peerEnv(fake, { peer: "claude", stateDir: path.join(home, "state") }), XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), HOME: home };
  const store = taskStoreFile("demo", env);
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "mine", title: "Mine", status: "building" }, 1);
  ownTask(doc, "mine", `claude#${LABEL}`, 1);
  addTask(doc, { id: "theirs", title: "Theirs", status: "building" }, 1);
  ownTask(doc, "theirs", `claude#${OTHER}`, 1);
  addTask(doc, { id: "queued", title: "Queued", status: "open" }, 1);
  ownTask(doc, "queued", `claude#${LABEL}`, 1);
  writeStore(store, doc);

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

  const posted = await call("send_to_all", { body: "step one done", session: LABEL, progress: true });
  assert.equal(posted.sent, true);
  assert.equal(posted.notes, undefined);
  // The attach runs after the post, so the tool result returns before the store changes.
  await waitFor(() => readStore(store).tasks.find((t) => t.id === "mine").progress.length === 1);
  const after = readStore(store).tasks;
  assert.equal(after.find((t) => t.id === "mine").progress[0].text, "step one done");
  assert.deepEqual(after.find((t) => t.id === "theirs").progress, []);
  assert.deepEqual(after.find((t) => t.id === "queued").progress, []);

  // A long note is clipped on the task and the result says so.
  const long = await call("send_to_all", { body: "y".repeat(600), session: LABEL, progress: true });
  assert.match(long.notes[0], /clipped to 500 characters/);
  await waitFor(() => readStore(store).tasks.find((t) => t.id === "mine").progress.length === 2);
  assert.equal([...readStore(store).tasks.find((t) => t.id === "mine").progress[1].text].length, 500);

  // A session that owns no building task gets a note instead of silence.
  const orphan = await call("send_to_all", { body: "nothing owned", session: "9999999999999999", progress: true });
  assert.match(orphan.notes[0], /no building task is owned/);

  // A plain post (not progress) leaves the task alone.
  await call("send_to_all", { body: "an answer", session: LABEL });
  assert.equal(readStore(store).tasks.find((t) => t.id === "mine").progress.length, 2);
});

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting for the store");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
