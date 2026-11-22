/** `ai-collab task ...`: list, show, add, set, block, progress, own, render, import. Store: lib/tasks.mjs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withLock } from "./state.mjs";
import { projectRoot } from "./start.mjs";
import {
  STATUSES, addProgress, addTask, blockTask, featureRequestsFile, importFeatureRequests, ownTask, readTasks,
  renderFeatureRequests, setTaskField, tasksFile, writeTasks,
} from "./tasks.mjs";

const USAGE = {
  list: "usage: task list [status]",
  show: "usage: task show <id>",
  add: "usage: task add \"<title>\"",
  set: `usage: task set <id> status=<${STATUSES.join("|")}> | title=<text> | detail=<text>`,
  block: "usage: task block <id> <blocker-id>",
  progress: "usage: task progress <id> \"<text>\"",
  own: "usage: task own <id> <session-address>",
  render: "usage: task render",
  import: "usage: task import <feature-requests.md>",
};

// The address of the calling session (peer#label), else the peer name, else "cli".
function author(cfg) {
  if (cfg.session && cfg.peer) return `${cfg.peer}#${cfg.session}`;
  return cfg.peer || "cli";
}

function line(task) {
  return `${task.id}\t${task.status}\t${task.owner ?? "-"}\t${task.run ?? "-"}\t${task.title}`;
}

// Runs a read-modify-write under the store lock; mutations never overwrite each other.
async function update(root, fn) {
  const result = await withLock(tasksFile(root), async () => {
    const doc = readTasks(root);
    const value = fn(doc);
    writeTasks(root, doc);
    return value;
  });
  if (!result.locked) throw new Error("tasks.json is busy; retry");
  return result.value;
}

export async function task([sub, ...rest], { env, cfg, out, err }) {
  const fail = (key) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  if (!cfg.project) { err.write("ai-collab: task: AI_COLLAB_PROJECT is not set and no project matches this folder\n"); return 2; }
  const root = projectRoot(cfg.project, env);
  const now = Date.now();
  try {
    if (sub === undefined || sub === "list") {
      if (rest.length > 1) return fail("list");
      const [status] = rest;
      if (status !== undefined && !STATUSES.includes(status)) return fail("list");
      for (const t of readTasks(root).tasks) if (!status || t.status === status) out.write(`${line(t)}\n`);
      return 0;
    }
    if (sub === "show") {
      const [id] = rest;
      if (!id || rest.length > 1) return fail("show");
      const t = readTasks(root).tasks.find((item) => item.id === id);
      if (!t) { err.write(`ai-collab: no task ${id}\n`); return 1; }
      out.write(`${JSON.stringify(t, null, 2)}\n`);
      return 0;
    }
    if (sub === "add") {
      const title = rest.join(" ").trim();
      if (!title) return fail("add");
      const t = await update(root, (doc) => addTask(doc, { title }, now));
      out.write(`${t.id}\n`);
      return 0;
    }
    if (sub === "set") {
      const [id, ...assignments] = rest;
      if (!id || assignments.length < 1) return fail("set");
      const pairs = assignments.map((a) => {
        const at = a.indexOf("=");
        return at > 0 ? [a.slice(0, at), a.slice(at + 1)] : null;
      });
      if (pairs.some((p) => !p || !["status", "title", "detail"].includes(p[0]))) return fail("set");
      await update(root, (doc) => { for (const [field, value] of pairs) setTaskField(doc, id, field, value, now); });
      out.write(`${id} updated\n`);
      return 0;
    }
    if (sub === "block") {
      const [id, on] = rest;
      if (!id || !on || rest.length > 2) return fail("block");
      await update(root, (doc) => blockTask(doc, id, on, now));
      out.write(`${id} blocked on ${on}\n`);
      return 0;
    }
    if (sub === "progress") {
      const [id, ...words] = rest;
      const text = words.join(" ").trim();
      if (!id || !text) return fail("progress");
      await update(root, (doc) => addProgress(doc, id, { by: author(cfg), text }, now));
      out.write(`${id} progress recorded\n`);
      return 0;
    }
    if (sub === "own") {
      const [id, address] = rest;
      if (!id || !address || rest.length > 2) return fail("own");
      await update(root, (doc) => ownTask(doc, id, address, now));
      out.write(`${id} owned by ${address}\n`);
      return 0;
    }
    if (sub === "render") {
      if (rest.length) return fail("render");
      const file = featureRequestsFile(root);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderFeatureRequests(readTasks(root)));
      out.write(`rendered ${file}\n`);
      return 0;
    }
    if (sub === "import") {
      const [file] = rest;
      if (!file || rest.length > 1) return fail("import");
      if (existsSync(tasksFile(root))) { err.write(`ai-collab: ${tasksFile(root)} exists; import runs once\n`); return 1; }
      const doc = importFeatureRequests(readFileSync(file, "utf8"), now);
      writeTasks(root, doc);
      out.write(`imported ${doc.tasks.length} tasks\n`);
      return 0;
    }
  } catch (error) {
    err.write(`ai-collab: task ${sub}: ${error.message}\n`);
    return 1;
  }
  err.write(`${Object.values(USAGE).join("\n")}\n`);
  return 1;
}
