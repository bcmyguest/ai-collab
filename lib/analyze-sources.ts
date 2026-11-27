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
import { READ_TOOLS } from "./code-run.ts";
import { commandSegments, isStoreBypass } from "./store-read.ts";

export const READ_PATHS = ["mcp_read", "cli_read", "run_code", "run_read_code"];

// CLI read commands that `ai-collab` answers through run_code once readsThroughRunCode is on (see readProgram in cli.mjs).
const CLI_READ = /^(?:\S*\/)?ai-collab\s+(?:task\s+(?:list|show)|agents|sessions|history|peers|team\s+status|pattern\s+list|status)\b/;
const CLI_READ_LOOSE = /(?:^|[\s"'`;&|(])(?:\S*\/)?ai-collab\s+(?:task\s+(?:list|show)|agents|sessions|history|peers|team\s+status|pattern\s+list|status)\b/;
const REFUSAL = /through run_code|reads go through run_code/;
const MCP_NAME = /^(?:mcp__)?(?:plugin_ai-collab_)?(ai-collab-code|ai-collab)(?:__|_)(.+)$/;

const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
const str = (value: unknown): string => Array.isArray(value) ? value.join(" ") : text(value);

export interface Call {
  name: string;
  path: string | null;
  refused: boolean;
  failed: boolean;
}

export interface CallResult {
  path: string | null;
  tool: string;
}

export interface TokenCounts {
  input: number;
  cw5: number;
  cw1: number;
  cacheRead: number;
  output: number;
}

export interface Turn {
  harness: string;
  native: string;
  cwd: string;
  sub: boolean;
  model: string;
  provider?: string;
  ts: number;
  tok: TokenCounts | null;
  calls: Call[];
  ids?: Set<string>;
  sessionSpan?: [number, number];
}

export interface ScheduleRun {
  name: string;
  ok: boolean;
  ms: number;
  ts: number;
}

export interface TaskItem {
  id: string;
  status: string;
  updated: number | string;
  created: number | string;
  progress: number;
}

export interface SourceWindow {
  since?: number;
  until?: number;
}

export interface SourceResult {
  turns?: Turn[];
  scheduleRuns?: ScheduleRun[];
  tasks?: TaskItem[];
  notes?: string[];
}

export interface Source {
  name: string;
  load(win?: SourceWindow): Promise<SourceResult>;
}

type JsonObj = Record<string, unknown>;
type Json = string | number | boolean | null | Json[] | JsonObj;

/** The ai-collab read path a tool call used, or null: {path, tool}. */
export function classifyCall({ name = "", input, loose = false }: { name?: string; input?: unknown; loose?: boolean }): CallResult {
  const mcp = MCP_NAME.exec(name);
  if (mcp) {
    const [, server, tool] = mcp;
    if (server === "ai-collab-code") return { path: tool === "run_read_code" ? "run_read_code" : tool === "run_code" ? "run_code" : null, tool };
    return { path: READ_TOOLS.includes(tool) ? "mcp_read" : null, tool };
  }
  const command = typeof input === "string" ? input : str((input as JsonObj)?.command ?? (input as JsonObj)?.cmd);
  const bypassCall = { name, input };
  if (command) {
    if (loose ? CLI_READ_LOOSE.test(command) : commandSegments(command).some((s: string) => CLI_READ.test(s))) return { path: "cli_read", tool: "cli" };
    if (isStoreBypass(bypassCall)) return { path: "bypass_read", tool: "shell" };
    return { path: null, tool: name };
  }
  if (isStoreBypass(bypassCall)) return { path: "bypass_read", tool: name.toLowerCase() };
  return { path: null, tool: name };
}

export const isRefusal = (content: unknown): boolean => REFUSAL.test(text(content));

/** A run_code result that failed: ok:false, a staging error, or an error that is not a read refusal. */
export function isRunCodeFailure(content: unknown, isError: boolean): boolean {
  const s = text(content);
  if (isRefusal(s)) return false;
  return /"ok"\s*:\s*false/.test(s) || /could not stage/.test(s) || Boolean(isError);
}

function makeCall(name: string, input: unknown, loose: boolean): Call {
  const { path } = classifyCall({ name, input, loose });
  return { name, path, refused: false, failed: false };
}

function settle(call: Call, content: unknown, isError: boolean): void {
  if (!call.path) return;
  if (call.path !== "bypass_read" && isRefusal(content)) call.refused = true;
  else if ((call.path === "run_code" || call.path === "run_read_code") && isRunCodeFailure(content, isError)) call.failed = true;
}

const inWindow = (ts: number, { since, until }: SourceWindow): boolean => Number.isFinite(ts) && !(since != null && ts < since) && !(until != null && ts >= until);
const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n");
const parse = (line: string): Json | null => { try { return JSON.parse(line) as Json; } catch { return null; } };
const files = (home: string, pattern: string): string[] => globSync(join(home, pattern));

/** Claude Code transcripts: dedupe on message.id + requestId, keep the max output count, union the tool_use blocks. */
export function claudeSource({ home = homedir() }: { home?: string } = {}): Source {
  return {
    name: "claude-transcripts",
    async load(win: SourceWindow = {}): Promise<SourceResult> {
      const turns: Turn[] = [];
      for (const file of files(home, ".claude/projects/**/*.jsonl")) {
        const byKey = new Map<string, Turn>();
        const pending = new Map<string, Call>();
        for (const line of lines(file)) {
          const wantsResult = pending.size && line.includes("tool_result");
          if (!wantsResult && !line.includes('"usage"')) continue;
          const d = parse(line) as JsonObj | null;
          const m = d?.message as JsonObj | undefined;
          if (!m || typeof m !== "object") continue;
          if ((m).role === "user" && wantsResult && Array.isArray((m).content)) {
            for (const p of (m).content as JsonObj[]) {
              const tuId = (p).tool_use_id as string;
              if ((p).type === "tool_result" && pending.has(tuId)) settle(pending.get(tuId) as Call, (p).content, (p).is_error === true);
            }
            continue;
          }
          if ((m).role !== "assistant" || !(m).usage || !(m).id || !(d as JsonObj).timestamp || !((m).model as string) || ((m).model as string).startsWith("<")) continue;
          const key = `${(m).id}|${(d as JsonObj).requestId ?? ""}`;
          let turn = byKey.get(key);
          if (!turn) {
            turn = { harness: "claude", native: ((d as JsonObj).sessionId as string) || (file.split("/").pop() || "").replace(/\.jsonl$/, ""), cwd: ((d as JsonObj).cwd as string) || "", sub: (d as JsonObj).isSidechain === true || file.includes("/subagents/"), model: (m).model as string, ts: Date.parse(((d as JsonObj).timestamp as string) || ""), tok: null, calls: [], ids: new Set<string>() };
            byKey.set(key, turn);
          }
          const u = (m).usage as Record<string, number> | undefined;
          if (!turn.tok || (u?.output_tokens || 0) >= turn.tok.output) {
            const cc = (u?.cache_creation || {}) as Record<string, number>;
            const c1 = cc.ephemeral_1h_input_tokens || 0;
            let c5 = cc.ephemeral_5m_input_tokens || 0;
            const total = u?.cache_creation_input_tokens || 0;
            if (c1 + c5 < total) c5 = total - c1;
            turn.tok = { input: u?.input_tokens || 0, cw5: c5, cw1: c1, cacheRead: u?.cache_read_input_tokens || 0, output: u?.output_tokens || 0 };
          }
          for (const p of Array.isArray((m).content) ? (m).content as JsonObj[] : []) {
            if ((p).type !== "tool_use" || (turn.ids as Set<string>).has((p).id as string)) continue;
            (turn.ids as Set<string>).add((p).id as string);
            const call = makeCall((p).name as string, (p).input, false);
            turn.calls.push(call);
            if (call.path) pending.set((p).id as string, call);
          }
        }
        for (const turn of byKey.values()) { delete turn.ids; if (inWindow(turn.ts, win)) turns.push(turn); }
      }
      return { turns };
    },
  };
}

/** Codex rollouts: one turn per response_id from token_usage_record; calls attach to the next usage record. */
export function codexSource({ home = homedir() }: { home?: string } = {}): Source {
  return {
    name: "codex-sessions",
    async load(win: SourceWindow = {}): Promise<SourceResult> {
      const turns: Turn[] = [];
      for (const file of files(home, ".codex/sessions/**/*.jsonl")) {
        let native = file;
        let cwd = "";
        let sub = false;
        let model = "";
        const models = new Map<string, string>();
        const seen = new Set<string>();
        const byCall = new Map<string, Call>();
        let queued: Call[] = [];
        let last: Turn | null = null;
        const emit = (ts: string, tid: string, tok: TokenCounts): void => {
          const t = { harness: "codex", native, cwd, sub, model: models.get(tid) || model, ts: Date.parse(ts), tok, calls: queued };
          queued = [];
          last = t;
          if (inWindow(t.ts, win)) turns.push(t);
        };
        for (const line of lines(file)) {
          const d = parse(line) as JsonObj | null;
          const p = (d?.payload || {}) as JsonObj;
          if ((d as JsonObj)?.type === "session_meta") { native = (p).id as string || native; cwd = (p).cwd as string || cwd; sub = Boolean(((p).source as JsonObj)?.subagent) || sub; }
          else if ((d as JsonObj)?.type === "turn_context") { model = (p).model as string || model; models.set((p).turn_id as string, (p).model as string); cwd = (p).cwd as string || cwd; }
          else if ((d as JsonObj)?.type === "response_item" && ((p).type === "function_call" || (p).type === "custom_tool_call")) {
            const call = makeCall((p).namespace ? `${(p).namespace as string}${(p).name as string}` : (p).name as string, (p).type === "function_call" ? parseArgs((p).arguments) : (p).input, (p).type === "custom_tool_call");
            byCall.set((p).call_id as string, call);
            queued.push(call);
          } else if ((d as JsonObj)?.type === "response_item" && ((p).type === "function_call_output" || (p).type === "custom_tool_call_output")) {
            const call = byCall.get((p).call_id as string);
            if (call) settle(call, outputText((p).output), false);
          } else if ((d as JsonObj)?.type === "token_usage_record" && (p).usage) {
            if (seen.has((p).response_id as string)) continue;
            seen.add((p).response_id as string);
            const u = (p).usage as Record<string, number> | undefined;
            emit((d as JsonObj)?.timestamp as string, (p).turn_id as string, { input: (u?.input_tokens || 0) - (u?.cached_input_tokens || 0), cw5: 0, cw1: 0, cacheRead: u?.cached_input_tokens || 0, output: u?.output_tokens || 0 });
          }
        }
        if (queued.length && last) { (last as Turn).calls.push(...queued); }
      }
      return { turns };
    },
  };
}

const parseArgs = (value: unknown): Json => { if (typeof value !== "string") return value as Json; try { return JSON.parse(value) as Json; } catch { return value; } };
const outputText = (out: unknown): string => Array.isArray(out) ? out.map((o) => (o as JsonObj | null)?.text ?? "").join("\n") : text(out);

const dbReadOnly = (file: string): DatabaseSync => new DatabaseSync(file, { readOnly: true });

/** OpenCode: assistant messages carry tokens; tool parts hang off a message. */
export function opencodeSource({ home = homedir() }: { home?: string } = {}): Source {
  return {
    name: "opencode-db",
    async load(win: SourceWindow = {}): Promise<SourceResult> {
      const file = join(home, ".local/share/opencode/opencode.db");
      let db: DatabaseSync;
      try { db = dbReadOnly(file); } catch { return { turns: [], notes: ["OpenCode database not readable"] }; }
      try {
        const parts = new Map<string, Call[]>();
        for (const r of db.prepare("select message_id, data from part where json_extract(data, '$.type') = 'tool'").all() as { message_id: string; data: string }[]) {
          const p = parse(r.data) as JsonObj | null;
          if (!p) continue;
          const state = (p).state as JsonObj | undefined;
          const call = makeCall((p).tool as string, state?.input, false);
          settle(call, state?.output ?? state?.error, state?.status === "error");
          const arr = parts.get(r.message_id);
          if (arr) arr.push(call); else parts.set(r.message_id, [call]);
        }
        const turns: Turn[] = [];
        const q = "select m.id, m.session_id, m.time_created, m.data, s.directory, s.parent_id from message m left join session s on s.id = m.session_id";
        for (const r of db.prepare(q).all() as { id: string; session_id: string; time_created: string | number; data: string; directory: string; parent_id: string | null }[]) {
          const d = parse(r.data) as JsonObj | null;
          if ((d as JsonObj)?.role !== "assistant") continue;
          const t = (d as JsonObj).tokens || {};
          const ts = Number(r.time_created);
          if (!inWindow(ts, win)) continue;
          const c = (t as JsonObj).cache || {};
          const tok = ((t as JsonObj).input as number) || ((t as JsonObj).output as number) ? { input: ((t as JsonObj).input as number) || 0, cw5: ((c as JsonObj).write as number) || 0, cw1: 0, cacheRead: ((c as JsonObj).read as number) || 0, output: (((t as JsonObj).output as number) || 0) + (((t as JsonObj).reasoning as number) || 0) } : null;
          turns.push({ harness: "opencode", native: r.session_id, cwd: r.directory || "", sub: Boolean(r.parent_id), model: (d as JsonObj).modelID as string || "unknown", provider: (d as JsonObj).providerID as string, ts, tok, calls: parts.get(r.id) || [] });
        }
        return { turns };
      } finally { db.close(); }
    },
  };
}

/** Cursor chat stores: tool calls and model name only. No usage and no per-message time, so a turn dates from its session. */
export function cursorSource({ home = homedir() }: { home?: string } = {}): Source {
  return {
    name: "cursor-chats",
    async load(win: SourceWindow = {}): Promise<SourceResult> {
      const turns: Turn[] = [];
      for (const file of files(home, ".cursor/chats/*/*/store.db")) {
        let db: DatabaseSync;
        try { db = dbReadOnly(file); } catch { continue; }
        try {
          const meta = parse(Buffer.from(String((db.prepare("select value from meta limit 1").get()?.value ?? "") as string), "hex").toString()) as JsonObj | null;
          if (!(meta as JsonObj)?.agentId) continue;
          const createdAt = Number((meta as JsonObj).createdAt) || statSync(file).mtimeMs;
          if (!inWindow(createdAt, win)) continue;
          const byCall = new Map<string, Call>();
          let model = "";
          const own: { calls: Call[]; model: string }[] = [];
          for (const r of db.prepare("select data from blobs").all() as { data: Buffer | Uint8Array }[]) {
            const b = Buffer.from(r.data);
            if (b[0] !== 123) continue;
            const d = parse(b.toString()) as JsonObj | null;
            if (!d || !Array.isArray((d).content)) continue;
            if ((d).role === "assistant") {
              const calls: Call[] = [];
              for (const p of (d).content as JsonObj[]) {
                model = (((p).providerOptions as JsonObj)?.cursor as JsonObj)?.modelName as string || model;
                if ((p).type !== "tool-call") continue;
                const mcp = (p).toolName === "CallMcpTool" && (p).args ? `mcp__${((p).args as JsonObj).server}__${((p).args as JsonObj).toolName}` : (p).toolName as string;
                const call = makeCall(mcp, (p).args, false);
                byCall.set((p).toolCallId as string, call);
                calls.push(call);
              }
              own.push({ calls, model });
            } else if ((d).role === "tool") {
              for (const p of (d).content as JsonObj[]) {
                if ((p).type === "tool-result" && byCall.has((p).toolCallId as string)) {
                  const call = byCall.get((p).toolCallId as string);
                  if (call) settle(call, (p).result, false);
                }
              }
            }
          }
          for (const t of own) turns.push({ harness: "cursor", native: (meta as JsonObj).agentId as string || "", cwd: "", sub: false, model: t.model || model || "unknown", ts: createdAt, tok: null, calls: t.calls, sessionSpan: [createdAt, statSync(file).mtimeMs] });
        } finally { db.close(); }
      }
      return { turns, notes: ["Cursor stores no token usage and no per-message time: turns date from session creation."] };
    },
  };
}

/** Runner schedule log lines `<name>: ok|failed in <ms> ms` from the user journal. `run` returns journalctl JSON lines. */
export function journalSource({ run }: { run?: (win: SourceWindow) => string } = {}): Source {
  const exec = run || ((win: SourceWindow): string => {
    const args: string[] = ["--user", "-u", "ai-collab-runner", "-o", "json", "--no-pager", "-g", "(ok|failed) in [0-9]+ ms"];
    if (win.since != null) args.push("--since", new Date(win.since).toISOString().replace("T", " ").slice(0, 19) + " UTC");
    if (win.until != null) args.push("--until", new Date(win.until).toISOString().replace("T", " ").slice(0, 19) + " UTC");
    return execFileSync("journalctl", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  });
  return {
    name: "runner-journal",
    async load(win: SourceWindow = {}): Promise<SourceResult> {
      let raw: string;
      try { raw = exec(win); } catch (e: unknown) { return { scheduleRuns: [], notes: [`journalctl unavailable: ${String((e as Error).message).split("\n")[0]}`] }; }
      const scheduleRuns: ScheduleRun[] = [];
      for (const line of raw.split("\n")) {
        const d = line ? parse(line) : null;
        const m = d ? (/(?:^|\s)([\w.-]+): (ok|failed) in (\d+) ms\s*$/.exec(text((d as JsonObj).MESSAGE))) : null;
        if (!m) continue;
        const ts = Number((d as JsonObj)?.__REALTIME_TIMESTAMP) / 1000;
        if (inWindow(ts, win)) scheduleRuns.push({ name: m[1], ok: m[2] === "ok", ms: Number(m[3]), ts });
      }
      return { scheduleRuns };
    },
  };
}

/** Task store: how many tasks were last updated as done per period (a throughput check, not a per-agent metric). */
export function taskStoreSource({ home = homedir() }: { home?: string } = {}): Source {
  return {
    name: "task-store",
    async load(): Promise<SourceResult> {
      const tasks: TaskItem[] = [];
      for (const file of files(home, ".local/share/ai-collab/tasks/*.json")) {
        const d = parse(readFileSync(file, "utf8")) as JsonObj | null;
        const taskList = Array.isArray((d as JsonObj)?.tasks) ? (d as JsonObj).tasks as JsonObj[] : [];
        for (const t of taskList) tasks.push({ id: (t).id as string, status: (t).status as string, updated: (t).updated as string | number, created: (t).created as string | number, progress: (((t).progress || []) as unknown[]).length });
      }
      return { tasks };
    },
  };
}
