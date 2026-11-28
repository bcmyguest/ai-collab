/**
 * One thread, one branch: a spawned child's worktree branch is cut from its parent's branch, and each successful run
 * rebases the child's commits onto that branch and fast-forwards it. docs/threads.md "One branch per thread".
 */
import { existsSync } from "node:fs";
import { parseWorktreeList, type GitRun } from "./sessions/git-refs.ts";

// Branches a child never merges into: the operator lands those.
const PROTECTED = new Set(["main", "master", "HEAD"]);
const CONFLICTS_SHOWN = 8;

/** The branch checked out in cwd when a child may merge into it, else null (detached, main, not a repo). */
export async function parentBranch(run: GitRun, cwd: string): Promise<string | null> {
  const head = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const name = head.stdout.trim();
  return head.code === 0 && name && !PROTECTED.has(name) ? name : null;
}

/** Rebases the branch checked out in childCwd onto `into` and fast-forwards `into`; returns the line for the parent's report, "" when there is nothing to merge. */
export async function mergeIntoParent(run: GitRun, childCwd: string, into: string): Promise<string> {
  if (PROTECTED.has(into)) return `not merged: ${into} is landed by the operator`;
  // A restart can cut an earlier merge mid-rebase; start from the branch as it was.
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = (await run(["rev-parse", "--path-format=absolute", "--git-path", dir], childCwd)).stdout.trim();
    if (path && existsSync(path)) await run(["rebase", "--abort"], childCwd);
  }
  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"], childCwd)).stdout.trim();
  if (!branch || branch === "HEAD" || branch === into) return "";
  if ((await run(["rev-parse", "--verify", "--quiet", `refs/heads/${into}`], childCwd)).code !== 0) return `not merged: branch ${into} no longer exists`;
  const ahead = Number((await run(["rev-list", "--count", `${into}..HEAD`], childCwd)).stdout.trim()) || 0;
  if (!ahead) return "";
  if ((await run(["status", "--porcelain", "--untracked-files=no"], childCwd)).stdout.trim()) return `not merged into ${into}: ${branch} has uncommitted changes; commit them`;
  if ((await run(["rebase", "--quiet", into], childCwd)).code !== 0) {
    const files = (await run(["diff", "--name-only", "--diff-filter=U"], childCwd)).stdout.trim().split("\n").filter(Boolean);
    await run(["rebase", "--abort"], childCwd);
    const shown = files.slice(0, CONFLICTS_SHOWN).join(", ") + (files.length > CONFLICTS_SHOWN ? `, +${files.length - CONFLICTS_SHOWN} more` : "");
    return `not merged into ${into}: ${branch} conflicts with it${shown ? ` in ${shown}` : ""}; both branches are unchanged`;
  }
  const holder = await checkoutOf(run, childCwd, into);
  if (holder) {
    // Git refuses a fast-forward that would overwrite the holder's uncommitted edits, so they are never lost.
    if ((await run(["merge", "--ff-only", "--quiet", branch], holder)).code !== 0) return `not merged into ${into}: its checkout at ${holder} refused the fast-forward (uncommitted edits in the same files?); ${branch} is rebased onto it`;
  } else {
    const head = (await run(["rev-parse", "HEAD"], childCwd)).stdout.trim();
    if ((await run(["branch", "-f", into, head], childCwd)).code !== 0) return `not merged into ${into}: git branch -f failed`;
  }
  return `merged ${ahead} commit${ahead === 1 ? "" : "s"} from ${branch} into ${into}`;
}

// The worktree that has `branch` checked out, or null.
async function checkoutOf(run: GitRun, cwd: string, branch: string): Promise<string | null> {
  const rows = parseWorktreeList((await run(["worktree", "list", "--porcelain"], cwd)).stdout);
  return rows.find((row) => row.branch === `refs/heads/${branch}`)?.path ?? null;
}
