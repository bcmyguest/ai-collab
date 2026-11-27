import { execRun, requestLand, HOST_CHECKOUT, type LandRun } from "../../lib/land.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- tasks and review packets come from the task store as JSON
type Json = any;
/** What merging one review did. */
export type MergeResult = { landed: boolean; opened?: boolean; detail?: string };
/** One task's land outcome, as the UI lists it. */
export type Receipt = MergeResult & { project: string; id: string; updateFailed?: boolean };
type ReviewProject = { name: string; tasks: Json };

const stages = ["pm-merge", "answer-sync"];
const stage = (id: string): number => stages.findIndex(name => id === name || id.startsWith(name + "-"));
function rank(id: string): number {
  const index = stage(id);
  return index === -1 ? stages.length : index;
}

function authorized(task: Json): boolean {
  const answer = task.question?.answer;
  return task.status === "review" && task.review && !task.review.decision &&
    /^operator(?::.+)?$/.test(answer?.by) && /^merge(?:[ -])when(?:[ -])green$/i.test(answer.text.trim());
}

// Opens the review branch's PR into main; never pushes main.
export async function mergeReview(review: Json, env: unknown, { run = execRun, cwd = HOST_CHECKOUT }: { run?: LandRun; cwd?: string } = {}): Promise<MergeResult> {
  try {
    const tip = await run("git", ["rev-parse", "--verify", `refs/heads/${review.branch}^{commit}`], { cwd, encoding: "utf8" });
    if (tip.status !== 0 || tip.stdout.trim() !== review.commit) {
      return { landed: false, detail: "the build branch moved past the submitted commit" };
    }
    const { url } = await requestLand(review.branch, { run, cwd });
    return { landed: false, opened: true, detail: `PR ${url}` };
  } catch (error) {
    return { landed: false, detail: (error as Error).message };
  }
}

export async function landReviews(projects: ReviewProject[], { merge, by, onReceipt = () => {} }: {
  merge: (review: Json) => Promise<MergeResult>; by: string; onReceipt?: (receipt: Receipt) => void;
}): Promise<Receipt[]> {
  const queue = projects.flatMap(project =>
    project.tasks.list().filter(authorized).map((task: Json) => ({ project, task })));
  queue.sort((a, b) => rank(a.task.id) - rank(b.task.id) || a.task.review.at - b.task.review.at);
  const receipts: Receipt[] = [];
  let prerequisite: string | undefined;
  for (const { project, task } of queue) {
    const { id, review } = task;
    const result: Receipt = { project: project.name, id, landed: false };
    try {
      if (prerequisite) throw new Error(`Waiting for ${prerequisite}`);
      const current = project.tasks.get(id);
      if (!authorized(current) || current.review.submission !== review.submission ||
          current.review.commit !== review.commit || current.review.branch !== review.branch) {
        throw new Error("The review or its authorization changed");
      }
      if (review.check.code !== 0 || current.review.check.code !== 0) throw new Error("The submitted check is red");
      if (current.blockers.some((blocker: string) => project.tasks.get(blocker).status !== "done")) {
        throw new Error("The task has unfinished blockers");
      }
      Object.assign(result, await merge(review));
      if (result.landed) {
        await project.tasks.decideReview(id, { ...review, action: "accept", by, landedAnswer: current.question.answer });
      }
    } catch (error) {
      result.detail = result.landed ? `${result.detail}. Task update failed: ${(error as Error).message}` : (error as Error).message;
      if (result.landed) result.updateFailed = true;
    }
    if (stage(id) !== -1 && ((!result.landed && !result.opened) || result.updateFailed)) prerequisite ??= id;
    receipts.push(result);
    onReceipt(result);
  }
  return receipts;
}
