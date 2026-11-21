// Pure activity-row helpers shared by the Activity view and its tests.
const SUMMARY_KEYS = ["command", "cmd", "pattern", "file_path", "filePath", "url", "query", "path", "description", "prompt", "skill"];
const SUMMARY_FIELD = /"(command|cmd|pattern|file_path|filePath|url|query|path|description)"\s*:\s*"((?:[^"\\]|\\.)*)/;
const WORKING_MS = 15 * 60_000;
const SHELL_TOOL = /^(bash|shell|exec_command|run_terminal_cmd|terminal)/i;
const READ_TOOL = /^(read|view|cat|read_file)/i;
const RUN_ACTIVE_MS = 2 * 60_000;
const AGENT_TOOL =/^(Agent|Task)$/;
const AGENT_ID = /"agentId"\s*:\s*"([\w-]{1,128})"/;
const TASK_DONE = /<task-id>([\w-]{1,128})<\/task-id>[\s\S]*?<status>(?:completed|failed|killed|stopped)<\/status>/;
const DIFF =/^(diff --git |--- \S|\+\+\+ \S|@@ -\d)/m;

/** One-line summary of a tool input: the command, path, pattern or URL when the input is JSON (even truncated JSON). */
export function summarize(input) {
  if (!input) return "";
  let value;
  try { value = JSON.parse(input); } catch {}
  if (typeof value === "string") return value.split("\n")[0];
  if (value && typeof value === "object") {
    const key = SUMMARY_KEYS.find(name => typeof value[name] === "string");
    const text = key ? value[key] : Object.values(value).find(item => typeof item === "string") || "";
    return text.split("\n")[0];
  }
  const field = SUMMARY_FIELD.exec(input);
  if (field) return field[2].replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
  return input.split("\n")[0];
}

