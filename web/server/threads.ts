// The UI server's side of threads (docs/threads.md): a cached list per project, sync of new sessions, and POST /api/thread.
import { isAbsolute, sep } from "node:path";
import { listProjects } from "../../lib/config.ts";
import { listOwned, listSessions, type SessionCfg } from "../../lib/sessions/registry.ts";
import { threadClient, type ThreadClientConfig } from "../../lib/thread-routes.ts";
import { THREAD_ID, threadSessionsOf } from "../../lib/threads.ts";

const SYNC_DELAY_MS = 1000;
const OPS = ["list", "get", "create", "rename", "status", "pin", "attach-pr", "detach-pr", "move-session"];
const TITLE_WORDS = 8;

// oxlint-disable-next-line typescript/no-explicit-any -- threads and op inputs are JSON from the bus and the browser
type Json = any;
type ThreadsCfg = SessionCfg & ThreadClientConfig & { root?: string };
type ThreadClient = ReturnType<typeof threadClient>;

function reject(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** A thread title from a first prompt: its first words, at most 80 characters. */
export function promptTitle(prompt: unknown): string {
  return String(prompt || "").replace(/\s+/g, " ").trim().split(" ").slice(0, TITLE_WORDS).join(" ").slice(0, 80);
}

/** Threads of one project: list() is the cached snapshot value; sync() posts unassigned sessions to the bus. */
export function projectThreads(cfg: ThreadsCfg, { env = process.env, broadcast = () => {}, client = threadClient(cfg), delayMs = SYNC_DELAY_MS }: {
  env?: NodeJS.ProcessEnv; broadcast?: () => void; client?: ThreadClient; delayMs?: number;
} = {}) {
  let threads: Json[] = [];
  let available = true;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  const root = (): string => listProjects(env).find(entry => entry.project === cfg.project)?.root || cfg.root || "";

  async function refresh(): Promise<void> {
    try {
      const next = await client.list(cfg.project);
      if (!Array.isArray(next)) return;
      available = true;
      if (JSON.stringify(next) !== JSON.stringify(threads)) {
        threads = next;
        broadcast();
      }
    } catch (error) {
      // 404: the bus runs a store without threads; other errors keep the last list.
      if ((error as { status?: number }).status === 404) available = false;
    }
  }

  async function syncNow(): Promise<void> {
    if (!available) return;
    try {
      // Sessions of a thread without a worktree go too: the sync gives the thread their folder.
      const known = new Set(threads.filter(thread => thread.worktree).flatMap(thread => thread.sessions));
      const sessions = threadSessionsOf({ sessions: listSessions(cfg), owned: listOwned(cfg), root: root() })
        .filter(session => !known.has(session.address));
      if (sessions.length) await client.sync({ project: cfg.project, root: root(), sessions });
    } catch { /* the next registry change retries */ }
    await refresh();
  }

  /** Debounced: hook writes touch the registry on every event, so one sync runs per quiet second. */
  function sync(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      running = (running || Promise.resolve()).then(syncNow, syncNow);
    }, delayMs);
    timer.unref?.();
  }

  async function own(id: unknown): Promise<Json> {
    if (typeof id !== "string" || !THREAD_ID.test(id)) reject(400, "Invalid thread");
    const thread = await client.get(id);
    if (thread.project !== cfg.project) reject(404, "Unknown thread");
    return thread;
  }

  /** The thread a start runs in: its worktree as the start folder, or null for a new thread. */
  async function startIn(id: unknown): Promise<Json> {
    if (id === undefined || id === null || id === "") return null;
    const thread = await own(id);
    const base = root();
    if (!thread.worktree || !isAbsolute(thread.worktree) || (thread.worktree !== base && !thread.worktree.startsWith(base + sep))) {
      reject(409, "The thread's worktree is outside the project");
    }
    return thread;
  }

  /** Attaches a started session to its thread, creating one titled from the prompt when none was named. */
  async function claim(session: unknown, { thread, prompt }: { thread?: Json; prompt?: string } = {}): Promise<Json> {
    if (!available || typeof session !== "string") return null;
    try {
      const target = thread || await client.create({ project: cfg.project, title: promptTitle(prompt) });
      const joined = await client.moveSession(target.id, session);
      await refresh();
      return joined;
    } catch {
      // A start never fails because the thread store is down; the next sync assigns the session.
      return null;
    }
  }

  async function handle(input: Json): Promise<Json> {
    const { op, thread: id } = input;
    if (!OPS.includes(op)) reject(400, "Unknown thread op");
    if (!available) reject(503, "Threads need the postgres bus store");
    let result: Json;
    if (op === "list") result = { threads: await client.list(cfg.project, { archived: input.archived === true }) };
    else if (op === "create") {
      const { title, worktree, branch, baseRef, parentThreadId } = input;
      if (parentThreadId !== undefined && parentThreadId !== null) await own(parentThreadId);
      result = await client.create({ project: cfg.project, title, worktree, branch, baseRef, parentThreadId });
    } else {
      await own(id);
      if (op === "get") result = await client.get(id);
      else if (op === "rename") result = await client.update(id, { title: input.title });
      else if (op === "status") result = await client.update(id, { status: input.status });
      else if (op === "pin") result = await client.update(id, { pinned: input.pinned });
      else if (op === "attach-pr") result = await client.attachPr(id, input.pr || {});
      else if (op === "detach-pr") result = await client.detachPr(id, input.pr);
      else if (op === "move-session") {
        if (!listSessions(cfg).some(session => session.id === input.session) && !listOwned(cfg).some(record => record.address === input.session)) {
          reject(404, "Unknown session");
        }
        result = await client.moveSession(id, input.session);
      }
    }
    await refresh();
    return result;
  }

  return { list: () => threads, refresh, sync, startIn, claim, handle, close: () => clearTimeout(timer) };
}
