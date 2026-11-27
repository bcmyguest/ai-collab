/**
 * Compact a Codex thread over the app-server protocol (newline-delimited JSON-RPC on stdio; protocol from
 * `codex app-server generate-json-schema`). codexCompact starts its own `codex app-server` for a saved thread;
 * codexLiveCompact joins the local app-server daemon (`codex app-server proxy`) that a running Codex TUI uses.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const TIMEOUT_MS = 5 * 60_000;
export const CLIENT = { name: "ai-collab", title: null, version: "0.3.0" };

// oxlint-disable-next-line typescript/no-explicit-any -- JSON-RPC messages and results are app-server JSON
type Json = any;
export type AppServerCommand = [string, string[]];
type SpawnScope = { cwd?: string; env?: NodeJS.ProcessEnv };
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };
/** One JSON-RPC connection to an app-server child. */
export type Rpc = {
  ended: Promise<never>;
  send: (message: Json) => boolean;
  request: (method: string, params: Json) => Promise<Json>;
  onNotify: (fn: (message: Json) => void) => Set<(message: Json) => void>;
  close: () => boolean;
};
export type CompactCounts = { before: number | null; after: number | null };
type CompactOptions = SpawnScope & { command?: AppServerCommand; timeoutMs?: number };
export type LiveCompactResult = { status: "not-loaded" | "busy" } | ({ status: "compacted" } & CompactCounts);

// One JSON-RPC connection to an app-server child; onNotify(fn) sees every notification.
export function connect(command: AppServerCommand, { cwd, env }: SpawnScope): Rpc {
  const [file, args] = command;
  const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "ignore"], shell: false });
  const waiting = new Map<number, Pending>();
  const listeners = new Set<(message: Json) => void>();
  let nextId = 0;
  let closed!: (error: Error) => void;
  const ended = new Promise<never>((resolve, reject) => { closed = reject; });
  ended.catch(() => {});
  const send = (message: Json) => child.stdin.write(JSON.stringify(message) + "\n");
  createInterface({ input: child.stdout }).on("line", (line) => {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id) as Pending;
      waiting.delete(m.id);
      if (m.error) reject(new Error(m.error.message || "app-server error"));
      else resolve(m.result);
      return;
    }
    for (const fn of listeners) fn(m);
  });
  const fail = (error: Error) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
    closed(error);
  };
  child.stdin.on("error", () => {});
  child.once("error", fail);
  child.once("close", () => fail(new Error("app-server exited")));
  return {
    ended,
    send,
    request: (method, params) => new Promise<Json>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      send({ id, method, params });
    }),
    onNotify: (fn) => listeners.add(fn),
    close: () => child.kill(),
  };
}

// Resolves {before, after} when the thread's compaction turn completes; rejects on an error or a turn without one.
function watchCompaction(rpc: Rpc, threadId: string, timeoutMs: number): Promise<CompactCounts> {
  let before: number | null = null;
  let after: number | null = null;
  let compacted = false;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<CompactCounts>((resolve, reject) => {
    rpc.onNotify((m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === "thread/tokenUsage/updated") {
        const tokens = m.params.tokenUsage?.last?.totalTokens;
        if (Number.isSafeInteger(tokens)) { if (before === null) before = tokens; else after = tokens; }
      }
      if (m.method === "thread/compacted" || (m.method === "item/completed" && m.params.item?.type === "contextCompaction")) compacted = true;
      if (m.method === "turn/completed") compacted ? resolve({ before, after }) : reject(new Error("turn ended without compaction"));
      if (m.method === "error") reject(new Error("app-server reported an error"));
    });
    rpc.ended.catch(reject);
    timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
  });
  const settled = done.finally(() => clearTimeout(timer));
  settled.catch(() => {}); // awaited only after the requests succeed
  return settled;
}

export function codexCompact(threadId: string, { cwd, env, command = ["codex", ["app-server"]], timeoutMs = TIMEOUT_MS }: CompactOptions = {}): Promise<{ compacted: true } & CompactCounts> {
  const rpc = connect(command, { cwd, env });
  const done = watchCompaction(rpc, threadId, timeoutMs);
  return (async () => {
    try {
      await rpc.request("initialize", { clientInfo: CLIENT, capabilities: null });
      rpc.send({ method: "initialized" });
      await rpc.request("thread/resume", { threadId, cwd });
      await rpc.request("thread/compact/start", { threadId });
      return { compacted: true, ...(await done) };
    } finally {
      rpc.close();
    }
  })();
}

/**
 * Compacts a thread that is loaded in the running app-server daemon, only while it is idle.
 * Resolves {status:"compacted", before, after}, {status:"not-loaded"} (the session runs its own app-server, or none),
 * or {status:"busy"} (a turn is running). thread/resume with only the thread id rejoins a running thread unchanged.
 */
export async function codexLiveCompact(threadId: string, { cwd, env, command = ["codex", ["app-server", "proxy"]], timeoutMs = TIMEOUT_MS }: CompactOptions = {}): Promise<LiveCompactResult> {
  const rpc = connect(command, { cwd, env });
  const done = watchCompaction(rpc, threadId, timeoutMs);
  try {
    await rpc.request("initialize", { clientInfo: CLIENT, capabilities: null });
    rpc.send({ method: "initialized" });
    const loaded: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page: Json = await rpc.request("thread/loaded/list", cursor ? { cursor } : {});
      loaded.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = typeof page?.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor && !loaded.includes(threadId));
    if (!loaded.includes(threadId)) return { status: "not-loaded" };
    const read: Json = await rpc.request("thread/read", { threadId, includeTurns: false });
    if (read?.thread?.status?.type !== "idle") return { status: "busy" };
    await rpc.request("thread/resume", { threadId });
    await rpc.request("thread/compact/start", { threadId });
    return { status: "compacted", ...(await done) };
  } finally {
    rpc.close();
  }
}
