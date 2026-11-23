import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOST_CHECKOUT } from "../../lib/merge-cli.mjs";

const run = promisify(execFile);
const stages = ["pm-merge", "answer-sync"];
const stage = id => stages.findIndex(name => id === name || id.startsWith(name + "-"));
function rank(id) {
  const index = stage(id);
  return index === -1 ? stages.length : index;
}

function authorized(task) {
  const answer = task.question?.answer;
  return task.status === "review" && task.review && !task.review.decision &&
    /^operator(?::.+)?$/.test(answer?.by) && /^merge(?:[ -])when(?:[ -])green$/i.test(answer.text.trim());
}

export async function mergeReview(review, env) {
  const args = [join(HOST_CHECKOUT, "scripts/ai-collab.mjs"), "merge", "start", "--expect-tip", review.commit, review.branch];
  try {
    const { stdout } = await run(process.execPath, args, { env, maxBuffer: 16 * 1024 * 1024 });
    return { landed: true, detail: receipt(stdout) || "Merge verified" };
  } catch (error) {
    return { landed: false, detail: receipt(error.stdout) || "Merge command failed. Check origin/main before retrying." };
  }
}

const receipt = output => output?.trimEnd().split("\n").at(-1)?.match(/^merge: (.+)$/)?.[1];

export async function landReviews(projects, { merge, by, onReceipt = () => {} }) {
  const queue = projects.flatMap(project =>
    project.tasks.list().filter(authorized).map(task => ({ project, task })));
  queue.sort((a, b) => rank(a.task.id) - rank(b.task.id) || a.task.review.at - b.task.review.at);
  const receipts = [];
  let prerequisite;
  for (const { project, task } of queue) {
    const { id, review } = task;
    const result = { project: project.name, id, landed: false };
    try {
      if (prerequisite) throw new Error(`Waiting for ${prerequisite}`);
      const current = project.tasks.get(id);
      if (!authorized(current) || current.review.submission !== review.submission ||
          current.review.commit !== review.commit || current.review.branch !== review.branch) {
        throw new Error("The review or its authorization changed");
      }
      if (review.check.code !== 0 || current.review.check.code !== 0) throw new Error("The submitted check is red");
      if (current.blockers.some(blocker => project.tasks.get(blocker).status !== "done")) {
        throw new Error("The task has unfinished blockers");
      }
      Object.assign(result, await merge(review));
      if (result.landed) {
        await project.tasks.decideReview(id, { ...review, action: "accept", by, landedAnswer: current.question.answer });
      }
    } catch (error) {
      result.detail = result.landed ? `${result.detail}. Task update failed: ${error.message}` : error.message;
      if (result.landed) result.updateFailed = true;
    }
    if (stage(id) !== -1 && (!result.landed || result.updateFailed)) prerequisite ??= id;
    receipts.push(result);
    onReceipt(result);
  }
  return receipts;
}
