import { execRun, requestLand, HOST_CHECKOUT } from "../../lib/land.ts";

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

// Opens the review branch's PR into main; never pushes main.
export async function mergeReview(review, env, { run = execRun, cwd = HOST_CHECKOUT } = {}) {
  try {
    const tip = await run("git", ["rev-parse", "--verify", `refs/heads/${review.branch}^{commit}`], { cwd, encoding: "utf8" });
    if (tip.status !== 0 || tip.stdout.trim() !== review.commit) {
      return { landed: false, detail: "the build branch moved past the submitted commit" };
    }
    const { url } = await requestLand(review.branch, { run, cwd });
    return { landed: false, opened: true, detail: `PR ${url}` };
  } catch (error) {
    return { landed: false, detail: error.message };
  }
}

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
    if (stage(id) !== -1 && ((!result.landed && !result.opened) || result.updateFailed)) prerequisite ??= id;
    receipts.push(result);
    onReceipt(result);
  }
  return receipts;
}
