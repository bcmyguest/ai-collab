import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { toolClient } from "../lib/tool-api.ts";
import { addTask, taskStoreFile, writeStore } from "../lib/tasks.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("sandbox programs discover and call AI Collab tools in process", async (t) => {
  const home = tempDir(t, "ai-collab-tool-api-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_DATA_HOME: home, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "builder" };
  const tools = toolClient({ env, cwd: home });
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha", status: "open" }, 1);
  writeStore(taskStoreFile("demo", env), doc);

  const schema = tools.listTools().find(({ name }) => name === "task_update");
  assert.ok(schema.inputSchema.properties.id);
  await assert.rejects(tools.callTool("task_update", { id: "alpha" }), /session label/);
  const session = "aabbccddeeff0123";
  await tools.callTool("task_update", { id: "alpha", status: "building", session });
  const { tasks } = await tools.callTool("task_list", { session });
  assert.equal(tasks[0].status, "building");

  await assert.rejects(tools.callTool("pattern_start", { session }), /operator-only/);
  await assert.rejects(tools.callTool("unknown"), /Unknown tool/);
  const signal = AbortSignal.abort(new Error("cancelled"));
  await assert.rejects(tools.callTool("task_list", { session }, { signal }), /cancelled/);
});
