/**
 * Data sources for `ai-collab analyze run-code`. A source is {name, load({since, until}) -> {turns?, scheduleRuns?,
 * tasks?, notes?}}; a Phoenix source can implement the same interface later. A turn is one model response:
 * {harness, native, cwd, sub, model, ts (ms), tok: {input, cw5, cw1, cacheRead, output} | null, calls: [call]}
 * and a call is {name, path, refused, failed}. `input` is uncached input; cache writes are separate.
 */
import { execFileSync } from "node:child_process";
import { globSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { READ_TOOLS } from "./code-run.mjs";
import { commandSegments, isStoreBypass } from "./store-read.mjs";

export const READ_PATHS = ["mcp_read", "cli_read", "run_code", "run_read_code"];

// CLI read commands that `ai-collab` answers through run_code once readsThroughRunCode is on (see readProgram in cli.mjs).
const CLI_READ = /^(?:\S*\/)?ai-collab\s+(?:task\s+(?:list|show)|agents|sessions|history|peers|team\s+status|pattern\s+list|status)\b/;
const CLI_READ_LOOSE = /(?:^|[\s"'`;&|(])(?:\S*\/)?ai-collab\s+(?:task\s+(?:list|show)|agents|sessions|history|peers|team\s+status|pattern\s+list|status)\b/;
const REFUSAL = /through run_code|reads go through run_code/;
const MCP_NAME = /^(?:mcp__)?(?:plugin_ai-collab_)?(ai-collab-code|ai-collab)(?:__|_)(.+)$/;

const text = (value) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const str = (value) => Array.isArray(value) ? value.join(" ") : text(value);

/** The ai-collab read path a tool call used, or null: {path, tool}. */
export function classifyCall({ name = "", input, loose = false }) {
  const mcp = MCP_NAME.exec(name);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server === "ai-collab-code") return { path: tool === "run_read_code" ? "run_read_code" : tool === "run_code" ? "run_code" : null, tool };
    return { path: READ_TOOLS.includes(tool) ? "mcp_read" : null, tool };
  }
  const command = typeof input === "string" ? input : str(input?.command ?? input?.cmd);
  if (command) {
    if (loose ? CLI_READ_LOOSE.test(command) : commandSegments(command).some((s) => CLI_READ.test(s))) return { path: "cli_read", tool: "cli" };
    if (isStoreBypass({ name, input })) return { path: "bypass_read", tool: "shell" };
    return { path: null, tool: name };
  }
  if (isStoreBypass({ name, input })) return { path: "bypass_read", tool: name.toLowerCase() };
  return { path: null, tool: name };
}

export const isRefusal = (content) => REFUSAL.test(text(content));

/** A run_code result that failed: ok:false, a staging error, or an error that is not a read refusal. */
export function isRunCodeFailure(content, isError) {
  const s = text(content);
  if (isRefusal(s)) return false;
  return /"ok"\s*:\s*false/.test(s) || /could not stage/.test(s) || Boolean(isError);
}

function makeCall(name, input, loose) {
  const { path } = classifyCall({ name, input, loose });
  return { name, path, refused: false, failed: false };
}

function settle(call, content, isError) {
  if (!call.path) return;
  if (call.path !== "bypass_read" && isRefusal(content)) call.refused = true;
  else if ((call.path === "run_code" || call.path === "run_read_code") && isRunCodeFailure(content, isError)) call.failed = true;
}

const inWindow = (ts, { since, until }) => Number.isFinite(ts) && !(since != null && ts < since) && !(until != null && ts >= until);
const lines = (file) => readFileSync(file, "utf8").split("\n");
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const files = (home, pattern) => globSync(join(home, pattern));

/** Claude Code transcripts: dedupe on message.id + requestId, keep the max output count, union the tool_use blocks. */
export function claudeSource({ home = homedir() } = {}) {
  return {
    name: "claude-transcripts",
    async load(win = {}) {
      const turns = [];
      for (const file of files(home, ".claude/projects/**/*.jsonl")) {
        const byKey = new Map();
        const pending = new Map();
        for (const line of lines(file)) {
          const wantsResult = pending.size && line.includes("tool_result");
          if (!wantsResult && !line.includes('"usage"')) continue;
          const d = parse(line);
          const m = d?.message;
          if (!m || typeof m !== "object") continue;
          if (m.role === "user" && wantsResult && Array.isArray(m.content)) {
            for (const p of m.content) if (p.type === "tool_result" && pending.has(p.tool_use_id)) settle(pending.get(p.tool_use_id), p.content, p.is_error === true);
            continue;
          }
          if (m.role !== "assistant" || !m.usage || !m.id || !d.timestamp || !m.model || m.model.startsWith("<")) continue;
          const key = `${m.id}|${d.requestId ?? ""}`;
          let turn = byKey.get(key);
          if (!turn) {
            turn = { harness: "claude", native: d.sessionId || file.split("/").pop().replace(/\.jsonl$/, ""), cwd: d.cwd || "", sub: d.isSidechain === true || file.includes("/subagents/"), model: m.model, ts: Date.parse(d.timestamp), tok: null, calls: [], ids: new Set() };
            byKey.set(key, turn);
          }
          const u = m.usage;
          if (!turn.tok || (u.output_tokens || 0) >= turn.tok.output) {
            const cc = u.cache_creation || {};
            const c1 = cc.ephemeral_1h_input_tokens || 0;
            let c5 = cc.ephemeral_5m_input_tokens || 0;
            const total = u.cache_creation_input_tokens || 0;
            if (c1 + c5 < total) c5 = total - c1;
            turn.tok = { input: u.input_tokens || 0, cw5: c5, cw1: c1, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
          }
          for (const p of Array.isArray(m.content) ? m.content : []) {
            if (p.type !== "tool_use" || turn.ids.has(p.id)) continue;
            turn.ids.add(p.id);
            const call = makeCall(p.name, p.input, false);
            turn.calls.push(call);
            if (call.path) pending.set(p.id, call);
          }
        }
        for (const turn of byKey.values()) { delete turn.ids; if (inWindow(turn.ts, win)) turns.push(turn); }
      }
      return { turns };
    },
  };
}

/** Codex rollouts: one turn per response_id from token_usage_record; calls attach to the next usage record. */
export function codexSource({ home = homedir() } = {}) {
  return {
    name: "codex-sessions",
    async load(win = {}) {
      const turns = [];
      for (const file of files(home, ".codex/sessions/**/*.jsonl")) {
        let native = file;
        let cwd = "";
        let sub = false;
        let model = "";
        const models = new Map();
        const seen = new Set();
        const byCall = new Map();
        let queued = [];
        let last = null;
        const emit = (ts, tid, tok) => {
          const t = { harness: "codex", native, cwd, sub, model: models.get(tid) || model, ts: Date.parse(ts), tok, calls: queued };
          queued = [];
          last = t;
          if (inWindow(t.ts, win)) turns.push(t);
        };
        for (const line of lines(file)) {
          const d = parse(line);
          const p = d?.payload || {};
          if (d?.type === "session_meta") { native = p.id || native; cwd = p.cwd || cwd; sub = Boolean(p.source?.subagent) || sub; }
          else if (d?.type === "turn_context") { model = p.model || model; models.set(p.turn_id, p.model); cwd = p.cwd || cwd; }
          else if (d?.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
            const call = makeCall(p.namespace ? `${p.namespace}${p.name}` : p.name, p.type === "function_call" ? parseArgs(p.arguments) : p.input, p.type === "custom_tool_call");
            byCall.set(p.call_id, call);
            queued.push(call);
          } else if (d?.type === "response_item" && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
            const call = byCall.get(p.call_id);
            if (call) settle(call, outputText(p.output), false);
          } else if (d?.type === "token_usage_record" && p.usage) {
            if (seen.has(p.response_id)) continue;
            seen.add(p.response_id);
            const u = p.usage;
            emit(d.timestamp, p.turn_id, { input: (u.input_tokens || 0) - (u.cached_input_tokens || 0), cw5: 0, cw1: 0, cacheRead: u.cached_input_tokens || 0, output: u.output_tokens || 0 });
          }
        }
        if (queued.length && last) last.calls.push(...queued);
      }
      return { turns };
    },
  };
}

const parseArgs = (value) => { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } };
const outputText = (out) => Array.isArray(out) ? out.map((o) => o?.text ?? "").join("\n") : text(out);

const dbReadOnly = (file) => new DatabaseSync(file, { readOnly: true });

/** OpenCode: assistant messages carry tokens; tool parts hang off a message. */
export function opencodeSource({ home = homedir() } = {}) {
  return {
    name: "opencode-db",
    async load(win = {}) {
      const file = join(home, ".local/share/opencode/opencode.db");
      let db;
      try { db = dbReadOnly(file); } catch { return { turns: [], notes: ["OpenCode database not readable"] }; }
      try {
        const parts = new Map();
        for (const r of db.prepare("select message_id, data from part where json_extract(data, '$.type') = 'tool'").all()) {
          const p = parse(r.data);
          if (!p) continue;
          const call = makeCall(p.tool, p.state?.input, false);
          settle(call, p.state?.output ?? p.state?.error, p.state?.status === "error");
          (parts.get(r.message_id) || parts.set(r.message_id, []).get(r.message_id)).push(call);
        }
        const turns = [];
        const q = "select m.id, m.session_id, m.time_created, m.data, s.directory, s.parent_id from message m left join session s on s.id = m.session_id";
        for (const r of db.prepare(q).all()) {
          const d = parse(r.data);
          if (d?.role !== "assistant") continue;
          const t = d.tokens || {};
          const ts = Number(r.time_created);
          if (!inWindow(ts, win)) continue;
          const c = t.cache || {};
          const tok = t.input || t.output ? { input: t.input || 0, cw5: c.write || 0, cw1: 0, cacheRead: c.read || 0, output: (t.output || 0) + (t.reasoning || 0) } : null;
          turns.push({ harness: "opencode", native: r.session_id, cwd: r.directory || "", sub: Boolean(r.parent_id), model: d.modelID || "unknown", provider: d.providerID, ts, tok, calls: parts.get(r.id) || [] });
        }
        return { turns };
      } finally { db.close(); }
    },
  };
}

/** Cursor chat stores: tool calls and model name only. No usage and no per-message time, so a turn dates from its session. */
export function cursorSource({ home = homedir() } = {}) {
  return {
    name: "cursor-chats",
    async load(win = {}) {
      const turns = [];
      for (const file of files(home, ".cursor/chats/*/*/store.db")) {
        let db;
        try { db = dbReadOnly(file); } catch { continue; }
        try {
          const meta = parse(Buffer.from(String(db.prepare("select value from meta limit 1").get()?.value ?? ""), "hex").toString());
          if (!meta?.agentId) continue;
          const createdAt = Number(meta.createdAt) || statSync(file).mtimeMs;
          if (!inWindow(createdAt, win)) continue;
          const byCall = new Map();
          let model = "";
          const own = [];
          for (const r of db.prepare("select data from blobs").all()) {
            const b = Buffer.from(r.data);
            if (b[0] !== 123) continue;
            const d = parse(b.toString());
            if (!d || !Array.isArray(d.content)) continue;
            if (d.role === "assistant") {
              const calls = [];
              for (const p of d.content) {
                model = p.providerOptions?.cursor?.modelName || model;
                if (p.type !== "tool-call") continue;
                const mcp = p.toolName === "CallMcpTool" && p.args ? `mcp__${p.args.server}__${p.args.toolName}` : p.toolName;
                const call = makeCall(mcp, p.args, false);
                byCall.set(p.toolCallId, call);
                calls.push(call);
              }
              own.push({ calls, model });
            } else if (d.role === "tool") {
              for (const p of d.content) if (p.type === "tool-result" && byCall.has(p.toolCallId)) settle(byCall.get(p.toolCallId), p.result, false);
            }
          }
          for (const t of own) turns.push({ harness: "cursor", native: meta.agentId, cwd: "", sub: false, model: t.model || model || "unknown", ts: createdAt, tok: null, calls: t.calls, sessionSpan: [createdAt, statSync(file).mtimeMs] });
        } finally { db.close(); }
      }
      return { turns, notes: ["Cursor stores no token usage and no per-message time: turns date from session creation."] };
    },
  };
}

/** Runner schedule log lines `<name>: ok|failed in <ms> ms` from the user journal. `run` returns journalctl JSON lines. */
export function journalSource({ run } = {}) {
  const exec = run || ((win) => {
    const args = ["--user", "-u", "ai-collab-runner", "-o", "json", "--no-pager", "-g", "(ok|failed) in [0-9]+ ms"];
    if (win.since != null) args.push("--since", new Date(win.since).toISOString().replace("T", " ").slice(0, 19) + " UTC");
    if (win.until != null) args.push("--until", new Date(win.until).toISOString().replace("T", " ").slice(0, 19) + " UTC");
    return execFileSync("journalctl", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  });
  return {
    name: "runner-journal",
    async load(win = {}) {
      let raw;
      try { raw = exec(win); } catch (e) { return { scheduleRuns: [], notes: [`journalctl unavailable: ${String(e.message).split("\n")[0]}`] }; }
      const scheduleRuns = [];
      for (const line of raw.split("\n")) {
        const d = line ? parse(line) : null;
        const m = d && /(?:^|\s)([\w.-]+): (ok|failed) in (\d+) ms\s*$/.exec(text(d.MESSAGE));
        if (!m) continue;
        const ts = Number(d.__REALTIME_TIMESTAMP) / 1000;
        if (inWindow(ts, win)) scheduleRuns.push({ name: m[1], ok: m[2] === "ok", ms: Number(m[3]), ts });
      }
      return { scheduleRuns };
    },
  };
}

/** Task store: how many tasks were last updated as done per period (a throughput check, not a per-agent metric). */
export function taskStoreSource({ home = homedir() } = {}) {
  return {
    name: "task-store",
    async load() {
      const tasks = [];
      for (const file of files(home, ".local/share/ai-collab/tasks/*.json")) {
        const d = parse(readFileSync(file, "utf8"));
        for (const t of Array.isArray(d?.tasks) ? d.tasks : []) tasks.push({ id: t.id, status: t.status, updated: t.updated, created: t.created, progress: (t.progress || []).length });
      }
      return { tasks };
    },
  };
}
