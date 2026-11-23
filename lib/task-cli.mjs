/** `ai-collab task ...`: list, show, add, set, block, progress, ask, own, remove, render, import. Store: lib/tasks.mjs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectRoot } from "./start.mjs";
import { STATUSES, TASK_PRIORITIES, clipProgress, importReport, openTasks, priorityOf, renderFeatureRequests, sortTasks, validateTasks } from "./tasks.mjs";

const SET_FIELDS = ["status", "title", "detail", "run", "priority"];
const USAGE = {
  outcomes: "usage: task outcomes",
  "propose-outcome": 'usage: task propose-outcome <outcome-id> "<task title>" ["<task title>" ...]',
  "report-outcome": 'usage: task report-outcome <outcome-id> pass|fail "<evidence>"',
  list: "usage: task list [status]",
  show: "usage: task show <id>",
  add: "usage: task add \"<title>\" [--priority P0|P1|P2|P3]",
  set: `usage: task set <id> status=<${STATUSES.join("|")}> | title=<text> | detail=<text> | run=<run-id> | priority=<${TASK_PRIORITIES.join("|")}>`,
  block: "usage: task block <id> <blocker-id>",
  progress: "usage: task progress <id> \"<text>\"",
  own: "usage: task own <id> <session-address>",
  ask: "usage: task ask <id> \"<question for the operator>\" [--option <choice>]... | task ask <id> --clear",
  remove: "usage: task remove <id>",
  render: "usage: task render",
  import: "usage: task import <feature-requests.md | tasks.json>",
};
const HELP_FLAGS = ["--help", "-h"];

const helpText = () => ["usage: ai-collab task <command>", ...Object.values(USAGE)].join("\n");

// The address of the calling session (peer#label), else the peer name, else "cli".
function author(cfg) {
  if (cfg.session && cfg.peer) return `${cfg.peer}#${cfg.session}`;
  return cfg.peer || "cli";
}

function line(task) {
  return `${task.id}\t${task.status}\t${priorityOf(task)}\t${task.owner ?? "-"}\t${task.run ?? "-"}\t${task.title}`;
}

export async function task([sub, ...rest], { env, cfg, out, err }) {
  const fail = (key) => { err.write(`ai-collab: ${USAGE[key]}\n`); return 1; };
  // `task --help` and `task <command> --help` print usage instead of treating the flag as an argument.
  if (sub === undefined || sub === "help" || HELP_FLAGS.includes(sub)) { out.write(`${helpText()}\n`); return 0; }
  if (rest.some((a) => HELP_FLAGS.includes(a))) {
    if (!(sub in USAGE)) { err.write(`ai-collab: task: unknown command "${sub}"\n${helpText()}\n`); return 1; }
    out.write(`ai-collab: ${USAGE[sub]}\n`);
    return 0;
  }
  if (!cfg.project) { err.write("ai-collab: task: AI_COLLAB_PROJECT is not set and no project matches this folder\n"); return 2; }
  const now = Date.now();
  try {
    if (sub === "outcomes") {
      if (rest.length) return fail(sub);
      const { outcomes = [] } = openTasks(cfg.project, env).projectBoard();
      out.write(JSON.stringify(outcomes.filter(entry => entry.state !== "closed"), null, 2) + "\n");
      return 0;
    }
    if (sub === "propose-outcome" || sub === "report-outcome") {
      const [id, verdict, result] = rest;
      const propose = sub === "propose-outcome";
      if (!id || (!propose && (rest.length !== 3 || !["pass", "fail"].includes(verdict)))) return fail(sub);
      await openTasks(cfg.project, env).outcome(propose ? "propose" : "report",
        { id, titles: rest.slice(1), passed: verdict === "pass", result, by: author(cfg) });
      out.write(id + " updated\n");
      return 0;
    }
    if (sub === "list") {
      if (rest.length > 1) return fail("list");
      const [status] = rest;
      if (status !== undefined && !STATUSES.includes(status)) return fail("list");
      for (const t of sortTasks(openTasks(cfg.project, env).list())) if (!status || t.status === status) out.write(`${line(t)}\n`);
      return 0;
    }
    if (sub === "show") {
      const [id] = rest;
      if (!id || rest.length > 1) return fail("show");
      out.write(`${JSON.stringify(openTasks(cfg.project, env).get(id), null, 2)}\n`);
      return 0;
    }
    if (sub === "add") {
      // --priority P1 (or --priority=P1) is not part of the title; anything else is.
      const words = [];
      let priority;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--priority") {
          priority = rest[++i];
        } else if (a.startsWith("--priority=")) {
          priority = a.slice("--priority=".length);
        } else {
          words.push(a);
        }
      }
      const title = words.join(" ").trim();
      if (!title || (rest.includes("--priority") && priority === undefined)) return fail("add");
      if (priority !== undefined && !TASK_PRIORITIES.includes(priority)) return fail("add");
      const t = await openTasks(cfg.project, env).add({ title, ...(priority ? { priority } : {}) }, now);
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
    if (sub === "ask") {
      const [id, ...args] = rest;
      if (!id || !args.length) return fail("ask");
      if (args.length === 1 && args[0] === "--clear") {
        await openTasks(cfg.project, env).update(id, { ask: null }, now);
        out.write(`${id} question cleared\n`);
        return 0;
      }
      const words = [];
      const options = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--option") {
          if (args[i + 1] === undefined) return fail("ask");
          options.push(args[++i]);
        } else if (args[i].startsWith("--")) {
          return fail("ask");
        } else {
          words.push(args[i]);
        }
      }
      const text = words.join(" ").trim();
      if (!text) return fail("ask");
      await openTasks(cfg.project, env).update(id, { ask: { text, options, by: author(cfg) } }, now);
      out.write(`${id} waits on the operator\n`);
      return 0;
    }
    if (sub === "own") {
      const [id, address] = rest;
      if (!id || !address || rest.length > 2) return fail("own");
      await openTasks(cfg.project, env).update(id, { owner: address }, now);
      out.write(`${id} owned by ${address}\n`);
      return 0;
    }
    if (sub === "remove") {
      const [id] = rest;
      if (!id || rest.length > 1) return fail("remove");
      await openTasks(cfg.project, env).remove(id);
      out.write(`${id} removed\n`);
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
      const { doc, defaulted } = file.endsWith(".json") ? { doc: validateTasks(JSON.parse(text)), defaulted: [] } : importReport(text, now);
      const count = await openTasks(cfg.project, env).replaceAll(doc);
      for (const title of defaulted) out.write(`defaulted to done (no status word): ${title}\n`);
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
