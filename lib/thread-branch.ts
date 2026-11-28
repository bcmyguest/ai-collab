/**
 * One thread, one branch: a spawned child's worktree branch is cut from its parent's branch, and each successful run
 * rebases the child's commits onto that branch and fast-forwards it. docs/threads.md "One branch per thread".
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Rebases the branch checked out in childCwd onto `into` and fast-forwards `into`; returns the line for the parent's report, "" when there is nothing to merge.
 * keepBranch rebases a detached copy instead, so the child's branch keeps the commits its sandbox clone has; the rebase drops ones `into` already has.
 */
export async function mergeIntoParent(run: GitRun, childCwd: string, into: string, { keepBranch = false } = {}): Promise<string> {
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
  if (!keepBranch) return rebaseAndAdvance(run, childCwd, childCwd, branch, into, `${branch} is rebased onto it`);
  const scratch = mkdtempSync(join(tmpdir(), "ai-collab-thread-merge-"));
  const copy = join(scratch, "copy");
  try {
    if ((await run(["worktree", "add", "--quiet", "--detach", copy, "HEAD"], childCwd)).code !== 0) return `not merged into ${into}: git worktree add failed`;
    return await rebaseAndAdvance(run, childCwd, copy, branch, into, `${branch} is unchanged`);
  } finally {
    await run(["worktree", "remove", "--force", copy], childCwd);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Rebases the checkout in `work` onto `into` and fast-forwards `into` to it; `kept` ends the line when the fast-forward is refused.
async function rebaseAndAdvance(run: GitRun, childCwd: string, work: string, branch: string, into: string, kept: string): Promise<string> {
  if ((await run(["rebase", "--quiet", into], work)).code !== 0) {
    const files = (await run(["diff", "--name-only", "--diff-filter=U"], work)).stdout.trim().split("\n").filter(Boolean);
    await run(["rebase", "--abort"], work);
    const shown = files.slice(0, CONFLICTS_SHOWN).join(", ") + (files.length > CONFLICTS_SHOWN ? `, +${files.length - CONFLICTS_SHOWN} more` : "");
    return `not merged into ${into}: ${branch} conflicts with it${shown ? ` in ${shown}` : ""}; both branches are unchanged`;
  }
  // Counted after the rebase, which drops commits an earlier merge of a kept branch already put on `into`.
  const ahead = Number((await run(["rev-list", "--count", `${into}..HEAD`], work)).stdout.trim()) || 0;
  if (!ahead) return "";
  const head = (await run(["rev-parse", "HEAD"], work)).stdout.trim();
  const holder = await checkoutOf(run, childCwd, into);
  if (holder) {
    // Git refuses a fast-forward that would overwrite the holder's uncommitted edits, so they are never lost.
    if ((await run(["merge", "--ff-only", "--quiet", head], holder)).code !== 0) return `not merged into ${into}: its checkout at ${holder} refused the fast-forward (uncommitted edits in the same files?); ${kept}`;
  } else if ((await run(["branch", "-f", into, head], childCwd)).code !== 0) return `not merged into ${into}: git branch -f failed`;
  return `merged ${ahead} commit${ahead === 1 ? "" : "s"} from ${branch} into ${into}`;
}

// The worktree that has `branch` checked out, or null.
async function checkoutOf(run: GitRun, cwd: string, branch: string): Promise<string | null> {
  const rows = parseWorktreeList((await run(["worktree", "list", "--porcelain"], cwd)).stdout);
  return rows.find((row) => row.branch === `refs/heads/${branch}`)?.path ?? null;
}
