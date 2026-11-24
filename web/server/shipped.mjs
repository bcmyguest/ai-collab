import { execFileSync } from "node:child_process";
import { COMMIT_ID } from "../../lib/build-review.mjs";

const checkouts = new Map();
const options = { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] };

function mainState(root) {
  const now = Date.now();
  const previous = checkouts.get(root);
  if (previous && now - previous.at < 2000) return previous;
  let tip;
  try {
    tip = execFileSync("git", ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { ...options, cwd: root }).trim();
  } catch {}
  const state = { tip, at: now, commits: tip === previous?.tip ? previous?.commits ?? new Map() : new Map() };
  if (checkouts.size >= 32) checkouts.clear();
  checkouts.set(root, state);
  return state;
}

export function shippedTasks(backend, project, root) {
  if (!backend || !root) return [];
  let tasks;
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
        if (error.status === 1) commits.set(commit, false);
      }
    }
    return commits.get(commit) ? [{ project, id: task.id, title: task.title, commit, at: decision?.at ?? at }] : [];
  });
}
