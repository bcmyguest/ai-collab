/**
 * `ai-collab analyze run-code`: how forcing ai-collab reads through run_code / run_read_code changed agent behaviour
 * and cost, before vs after a cutover. Reads local harness logs only; sources live in analyze-sources.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { sessionLabel } from "./config.mjs";
import { sessionOfCommand } from "./schedule-session.mjs";
import { READ_PATHS, claudeSource, codexSource, cursorSource, journalSource, opencodeSource, taskStoreSource } from "./analyze-sources.ts";
import type { Source, SourceResult, SourceWindow, ScheduleRun, TaskItem, TokenCounts, Turn } from "./analyze-sources.ts";
import { encodeTraceRequest } from "./analyze-otlp.mjs";

export const DEFAULT_CUTOVER = "2026-11-23T03:15:00Z";
export const DEFAULT_PARTIAL = "2026-11-23T02:30:00Z";
export const DEFAULT_TZ = "America/Toronto";
export const HARNESSES: string[] = ["claude", "codex", "cursor", "opencode"];
export const ROLES: string[] = ["pm", "builder", "interactive", "subagent"];
const PERIODS: string[] = ["before", "partial", "after"];
const TOP_AGENTS = 15;

export const USAGE = `usage: ai-collab analyze run-code [--since ISO] [--until ISO] [--cutover ISO] [--partial ISO|none] [--agent SELECTOR]...
                                [--tz ZONE] [--out FILE|-] [--jsonl FILE] [--otlp-export URL] [--phoenix-project NAME]
  --cutover   instant run_code reads became enforced everywhere (default ${DEFAULT_CUTOVER})
  --partial   instant MCP reads became enforced, CLI reads not yet (default ${DEFAULT_PARTIAL}; none disables the middle period)
  --agent     keep one agent: harness#label (16 hex), a harness (claude codex cursor opencode) or a role (pm builder interactive subagent);
              repeatable; values of one kind are alternatives, different kinds must all match
  --tz        zone for ISO weeks (default ${DEFAULT_TZ})
  --out       markdown report (default docs/research/run-code-impact-<date>.md; - prints it)
  --jsonl     one JSON row per agent x model x period x week
  --otlp-export URL   POST one span per turn (OTLP/HTTP protobuf, e.g. http://localhost:6006/v1/traces for Phoenix)`;

// Official list prices in USD per million tokens (docs/research/api-cost-estimate-2026-11-22.md).
// Claude: [input, 5-minute cache write, 1-hour cache write, cache read, output].
const CLAUDE: Record<string, number[]> = {
  "claude-opus-5-5": [4, 5, 8, 0.2, 20], "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10],
  "claude-fable-5-2": [8, 10, 16, 0.2, 40], "claude-fable-5-1": [10, 12.5, 20, 0.25, 50],
};
const HAIKU_LOW = [0.1, 0.125, 0.2, 0.01, 0.5];
const HAIKU_HIGH = [0.5, 0.625, 1, 0.05, 2.5];
// OpenAI: [short, long (> 272K input)] each [input, cached input, output].
const OPENAI: Record<string, number[][]> = {
  "gpt-6-astra": [[10, 1, 50], [20, 2, 75]], "gpt-6-sol": [[2, 0.2, 10], [4, 0.4, 15]], "gpt-6-luna": [[0.1, 0.01, 0.5], [0.2, 0.02, 0.75]],
  "gpt-6.1-sol": [[2, 0.1, 10], [4, 0.2, 15]], "gpt-6.1-terra": [[1, 0.05, 5], [2, 0.1, 7.5]], "gpt-6.2-astra": [[8, 0.4, 40], [16, 0.8, 60]],
  "gpt-6.2-sol": [[2, 0.1, 10], [4, 0.2, 15]], "gpt-5.6-sol": [[4, 0.4, 20], [8, 0.8, 30]], "gpt-5.6-terra": [[2, 0.2, 12], [4, 0.4, 18]],
  "gpt-5.6-luna": [[0.2, 0.02, 1.2], [0.4, 0.04, 1.8]], "gpt-5.3-codex": [[1.75, 0.175, 14], [1.75, 0.175, 14]],
};
const BUILDER_CWD = /\/ai-collab-wt-|\/\.local\/state\/ai-collab\/builders\/|^\/sandbox(?:\/|$)/;
const ADDRESS = /^(claude|codex|cursor|opencode)#[0-9a-f]{16}$/;
const VALUE_FLAGS = ["since", "until", "cutover", "partial", "out", "jsonl", "tz", "otlp-export", "phoenix-project", "schedules"];
const OPTIONS: ParseArgsOptionsConfig = {
  help: { type: "boolean", short: "h" },
  agent: { type: "string", multiple: true, default: [] },
  ...Object.fromEntries(VALUE_FLAGS.map((name) => [name, { type: "string" }])),
};

export type Role = "pm" | "builder" | "interactive" | "subagent";
export type Period = "before" | "partial" | "after";
export interface Cut { partial: number | null; cutover: number }
export interface Selector { type: "address" | "harness" | "role"; value: string }
export interface Annotated extends Turn { agent: string; role: Role; period: Period; week: string }
export interface Ctx { cut: Cut; tz: string; pmLabels: Set<string>; selectors: Selector[] }
type Pair = { mcp: number; cli: number };
type Quad = { input: number; cacheWrite: number; cacheRead: number; output: number };
type Tot = { n: number; input: number; cacheRead: number; output: number };
export type Row = {
  agent?: string; harness?: string; model?: string; role?: string; period?: string; week?: string;
  turns: number; usageTurns: number; calls: number;
  reads: Record<string, number>; refusals: Pair; runCodeErrors: number;
  tok: Quad; readTurns: Tot; plainTurns: Tot; usd: number; pricedTurns: number;
};
interface Flags {
  help?: boolean; agents: string[]; since?: string; until?: string; cutover?: string; partial?: string;
  out?: string; jsonl?: string; tz?: string; "otlp-export"?: string; "phoenix-project"?: string; schedules?: string;
}
interface Writer { write(chunk: string): unknown }
export interface AnalyzeIo {
  env?: NodeJS.ProcessEnv; stdout?: Writer; stderr?: Writer;
  journal?: (win: SourceWindow) => string; sources?: Source[];
}
export interface ReportOpts {
  cut: Cut; tz: string; since: number | null; until: number | null;
  scheduleRuns?: ScheduleRun[]; tasks?: TaskItem[] | null; notes?: string[]; generated: string;
  selectors?: Selector[]; sources?: string[]; latest?: number | null;
}

/** List-price USD for one turn's tokens, or null when the model has no published price. */
export function priceTurn(harness: string, model: string, tok: TokenCounts | null): number | null {
  if (!tok) return null;
  const { input, cw5, cw1, cacheRead, output } = tok;
  if (harness === "claude") {
    const p = model === "claude-haiku-5-5" ? (input + cw5 + cw1 + cacheRead > 100000 ? HAIKU_HIGH : HAIKU_LOW) : CLAUDE[model];
    return p ? (input * p[0] + cw5 * p[1] + cw1 * p[2] + cacheRead * p[3] + output * p[4]) / 1e6 : null;
  }
  if (harness === "codex" && OPENAI[model]) {
    const [short, long] = OPENAI[model];
    const p = input + cacheRead > 272000 ? long : short;
    return (input * p[0] + cacheRead * p[1] + output * p[2]) / 1e6;
  }
  return null;
}

