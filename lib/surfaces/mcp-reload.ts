/**
 * Runs MCP tool code in a worker process the stdio front restarts when a deploy replaces the plugin copy, so a running
 * harness session gets new tools through notifications/tools/list_changed instead of keeping the list it started with.
 */
import { fork, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "./render-mcp.ts";
import type { Args } from "./types.ts";

const POLL_MS = 3000;
const START_TIMEOUT_MS = 30_000;

type FromWorker =
  | { type: "tools"; tools: unknown[] }
  | { type: "result"; id: number; text: string; isError?: boolean }
  | { type: "error"; id: number; message: string };
type ToWorker = { type: "call"; id: number; name: string; args: Args } | { type: "cancel"; id: number };

interface Pending { resolve: (result: ToolResult) => void; reject: (error: Error) => void }
interface Worker { child: ChildProcess; tools: unknown[]; pending: Map<number, Pending>; retiring: boolean }

export interface ToolWorkerOptions {
  script: URL;
  args?: string[];
  // A deploy writes a new copy of this file (new inode or mtime); the front then starts a fresh worker.
  watch: URL;
  pollMs?: number;
  onToolsChanged: () => void;
}

/** The front's view of the tool worker: the current list, calls routed to the worker that listed them, and stop(). */
export function toolWorkers({ script, args = [], watch, pollMs = POLL_MS, onToolsChanged }: ToolWorkerOptions) {
  let nextId = 1;
  let current: Promise<Worker> | null = null;
  let seen = fingerprint(watch);
  let swapping = false;

  const ensure = () => (current ??= start(script, args).catch((error) => { current = null; throw error; }));

  const retire = (worker: Worker) => {
    worker.retiring = true;
    if (!worker.pending.size) worker.child.kill();
  };

  const poll = setInterval(async () => {
    const now = fingerprint(watch);
    if (!now || now === seen || swapping) return;
    swapping = true;
    try {
      const fresh = await start(script, args);
      seen = now;
      const old = current ? await current.catch(() => null) : null;
      current = Promise.resolve(fresh);
      if (old) retire(old);
      if (JSON.stringify(old?.tools) !== JSON.stringify(fresh.tools)) onToolsChanged();
    } catch {
      // A copy caught mid-write fails to start; the next tick retries it.
    } finally {
      swapping = false;
    }
  }, pollMs);
  poll.unref();

  return {
    listTools: async () => (await ensure()).tools,
    callTool: async (name: string, callArgs: Args, signal?: AbortSignal): Promise<ToolResult> => {
      const worker = await ensure();
      const id = nextId++;
      return new Promise<ToolResult>((resolve, reject) => {
        const settle = () => {
          worker.pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          if (worker.retiring && !worker.pending.size) worker.child.kill();
        };
        const onAbort = () => send(worker, { type: "cancel", id });
        worker.pending.set(id, {
          resolve: (result) => { settle(); resolve(result); },
          reject: (error) => { settle(); reject(error); },
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        if (!send(worker, { type: "call", id, name, args: callArgs })) worker.pending.get(id)?.reject(new Error("ai-collab tool worker is gone; call the tool again"));
      });
    },
    stop: async () => {
      clearInterval(poll);
      const worker = current ? await current.catch(() => null) : null;
      worker?.child.kill();
    },
  };

  function start(path: URL, argv: string[]): Promise<Worker> {
    // The worker's stdout goes to stderr: the front's stdout carries the MCP protocol.
    const child = fork(fileURLToPath(path), argv, { stdio: ["ignore", 2, 2, "ipc"] });
    const worker: Worker = { child, tools: [], pending: new Map(), retiring: false };
    return new Promise<Worker>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("ai-collab tool worker did not start")); }, START_TIMEOUT_MS);
      child.on("message", (message: FromWorker) => {
        if (message.type === "tools") { clearTimeout(timer); worker.tools = message.tools; resolve(worker); return; }
        const pending = worker.pending.get(message.id);
        if (!pending) return;
        if (message.type === "result") pending.resolve({ text: message.text, ...(message.isError ? { isError: true } : {}) });
        else pending.reject(new Error(message.message));
      });
      child.once("exit", (code, sig) => {
        clearTimeout(timer);
        reject(new Error(`ai-collab tool worker exited (${sig ?? code})`));
        for (const pending of [...worker.pending.values()]) pending.reject(new Error(`ai-collab tool worker exited (${sig ?? code}); call the tool again`));
        if (current && !worker.retiring) void current.then((live) => { if (live === worker) current = null; }, () => {});
      });
    });
  }
}

/** Worker side: announces its tool list to the front, then answers calls until the front goes away. */
export function serveToolWorker({ listTools, callTool }: {
  listTools: () => unknown[];
  callTool: (name: string, args: Args, signal: AbortSignal) => Promise<ToolResult>;
}): void {
  const running = new Map<number, AbortController>();
  process.on("message", async (message: ToWorker) => {
    if (message.type === "cancel") { running.get(message.id)?.abort(); return; }
    const controller = new AbortController();
    running.set(message.id, controller);
    try {
      const { text, isError } = await callTool(message.name, message.args, controller.signal);
      process.send?.({ type: "result", id: message.id, text, isError });
    } catch (error) {
      process.send?.({ type: "error", id: message.id, message: (error as Error).message });
    } finally {
      running.delete(message.id);
    }
  });
  process.once("disconnect", () => process.exit(0));
  process.send?.({ type: "tools", tools: listTools() });
}

function send(worker: Worker, message: ToWorker): boolean {
  if (!worker.child.connected) return false;
  worker.child.send(message);
  return true;
}

function fingerprint(file: URL): string {
  try {
    const { ino, mtimeMs, size } = statSync(file);
    return `${ino}:${mtimeMs}:${size}`;
  } catch {
    return "";
  }
}