/** Blocks to show for a tool input: a shell command as bash plus any other fields as JSON; other input as JSON when it is JSON. */
export function inputBlocks(tool, input) {
  if (!input) return [];
  let value;
  try { value = JSON.parse(input); } catch {}
  const command = value && typeof value === "object" && !Array.isArray(value) ? value.command ?? value.cmd : undefined;
  if (SHELL_TOOL.test(tool || "") && (typeof command === "string" || Array.isArray(command))) {
    const { command: _, cmd: __, ...rest } = value;
    const blocks = [{ code: Array.isArray(command) ? command.join(" ") : command, language: "bash" }];
    return Object.keys(rest).length ? [...blocks, { code: JSON.stringify(rest, null, 2), language: "json" }] : blocks;
  }
  return [{ code: input, language: /^\s*[[{]/.test(input) ? "json" : "" }];
}

/** Language name of a tool result: a diff, shell output as bash, a read file by its extension, JSON; else "". */
export function resultLanguage(tool, input, output) {
  if (!output) return "";
  if (DIFF.test(output) && /^[-+@]/m.test(output)) return "diff";
  if (SHELL_TOOL.test(tool || "")) return "bash";
  if (READ_TOOL.test(tool || "")) {
    const path = /"(?:file_path|filePath|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input || "")?.[1] || "";
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1];
    if (ext) return ext.toLowerCase();
  }
  return /^\s*[[{]/.test(output) ? "json" : "";
}

/** Joins Claude's streamed text batches and pairs each tool call with its result or error by callId, in arrival order. */
export function activityRows(items) {
  const results = new Map();
  for (const item of items) {
    if ((item.type === "tool_result" || item.type === "error") && item.callId) results.set(item.agent + "|" + item.callId, item);
  }
  const used = new Set();
  const texts = new Map();
  const rows = [];
  for (const item of items) {
    const batch = item.type === "text" && item.callId ? /^(.+)#(\d+)$/.exec(item.callId) : null;
    if (batch) {
      const key = item.agent + "|" + batch[1];
      let row = texts.get(key);
      if (!row) {
        row = { ...item, parts: [] };
        texts.set(key, row);
        rows.push(row);
      }
      row.parts.push([Number(batch[2]), item.output || ""]);
      row.parts.sort((a, b) => a[0] - b[0]);
      row.output = row.parts.map(part => part[1]).join("");
      continue;
    }
    if (item.type === "tool_call" && item.callId) {
      const result = results.get(item.agent + "|" + item.callId);
      if (result) used.add(result);
      rows.push({ ...item, result });
      continue;
    }
    if (!used.has(item)) rows.push(item);
  }
  return rows.filter(row => !used.has(row));
}

/** Folds each subagent run's rows into one "subagent" row at its first row's place; done on its stop row or the parent's completion notice. */
export function groupSubagents(rows) {
  const runs = new Map();
  const out = [];
  const launches = new Map();
  const finished = new Set();
  for (const row of rows) {
    if (row.subagent?.id) continue;
    // The parent's Agent tool result names the run (agentId) and its description; a foreground run's result means it ended.
    const launch = AGENT_TOOL.test(row.tool || "") ? agentLaunch(row.type === "tool_call" ? row.result?.output : row.type === "tool_result" ? row.output : "") : null;
    if (launch) {
      launches.set(row.agent + "|" + launch.id, launch);
      if (launch.done) finished.add(row.agent + "|" + launch.id);
    }
    // Claude tells the parent with a <task-notification> prompt when a background run ends.
    const notice = row.type === "prompt" || row.type === "text" ? TASK_DONE.exec(row.input || row.output || "") : null;
    if (notice) finished.add(row.agent + "|" + notice[1]);
  }
  for (const row of rows) {
    if (!row.subagent?.id) { out.push(row); continue; }
    const key = row.agent + "|" + row.subagent.id;
    let run = runs.get(key);
    if (!run) {
      run = { id: "subagent:" + key, type: "subagent", agent: row.agent, time: row.time, run: row.subagent.id, kind: "", rows: [] };
      runs.set(key, run);
      out.push(run);
    }
    run.rows.push(row);
    run.kind ||= row.subagent.type;
  }
  for (const [key, run] of runs) {
    run.done = run.rows.some(row => row.type === "stop") || finished.has(key);
    // A step is one tool use: its call row, or its result alone when the call row never arrived.
    run.steps = run.rows.filter(row => row.type === "tool_call" || ((row.type === "tool_result" || row.type === "error") && row.tool)).length;
    run.description = launches.get(key)?.description || "";
    const last = run.rows.findLast(row => row.tool);
    run.last = last ? { tool: last.tool, summary: summarize(last.input), time: last.time } : null;
    run.lastTime = Math.max(...run.rows.map(row => row.time || 0));
  }
  return out;
}

/** done (stopped or reported finished), running (a row in the last 2 min), else idle; without now, every unfinished run is running. */
export function runState(run, now) {
  if (run.done) return "done";
  return now === undefined || now - (run.lastTime ?? run.time) * 1000 < RUN_ACTIVE_MS ? "running" : "idle";
}

/** "Explore · in claude#28d7fa48 · running · 12 steps" for a subagent row. */
export function subagentLabel(run, now) {
  const address = run.agent || "";
  const short = address.includes("#") ? address.slice(0, address.indexOf("#") + 9) : address;
  return [run.kind || "agent", short && "in " + short, runState(run, now), run.steps + (run.steps === 1 ? " step" : " steps")].filter(Boolean).join(" · ");
}

// {id, description, done} from an Agent tool result's JSON text, or null.
function agentLaunch(output) {
  const id = typeof output === "string" ? AGENT_ID.exec(output)?.[1] : "";
  if (!id) return null;
  const description = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(output)?.[1] || "";
  return { id, description, done: /"status"\s*:\s*"completed"/.test(output) };
}

/** Sessions with a running subagent run: session → count. */
export function runningSubagents(rows, now) {
  const count = new Map();
  for (const row of rows) if (row.type === "subagent" && runState(row, now) === "running") count.set(row.agent, (count.get(row.agent) || 0) + 1);
  return count;
}

/** Chat messages and activity rows in one thread by time (seconds); on a tie the activity row comes first. */
export function interleave(messages, rows) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < messages.length || j < rows.length) {
    const takeRow = j < rows.length && (i >= messages.length || (rows[j].time || 0) <= (messages[i].time || 0));
    out.push(takeRow ? { activity: rows[j++] } : { message: messages[i++] });
  }
  return out;
}

// Agents whose latest row is a recent tool call with no result yet.
export function working(rows, now) {
  const latest = new Map();
  for (const row of rows) latest.set(row.agent, row);
  return [...latest.values()].filter(row => row.type === "tool_call" && !row.result && now - row.time * 1000 < WORKING_MS).map(row => row.agent);
}