/** before / partial / after for a timestamp in ms; cut = {partial: ms|null, cutover: ms}. */
export function periodOf(ts: number, { partial, cutover }: Cut): Period {
  if (ts >= cutover) return "after";
  return partial != null && partial < cutover && ts >= partial ? "partial" : "before";
}

/** ISO 8601 week (YYYY-Www) of a timestamp in a time zone. */
export function isoWeek(ts: number, tz: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ts).map((p) => [p.type, p.value]));
  const d = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const week = Math.ceil((((d as unknown as number) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** pm: a session a schedule resumes; subagent: spawned by another session; builder: a builder worktree or sandbox cwd. */
export function classifyRole({ native, cwd, sub }: Pick<Turn, "native" | "cwd" | "sub">, { pmLabels }: { pmLabels: Set<string> }): Role {
  if (sub) return "subagent";
  if (pmLabels.has(sessionLabel(native))) return "pm";
  return BUILDER_CWD.test(cwd || "") ? "builder" : "interactive";
}

/** --agent values to selectors; throws on an unknown one. */
export function parseSelectors(values: string[]): Selector[] {
  return values.map((v): Selector => {
    if (ADDRESS.test(v)) return { type: "address", value: v };
    if (HARNESSES.includes(v)) return { type: "harness", value: v };
    if (ROLES.includes(v)) return { type: "role", value: v };
    throw new Error(`bad agent selector "${v}": use harness#<16 hex>, ${HARNESSES.join("|")} or ${ROLES.join("|")}`);
  });
}

/** Selectors of one kind are alternatives; every kind present must match. */
export function matchesSelectors(row: { agent: string; harness: string; role: string }, selectors: Selector[]): boolean {
  const field: Record<string, string> = { address: row.agent, harness: row.harness, role: row.role };
  for (const type of new Set(selectors.map((s) => s.type))) {
    if (!selectors.some((s) => s.type === type && s.value === field[type])) return false;
  }
  return true;
}

/** Turns with agent, role, period and week attached, filtered by the selectors. */
export function annotate(turns: Turn[], { cut, tz, pmLabels, selectors }: Ctx): Annotated[] {
  const out: Annotated[] = [];
  for (const t of turns) {
    const a = { ...t, agent: `${t.harness}#${sessionLabel(t.native)}`, role: classifyRole(t, { pmLabels }), period: periodOf(t.ts, cut), week: isoWeek(t.ts, tz) };
    if (matchesSelectors(a, selectors)) out.push(a);
  }
  return out;
}

const zeroTok = (): Tot => ({ n: 0, input: 0, cacheRead: 0, output: 0 });
const emptyRow = (key: Partial<Row> = {}): Row => ({
  ...key, turns: 0, usageTurns: 0, calls: 0,
  reads: Object.fromEntries([...READ_PATHS, "bypass_read"].map((p) => [p, 0])),
  refusals: { mcp: 0, cli: 0 }, runCodeErrors: 0,
  tok: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  readTurns: zeroTok(), plainTurns: zeroTok(), usd: 0, pricedTurns: 0,
});
const addTok = (a: Record<string, number>, b: Record<string, number>): void => { for (const k of Object.keys(a)) a[k] += b[k]; };

function addRow(a: Row, b: Row): Row {
  for (const k of ["turns", "usageTurns", "calls", "runCodeErrors", "usd", "pricedTurns"] as const) a[k] += b[k];
  for (const k of Object.keys(a.reads)) a.reads[k] += b.reads[k];
  addTok(a.refusals, b.refusals); addTok(a.tok, b.tok); addTok(a.readTurns, b.readTurns); addTok(a.plainTurns, b.plainTurns);
  return a;
}

/** Group rows by a key function; each group sums the rows it holds. */
export function groupRows(rows: Row[], keyOf: (r: Row) => Partial<Row>): Row[] {
  const groups = new Map<string, Row>();
  for (const r of rows) {
    const key = keyOf(r);
    const k = JSON.stringify(key);
    if (!groups.has(k)) groups.set(k, emptyRow(key));
    addRow(groups.get(k) as Row, r);
  }
  return [...groups.values()];
}

/** One row per agent x harness x model x role x period x week. */
export function aggregate(turns: Turn[], ctx: Ctx): Row[] {
  const rows = new Map<string, Row>();
  for (const t of annotate(turns, ctx)) {
    const key = { agent: t.agent, harness: t.harness, model: t.model, role: t.role, period: t.period, week: t.week };
    const k = Object.values(key).join("|");
    if (!rows.has(k)) rows.set(k, emptyRow(key));
    const r = rows.get(k) as Row;
    r.turns += 1;
    r.calls += t.calls.length;
    let reads = false;
    for (const c of t.calls) {
      if (!c.path) continue;
      r.reads[c.path] += 1;
      if (READ_PATHS.includes(c.path)) reads = true;
      if (c.refused) r.refusals[c.path === "mcp_read" ? "mcp" : "cli"] += 1;
      if (c.failed) r.runCodeErrors += 1;
    }
    if (!t.tok) continue;
    r.usageTurns += 1;
    const input = t.tok.input + t.tok.cw5 + t.tok.cw1;
    addTok(r.tok, { input: t.tok.input, cacheWrite: t.tok.cw5 + t.tok.cw1, cacheRead: t.tok.cacheRead, output: t.tok.output });
    addTok(reads ? r.readTurns : r.plainTurns, { n: 1, input, cacheRead: t.tok.cacheRead, output: t.tok.output });
    const usd = priceTurn(t.harness, t.model, t.tok);
    if (usd != null) { r.usd += usd; r.pricedTurns += 1; }
  }
  return [...rows.values()];
}

const n = (x: number): string => Math.round(x).toLocaleString("en-US");
const per = (sum: number, count: number): string => count ? n(sum / count) : "-";
const ratio = (sum: number, count: number): string => count ? (sum / count).toFixed(2) : "-";
const usdCell = (r: Row): string => !r.usageTurns ? "no usage data" : r.pricedTurns === 0 ? "unpriced" : `$${r.usd.toFixed(2)}${r.pricedTurns < r.usageTurns ? "*" : ""}`;
const table = (head: string[], body: Array<Array<string | number>>): string => [`| ${head.join(" | ")} |`, `|${head.map((_, i) => i < 1 ? "---" : "---:").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const order = (a: string | undefined, b: string | undefined): number => PERIODS.indexOf(a as string) - PERIODS.indexOf(b as string);
const readCalls = (r: Row): number => READ_PATHS.reduce((s, p) => s + r.reads[p], 0);
const pct = (xs: number[], p: number): number => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0;
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

/** The markdown report for aggregated rows. */
export function renderReport(rows: Row[], { cut, tz, since, until, scheduleRuns = [], tasks = null, notes = [], generated, selectors = [], sources = [], latest = null }: ReportOpts): string {
  const present = PERIODS.filter((p) => rows.some((r) => r.period === p));
  const out = [`# Impact of run_code reads, generated ${generated}`, ""];
  out.push("Measured from local harness logs. Periods split at the cutover instants below; every figure counts only what the logs record.", "");
  out.push(`- Cutover (CLI and MCP reads both enforced): ${iso(cut.cutover)}`);
  out.push(`- Partial marker (MCP reads enforced, CLI reads not yet): ${cut.partial != null && cut.partial < cut.cutover ? iso(cut.partial) : "none"}`);
  out.push(`- Window: ${since != null ? iso(since) : "all data"} to ${until != null ? iso(until) : "now"}`);
  out.push(`- ISO weeks in ${tz}`);
  out.push(`- Agent filter: ${selectors.length ? selectors.map((s) => s.value).join(", ") : "none"}`);
  out.push(`- Sources: ${sources.join(", ")}`);
  if (latest != null && latest > cut.cutover && latest - cut.cutover < 48 * 3600e3) out.push(`- Early data: the after period covers ${((latest - cut.cutover) / 3600e3).toFixed(1)} hours (latest turn ${iso(latest)}); read its figures as a first look.`);
  out.push("");

  out.push("## Headline by period", "");
  const head = (rs: Row[]): Row[] => groupRows(rs, (r) => ({ period: r.period })).sort((a, b) => order(a.period, b.period));
  out.push(table(["Period", "Turns", "MCP reads", "CLI reads", "run_code", "run_read_code", "Bypass reads", "MCP refused", "CLI refused", "run_code failures", "Calls/turn", "Tokens", "List $"],
    head(rows).map((r) => [r.period as string, n(r.turns), r.reads.mcp_read, r.reads.cli_read, r.reads.run_code, r.reads.run_read_code, r.reads.bypass_read, r.refusals.mcp, r.refusals.cli, r.runCodeErrors, ratio(r.calls, r.turns), n(r.tok.input + r.tok.cacheWrite + r.tok.cacheRead + r.tok.output), usdCell(r)])), "");
  out.push("Tokens sum uncached input, cache writes, cache reads and output over turns with usage data. List $ prices only turns whose model has a published price; `*` marks a partly priced group.", "");

  out.push("## Read paths by harness, model and period", "");
  out.push(table(["Harness", "Model", "Period", "Turns", "Read turns", "MCP", "CLI", "run_code", "run_read_code", "Bypass", "MCP refused", "CLI refused", "run_code failures", "Calls/turn"],
    groupRows(rows, (r) => ({ harness: r.harness, model: r.model, period: r.period })).sort((a, b) => (a.harness as string).localeCompare(b.harness as string) || (a.model as string).localeCompare(b.model as string) || order(a.period, b.period))
      .map((r) => [r.harness as string, r.model as string, r.period as string, n(r.turns), r.readTurns.n, r.reads.mcp_read, r.reads.cli_read, r.reads.run_code, r.reads.run_read_code, r.reads.bypass_read, r.refusals.mcp, r.refusals.cli, r.runCodeErrors, ratio(r.calls, r.turns)])), "");

  out.push("## Tokens per turn: turns with ai-collab reads vs without", "");
  out.push("Input counts uncached input plus cache writes; cached is cache reads. Turns without usage data (Cursor) are left out.", "");
  out.push(table(["Harness", "Model", "Period", "Read turns", "Input", "Cached", "Output", "Plain turns", "Input", "Cached", "Output"],
    groupRows(rows, (r) => ({ harness: r.harness, model: r.model, period: r.period })).filter((r) => r.usageTurns).sort((a, b) => (a.harness as string).localeCompare(b.harness as string) || (a.model as string).localeCompare(b.model as string) || order(a.period, b.period))
      .map((r) => [r.harness as string, r.model as string, r.period as string, r.readTurns.n, per(r.readTurns.input, r.readTurns.n), per(r.readTurns.cacheRead, r.readTurns.n), per(r.readTurns.output, r.readTurns.n), r.plainTurns.n, per(r.plainTurns.input, r.plainTurns.n), per(r.plainTurns.cacheRead, r.plainTurns.n), per(r.plainTurns.output, r.plainTurns.n)])), "");

  out.push("## By role and period", "");
  out.push(table(["Role", "Period", "Turns", "Read calls", "Refused", "Bypass", "run_code failures", "Calls/turn", "Tokens", "List $"],
    groupRows(rows, (r) => ({ role: r.role, period: r.period })).sort((a, b) => ROLES.indexOf(a.role as string) - ROLES.indexOf(b.role as string) || order(a.period, b.period))
      .map((r) => [r.role as string, r.period as string, n(r.turns), readCalls(r), r.refusals.mcp + r.refusals.cli, r.reads.bypass_read, r.runCodeErrors, ratio(r.calls, r.turns), n(r.tok.input + r.tok.cacheWrite + r.tok.cacheRead + r.tok.output), usdCell(r)])), "");

  out.push("## Tokens and list price per ISO week", "");
  out.push(table(["Week", "Harness", "Model", "Turns", "Input", "Cache write", "Cache read", "Output", "List $"],
    groupRows(rows, (r) => ({ week: r.week, harness: r.harness, model: r.model })).sort((a, b) => (a.week as string).localeCompare(b.week as string) || (a.harness as string).localeCompare(b.harness as string) || (a.model as string).localeCompare(b.model as string))
      .map((r) => [r.week as string, r.harness as string, r.model as string, n(r.turns), n(r.tok.input), n(r.tok.cacheWrite), n(r.tok.cacheRead), n(r.tok.output), usdCell(r)])), "");

  out.push("## Per-agent (top by tokens)", "");
  const agents = groupRows(rows, (r) => ({ agent: r.agent, harness: r.harness, role: r.role }));
  const total = (r: Row): number => r.tok.input + r.tok.cacheWrite + r.tok.cacheRead + r.tok.output;
  agents.sort((a, b) => total(b) - total(a) || b.turns - a.turns);
  out.push(table(["Agent", "Harness", "Role", "Models", "Turns", "Tokens", "MCP", "CLI", "run_code", "run_read_code", "Bypass", "Refused", "List $"],
    agents.slice(0, TOP_AGENTS).map((r) => [r.agent as string, r.harness as string, r.role as string, [...new Set(rows.filter((x) => x.agent === r.agent && x.role === r.role).map((x) => x.model))].join(", "), n(r.turns), n(total(r)), r.reads.mcp_read, r.reads.cli_read, r.reads.run_code, r.reads.run_read_code, r.reads.bypass_read, r.refusals.mcp + r.refusals.cli, usdCell(r)])), "");
  out.push(`${agents.length} agents in total; the table lists the top ${Math.min(TOP_AGENTS, agents.length)}. The JSONL file holds every agent.`, "");

  out.push("## Runner schedule runs (wall time)", "");
  if (scheduleRuns.length) {
    const g = new Map<string, ScheduleRun[]>();
    for (const r of scheduleRuns) {
      const k = `${r.name}|${periodOf(r.ts, cut)}`;
      (g.get(k) || g.set(k, []).get(k) as ScheduleRun[]).push(r);
    }
    out.push(table(["Schedule", "Period", "Runs", "Failed", "Median", "p90", "Mean"],
      [...g.entries()].map(([k, rs]) => [...k.split("|"), rs] as [string, string, ScheduleRun[]]).sort((a, b) => a[0].localeCompare(b[0]) || order(a[1], b[1])).map(([name, period, rs]) => {
        const ms = rs.map((r) => r.ms);
        return [name, period, rs.length, rs.filter((r) => !r.ok).length, sec(pct(ms, 0.5)), sec(pct(ms, 0.9)), sec(ms.reduce((s, x) => s + x, 0) / ms.length)];
      })), "");
    out.push("These are machine-wide schedule runs, not filtered by --agent.", "");
  } else out.push("No schedule run lines found in the window.", "");

  if (tasks) {
    out.push("## Task store throughput", "");
    const done = tasks.filter((t) => t.status === "done" && Number.isFinite(t.updated));
    out.push(table(["Period", "Tasks last updated as done"], present.map((p) => [p, done.filter((t) => periodOf(t.updated as number, cut) === p).length])), "");
    out.push("A task's last update time stands for its completion time; later edits move it.", "");
  }

  out.push("## Method and gaps", "");
  out.push(
    "- Turn = one model response. Claude: one per message.id + requestId, keeping the largest output count; tool_use blocks are the union over the split lines. Codex: one per response_id of token_usage_record, with tool calls attached to the next record. OpenCode: one per assistant message.",
    "- Read paths: MCP read tools of the ai-collab server (task_list, list_agents, list_sessions, channel_history, team_status, pattern_list, pattern_status); CLI reads (`ai-collab task list|show`, `agents`, `sessions`, `history`, `peers`, `team status`, `pattern list`, `status`); run_code; run_read_code; bypass reads (read tools, cat, grep, jq and similar on ~/.local/share/ai-collab/tasks or ~/.local/state/ai-collab, builder state excluded).",
    "- A refusal is a result containing `through run_code` (MCP isError, CLI exit 3). A run_code failure is `ok:false`, a staging error, or an error that is not a refusal. Calls from an agent that runs a CLI read inside a Codex `exec` script are matched by text.",
    "- Roles: subagent = sidechain or child session; pm = a session a schedule named `pm` resumes (`--resume <id>` in schedules.json); builder = cwd in an ai-collab-wt-* worktree, a builder state directory or /sandbox; everything else is interactive. The builder rule also matches an interactive session that works in such a worktree.",
    "- Agent address = harness#sha256(native session id)[0:16]. Subagents carry their parent's address.",
    "- Prices: list prices from docs/research/api-cost-estimate-2026-11-22.md for Claude and Codex models; other models show tokens only. Pay-as-you-go list price, not what the subscription costs.",
    "- Cursor stores tool calls but no token usage and no per-message time, so its turns date from the session's creation and a session that spans a cutover counts wholly before it. A long-lived resumed PM session therefore lands in the period it started.",
    "- Before/after is not a controlled comparison: workload, models and sessions differ between periods, and the after period holds only the hours since the cutover.",
    ...notes.map((x) => `- ${x}`));
  return out.join("\n") + "\n";
}

function spanOf(t: Annotated): { traceId: string; spanId: string; name: string; startMs: number; endMs: number; attrs: Record<string, string | number> } {
  const id = createHash("sha256").update(`${t.agent}|${t.ts}|${t.model}`).digest("hex");
  const attrs: Record<string, string | number> = {
    "openinference.span.kind": "LLM", "llm.model_name": t.model, "session.id": t.agent, "ai_collab.agent": t.agent, "ai_collab.harness": t.harness, "ai_collab.role": t.role,
    "ai_collab.period": t.period, "ai_collab.tool_calls": t.calls.length,
    "ai_collab.read_calls": t.calls.filter((c) => READ_PATHS.includes(c.path as string)).length, "ai_collab.bypass_reads": t.calls.filter((c) => c.path === "bypass_read").length,
    "ai_collab.refused": t.calls.filter((c) => c.refused).length,
  };
  if (t.tok) Object.assign(attrs, { "llm.token_count.prompt": t.tok.input + t.tok.cw5 + t.tok.cw1 + t.tok.cacheRead, "llm.token_count.completion": t.tok.output, "llm.token_count.prompt_details.cache_read": t.tok.cacheRead });
  return { traceId: createHash("sha256").update(t.agent).digest("hex").slice(0, 32), spanId: id.slice(0, 16), name: `${t.harness} turn`, startMs: t.ts, endMs: t.ts + 1, attrs };
}

/** POST turns as OTLP spans in batches; returns the number sent. */
export async function exportOtlp(turns: Annotated[], url: string, { project = "ai-collab-run-code-impact", batch = 500, fetchImpl = fetch }: { project?: string; batch?: number; fetchImpl?: typeof fetch } = {}): Promise<number> {
  let sent = 0;
  for (let i = 0; i < turns.length; i += batch) {
    const body = encodeTraceRequest(turns.slice(i, i + batch).map(spanOf), { project });
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body });
    if (!res.ok) throw new Error(`OTLP export to ${url} failed: HTTP ${res.status}`);
    sent += Math.min(batch, turns.length - i);
  }
  return sent;
}

function parseFlags(args: string[]): Flags {
  const { values: { agent, ...rest } } = parseArgs({ args, options: OPTIONS, strict: true });
  return { ...rest, agents: agent } as Flags;
}

const instant = (value: string, flag: string): number => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${flag} must be an ISO timestamp, got "${value}"`);
  return ms;
};

function pmLabelsOf(file: string): Set<string> {
  const labels = new Set<string>();
  if (!existsSync(file)) return labels;
  try {
    for (const s of JSON.parse(readFileSync(file, "utf8")) as Array<{ name?: string; command?: unknown }>) {
      if (s?.name !== "pm") continue;
      const found = sessionOfCommand(s.command);
      if (found) labels.add(found.session);
    }
  } catch { /* an unreadable schedules file leaves no PM sessions */ }
  return labels;
}

/** Entry point. io: {env, stdout, stderr, journal (journalctl override), sources (replace the defaults)}. */
export async function analyze(args: string[], io: AnalyzeIo = {}): Promise<number> {
  const env = io.env || process.env;
  const out: Writer = io.stdout || process.stdout;
  const err: Writer = io.stderr || process.stderr;
  let o: Flags;
  let selectors: Selector[];
  let cut: Cut;
  let win: { since: number | null; until: number | null };
  try {
    o = parseFlags(args);
    if (o.help) { out.write(`${USAGE}\n`); return 0; }
    selectors = parseSelectors(o.agents);
    const cutover = instant(o.cutover || DEFAULT_CUTOVER, "--cutover");
    const partial = o.partial === "none" ? null : instant(o.partial || DEFAULT_PARTIAL, "--partial");
    cut = { cutover, partial };
    win = { since: o.since ? instant(o.since, "--since") : null, until: o.until ? instant(o.until, "--until") : null };
    new Intl.DateTimeFormat("en-CA", { timeZone: o.tz || DEFAULT_TZ });
  } catch (e) {
    err.write(`ai-collab: ${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const home = env.HOME || homedir();
  const tz = o.tz || DEFAULT_TZ;
  const sources: Source[] = io.sources || [claudeSource({ home }), codexSource({ home }), opencodeSource({ home }), cursorSource({ home }), journalSource({ run: io.journal }), taskStoreSource({ home })];
  const turns: Turn[] = [];
  const scheduleRuns: ScheduleRun[] = [];
  let tasks: TaskItem[] | null = null;
  const notes: string[] = [];
  for (const s of sources) {
    let r: SourceResult;
    try { r = await s.load(win as SourceWindow); } catch (e) { notes.push(`source ${s.name} failed: ${(e as Error).message}`); continue; }
    turns.push(...(r.turns || []));
    scheduleRuns.push(...(r.scheduleRuns || []));
    if (r.tasks) tasks = r.tasks;
    for (const x of r.notes || []) if (!notes.includes(x)) notes.push(x);
  }
  const pmLabels = pmLabelsOf(env.AI_COLLAB_SCHEDULES || join(home, ".config/ai-collab/schedules.json"));
  const ctx: Ctx = { cut, tz, pmLabels, selectors };
  const rows = aggregate(turns, ctx);
  const generated = new Date().toISOString().slice(0, 10);
  const md = renderReport(rows, { ...ctx, ...win, scheduleRuns, tasks, notes, generated, latest: turns.reduce((m, t) => Math.max(m, t.ts), 0) || null, sources: sources.map((s) => s.name) });
  const file = o.out || join("docs/research", `run-code-impact-${generated}.md`);
  if (file === "-") out.write(md);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, md); err.write(`ai-collab: wrote ${file}\n`); }
  if (o.jsonl) { mkdirSync(dirname(o.jsonl), { recursive: true }); writeFileSync(o.jsonl, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")); err.write(`ai-collab: wrote ${o.jsonl} (${rows.length} rows)\n`); }
  if (o["otlp-export"]) {
    try {
      const sent = await exportOtlp(annotate(turns, ctx), o["otlp-export"], { project: o["phoenix-project"] });
      err.write(`ai-collab: exported ${sent} spans to ${o["otlp-export"]}\n`);
    } catch (e) { err.write(`ai-collab: ${(e as Error).message}\n`); return 1; }
  }
  return 0;
}
