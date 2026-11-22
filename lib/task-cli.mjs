/** `ai-collab task ...`: list, show, add, set, block, progress, own, render, import. Store: lib/tasks.mjs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectRoot } from "./start.mjs";
import { STATUSES, clipProgress, importFeatureRequests, openTasks, renderFeatureRequests, validateTasks } from "./tasks.mjs";

const SET_FIELDS = ["status", "title", "detail", "run"];
const USAGE = {
  list: "usage: task list [status]",
  show: "usage: task show <id>",
  add: "usage: task add \"<title>\"",
  set: `usage: task set <id> status=<${STATUSES.join("|")}> | title=<text> | detail=<text> | run=<run-id>`,
  block: "usage: task block <id> <blocker-id>",
  progress: "usage: task progress <id> \"<text>\"",
  own: "usage: task own <id> <session-address>",
  render: "usage: task render",
  import: "usage: task import <feature-requests.md | tasks.json>",
};

// The address of the calling session (peer#label), else the peer name, else "cli".
function author(cfg) {
  if (cfg.session && cfg.peer) return `${cfg.peer}#${cfg.session}`;
  return cfg.peer || "cli";
}

function line(task) {
  return `${task.id}\t${task.status}\t${task.owner ?? "-"}\t${task.run ?? "-"}\t${task.title}`;
}

export async function task([sub, ...rest], { env, cfg, out, err }) {
  const fail = (key) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  if (!cfg.project) { err.write("ai-collab: task: AI_COLLAB_PROJECT is not set and no project matches this folder\n"); return 2; }
  const now = Date.now();
  try {
    if (sub === undefined || sub === "list") {
      if (rest.length > 1) return fail("list");
      const [status] = rest;
      if (status !== undefined && !STATUSES.includes(status)) return fail("list");
      for (const t of openTasks(cfg.project, env).list()) if (!status || t.status === status) out.write(`${line(t)}\n`);
      return 0;
    }
    if (sub === "show") {
      const [id] = rest;
      if (!id || rest.length > 1) return fail("show");
      out.write(`${JSON.stringify(openTasks(cfg.project, env).get(id), null, 2)}\n`);
      return 0;
    }
    if (sub === "add") {
      const title = rest.join(" ").trim();
      if (!title) return fail("add");
      const t = await openTasks(cfg.project, env).add({ title }, now);
      out.write(`${t.id}\n`);
      return 0;
    }
    if (sub === "set") {
      const [id, ...assignments] = rest;
      if (!id || assignments.length < 1) return fail("set");
      const patch = {};
      for (const a of assignments) {
        const at = a.indexOf("=");
        const key = at > 0 ? a.slice(0, at) : "";
        if (!SET_FIELDS.includes(key)) return fail("set");
        patch[key] = a.slice(at + 1);
      }
      await openTasks(cfg.project, env).update(id, patch, now);
      out.write(`${id} updated\n`);
      return 0;
    }
    if (sub === "block") {
      const [id, on] = rest;
      if (!id || !on || rest.length > 2) return fail("block");
      await openTasks(cfg.project, env).update(id, { block: on }, now);
      out.write(`${id} blocked on ${on}\n`);
      return 0;
    }
    if (sub === "progress") {
      const [id, ...words] = rest;
      const text = words.join(" ").trim();
      if (!id || !text) return fail("progress");
      await openTasks(cfg.project, env).addProgress(id, { by: author(cfg), text }, now);
      out.write(`${id} progress recorded${clipProgress(text).truncated ? " (clipped to 500 characters)" : ""}\n`);
      return 0;
    }
    if (sub === "own") {
      const [id, address] = rest;
      if (!id || !address || rest.length > 2) return fail("own");
      await openTasks(cfg.project, env).update(id, { owner: address }, now);
      out.write(`${id} owned by ${address}\n`);
      return 0;
    }
    if (sub === "render") {
      if (rest.length) return fail("render");
      const file = join(projectRoot(cfg.project, env), "docs", "feature-requests.md");
      const doc = { v: 1, tasks: openTasks(cfg.project, env).list() };
      const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderFeatureRequests(doc, existing));
      out.write(`rendered ${file}\n`);
      return 0;
    }
    if (sub === "import") {
      const [file] = rest;
      if (!file || rest.length > 1) return fail("import");
      const text = readFileSync(file, "utf8");
      // A .json file is a task store (the old .ai-collab/tasks.json included); anything else is the markdown table.
      const doc = file.endsWith(".json") ? validateTasks(JSON.parse(text)) : importFeatureRequests(text, now);
      const count = await openTasks(cfg.project, env).replaceAll(doc);
      out.write(`imported ${count} tasks\n`);
      return 0;
    }
  } catch (error) {
    err.write(`ai-collab: task ${sub}: ${error.message}\n`);
    return 1;
  }
  err.write(`${Object.values(USAGE).join("\n")}\n`);
  return 1;
}
