/**
 * A build review packet: what a builder submitted, the host check's verdict, and the operator's decision on it.
 * The packet names the submitted commit, so a re-run that moves the branch makes it stale and its decision worthless.
 * Everything here is plain data plus one git read; the store (lib/tasks.mjs) validates and persists it.
 */
import { execFileSync } from "node:child_process";

/** A full Git object name: SHA-1 (40 hex) or SHA-256 (64 hex). */
export const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** A branch name safe to hand to git without a shell or a leading option. */
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
/** Per-file counts in a packet: at most this many, with the rest counted. The full diff is a link, not the packet. */
export const REVIEW_FILES_MAX = 12;
export const REVIEW_PATH_MAX = 200;
// The board asks about every review card on each push; tips are read at most once per this window per checkout.
const TIP_TTL_MS = 2000;
const tipCache = new Map();

/** Every local branch of `root` with its tip commit; {} when the checkout or git is unavailable. */
function branchTips(root, ttlMs) {
  const hit = tipCache.get(root);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  let value = {};
  try {
    const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], {
      cwd: root, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const at = line.lastIndexOf(" ");
      if (at > 0) value[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  } catch { /* an unreadable checkout makes every packet stale */ }
  if (tipCache.size > 32) tipCache.clear();
  tipCache.set(root, { at: Date.now(), value });
  return value;
}

/** Forgets a checkout's cached tips, so a decision straight after a commit is judged against the live branch. */
export function forgetBranchTips(root) {
  tipCache.delete(root);
}

/**
 * Whether the branch in `root` still points at the submitted commit. A missing branch and an unavailable checkout
 * read as stale too: the reviewer would otherwise judge a commit the build no longer is. `ttlMs` lets the board reuse
 * a recent read; a decision passes 0 so it never acts on a cached tip.
 */
export function reviewIsCurrent(root, review, { ttlMs = 0 } = {}) {
  if (!root || typeof review?.branch !== "string" || !BRANCH_NAME.test(review.branch) || typeof review.commit !== "string") return false;
  return branchTips(root, ttlMs)[review.branch] === review.commit;
}

/**
 * The phone-sized change summary of `git diff --numstat` output: totals plus up to REVIEW_FILES_MAX per-file counts.
 * A binary file prints "-" for both counts, so it counts as a changed file with no lines.
 */
export function changeSummary(numstat) {
  const files = [];
  let insertions = 0;
  let deletions = 0;
  let more = 0;
  for (const line of String(numstat ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [plus, minus, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const added = plus === "-" ? 0 : Number(plus) || 0;
    const removed = minus === "-" ? 0 : Number(minus) || 0;
    insertions += added;
    deletions += removed;
    if (files.length < REVIEW_FILES_MAX) files.push({ path: path.slice(0, REVIEW_PATH_MAX), insertions: added, deletions: removed });
    else more += 1;
  }
  return { files, insertions, deletions, more };
}

/** A packet's age in the largest whole unit, for the card line: "12s", "3m", "2h", "1d". */
export function reviewAge(at, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - (Number.isFinite(at) ? at : now)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
