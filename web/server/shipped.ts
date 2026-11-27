import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { COMMIT_ID } from "../../lib/build-review.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- task records are JSON
type Json = any;
type MainState = { tip?: string; at: number; commits: Map<string, boolean> };
/** A reviewed task whose commit is on origin/main. */
export type Shipped = { project: string; id: string; title: string; commit: string; at: number };

const checkouts = new Map<string, MainState>();
const options = { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] } satisfies ExecFileSyncOptionsWithStringEncoding;

function mainState(root: string): MainState {
  const now = Date.now();
  const previous = checkouts.get(root);
  if (previous && now - previous.at < 2000) return previous;
  let tip: string | undefined;
  try {
    tip = execFileSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { ...options, cwd: root }).trim();
  } catch {}
  const state = { tip, at: now, commits: tip === previous?.tip ? previous?.commits ?? new Map() : new Map() };
  if (checkouts.size >= 32) checkouts.clear();
  checkouts.set(root, state);
  return state;
}

export function shippedTasks(backend: { list: () => Json[] } | null | undefined, project: string, root: string | undefined): Shipped[] {
  if (!backend || !root) return [];
  let tasks: Json[];
  try { tasks = backend.list(); } catch { return []; }
  const reviewed = tasks.filter(task => COMMIT_ID.test(task.review?.commit));
  if (!reviewed.length) return [];
  const { tip, commits } = mainState(root);
  if (!tip) return [];
  return reviewed.flatMap(task => {
    const { commit, at, decision } = task.review;
    if (!commits.has(commit)) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", commit, tip], { ...options, cwd: root });
        commits.set(commit, true);
      } catch (error) {
        if ((error as { status?: number }).status === 1) commits.set(commit, false);
      }
    }
    return commits.get(commit) ? [{ project, id: task.id, title: task.title, commit, at: decision?.at ?? at }] : [];
  });
}
