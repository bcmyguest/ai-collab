// `land finish` for a pattern member in an OpenShell sandbox: it asks with a LAND_FINISH reply line, the runner finishes its run branch on the host.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { execRun, finishBranch, LandRefused } from "./land.mjs";
import { sessionsOfRun } from "./pattern-runs.mjs";
import { passJs } from "./surfaces/types.ts";
import type { openTasks } from "./tasks.mjs";

export const LAND_FINISH_PREFIX = "LAND_FINISH ";
const PROOF_MAX = 3000;
const PROTECTED = new Set(["main", "master"]);

type Run = typeof execRun;
type Tasks = ReturnType<typeof openTasks>;
export type LandFinishRequest = { proof: string } | { error: string };
export interface MemberRecord { address: string; place?: string; cwd?: string; patternRun?: string }
export interface MemberRun { id: string; status?: string; definition?: { landing?: string } }

const realpath = (path: string) => { try { return realpathSync(path); } catch { return ""; } };

/** The LAND_FINISH request in one of a reply's last two lines (PATTERN_ADVANCE may follow it), or undefined when there is none. */
export function landFinishRequest(reply: string | undefined): LandFinishRequest | undefined {
  const line = (reply ?? "").trimEnd().split("\n").slice(-2).find((l) => l.startsWith(LAND_FINISH_PREFIX));
  if (!line) return undefined;
  try {
    const { proof } = JSON.parse(line.slice(LAND_FINISH_PREFIX.length)) ?? {};
    if (proof === undefined || typeof proof === "string") return { proof: (proof ?? "").trim().slice(0, PROOF_MAX) };
  } catch { /* malformed JSON */ }
  return { error: 'LAND_FINISH takes JSON: {"proof":"<commands run and their output>"}' };
}

/**
 * Finishes a sandboxed member's run branch on the host. The branch, worktree and landing policy come from the host's
 * records, never from the member: the session must be a member of the running run, run in OpenShell, own the run's
 * worktree, and that worktree must be on team/<run>. syncBack copies the sandbox commits to the worktree first.
 */
export async function finishMemberBranch({ record, run, root, proof, syncBack, tasks, finish = finishBranch, exec = execRun }: {
  record: MemberRecord; run: MemberRun | null; root: string; proof: string; syncBack: () => Promise<void>; tasks: Tasks;
  finish?: typeof finishBranch; exec?: Run;
}) {
  if (record.place !== "openshell") throw new LandRefused("only a sandboxed member finishes through the runner; run ai-collab land finish");
  if (!run || run.id !== record.patternRun) throw new LandRefused("the session is not in this pattern run");
  if (run.status !== "running") throw new LandRefused(`run ${run.id} is ${run.status}`);
  if (!sessionsOfRun(run).includes(record.address)) throw new LandRefused(`${record.address} is not a member of run ${run.id}`);
  const worktree = join(root, ".claude", "worktrees", `team-${run.id}`);
  if (!record.cwd || !realpath(worktree) || realpath(record.cwd) !== realpath(worktree)) throw new LandRefused("the session does not own its run's worktree");
  const branch = `team/${run.id}`;
  const head = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktree, encoding: "utf8" });
  const current = head.status === 0 ? head.stdout.trim() : "";
  if (PROTECTED.has(current) || current !== branch) throw new LandRefused(`the run worktree is on ${current || "no branch"}, not ${branch}`);
  const landing = run.definition?.landing;
  if (!proof && landing !== "branch") throw new LandRefused("LAND_FINISH needs a proof unless the team's landing is branch");
  await syncBack();
  return finish(branch, passJs({ ...(landing ? { landing } : {}), proof, cwd: worktree, tasks, by: record.address }));
}

/** One line for the operator: the PR, the packet's task, or the pushed branch. */
export function describeFinish(result: { landing: string; url?: string; created?: boolean; task?: string; branch?: string }): string {
  if (result.landing === "pr") return `pr: ${result.url}${result.created ? "" : " (existing)"}`;
  if (result.landing === "packet") return `packet: task ${result.task}`;
  return `branch: pushed ${result.branch}`;
}
