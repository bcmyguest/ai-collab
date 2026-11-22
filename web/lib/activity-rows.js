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
  const finished = new Map();
  for (const row of rows) {
    if (row.subagent?.id) continue;
    // The parent's Agent tool result names the run (agentId) and its description; a foreground run's result means it ended.
    const launch = AGENT_TOOL.test(row.tool || "") ? agentLaunch(row.type === "tool_call" ? row.result?.output : row.type === "tool_result" ? row.output : "") : null;
    if (launch) {
      launches.set(row.agent + "|" + launch.id, launch);
      if (launch.done) finished.set(row.agent + "|" + launch.id, row.time);
    }
    // Claude tells the parent with a <task-notification> prompt when a background run ends.
    const notice = row.type === "prompt" || row.type === "text" ? TASK_DONE.exec(row.input || row.output || "") : null;
    if (notice) finished.set(row.agent + "|" + notice[1], row.time);
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
    run.lastTime = Math.max(...run.rows.map(row => row.time || 0));
    // A resumed run (follow-up message, no new start) reopens: done only when a stop ends the rows or a finish marker is newest.
    const endedAt = finished.get(key);
    run.done = run.rows.at(-1).type === "stop" || (endedAt !== undefined && run.lastTime <= endedAt);
    // A step is one tool use: its call row, or its result alone when the call row never arrived.
    run.steps = run.rows.filter(row => row.type === "tool_call" || ((row.type === "tool_result" || row.type === "error") && row.tool)).length;
    run.description = launches.get(key)?.description || "";
    const last = run.rows.findLast(row => row.tool);
    run.last = last ? { tool: last.tool, summary: summarize(last.input), time: last.time } : null;
    const end = run.rows.at(-1);
    run.open = end?.type === "tool_call" && !end.result;
  }
  return out;
}

/** done (stopped or reported finished), running (a row in the last 2 min), else idle; without now, every unfinished run is running. */
export function runState(run, now) {
  if (run.done) return "done";
  // A long tool call (a build, a test run) keeps the run running for up to 15 min without new rows.
  if (run.open && now !== undefined && now - (run.lastTime ?? run.time) * 1000 < WORKING_MS) return "running";
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

// Harness wrappers that arrive as prompt text: Claude Code's background-task notices and subagent hand-backs, pasted blocks.
const TASK_NOTICE = /^<task-notification>([\s\S]*?)(?:<\/task-notification>)?\s*$/;
const AGENT_MESSAGE = /^<agent-message from="([^"]*)">([\s\S]*?)(?:<\/agent-message>)?\s*$/;
const REPORT_START = /The report follows:\s*\n/;
const PASTED = /<pasted_content[^>]*>\n?([\s\S]*?)\n?<\/pasted_content[^>]*>/g;
const WRAPPED = /^<([a-z][\w-]*)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>\s*$/i;

// Removes the indent every non-empty line shares.
function dedent(text) {
  const lines = text.split("\n");
  const indent = Math.min(...lines.filter(line => line.trim()).map(line => /^ */.exec(line)[0].length));
  return Number.isFinite(indent) && indent > 0 ? lines.map(line => line.slice(indent)).join("\n") : text;
}

/** Prompt or agent text made readable: harness XML wrappers become a label and plain markdown; other text is unchanged. */
export function readableText(raw) {
  const text = String(raw || "").trim();
  const notice = TASK_NOTICE.exec(text);
  if (notice) {
    const pick = name => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(notice[1])?.[1]?.trim() || "";
    return { label: "Task notification", text: [pick("summary") || "A background task changed state", pick("result")].filter(Boolean).join("\n\n") };
  }
  const message = AGENT_MESSAGE.exec(text);
  if (message) {
    const body = message[2];
    const start = REPORT_START.exec(body);
    return { label: "Subagent report", text: dedent(start ? body.slice(start.index + start[0].length) : body).trim() };
  }
  if (text.includes("<pasted_content")) return { label: "", text: text.replace(PASTED, (_, inner) => "```text\n" + inner.replace(/```/g, "ˋˋˋ") + "\n```") };
  const wrapped = WRAPPED.exec(text);
  return wrapped ? { label: "", text: wrapped[2].trim() } : { label: "", text: String(raw || "") };
}
