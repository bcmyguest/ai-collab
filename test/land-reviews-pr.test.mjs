import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeReview } from "../web/server/land-reviews.mjs";

const TIP = "e".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
const REVIEW = { branch: "builder/widget", commit: TIP };

function fakeRun(tip = TIP) {
  const calls = [];
  const run = async (file, argv) => {
    calls.push({ file, argv });
    if (argv[0] === "rev-parse") return ok(`${tip}\n`);
    if (file === "gh" && argv[1] === "list") return ok("[]");
    if (file === "gh" && argv[1] === "create") return ok("https://github.com/o/r/pull/21\n");
    return ok();
  };
  run.calls = calls;
  return run;
}

test("a green review opens the branch's PR into main and never pushes main", async () => {
  const run = fakeRun();
  const result = await mergeReview(REVIEW, {}, { run, cwd: "/host" });
  assert.deepEqual(result, { landed: false, opened: true, detail: "PR https://github.com/o/r/pull/21" });
  const pushes = run.calls.filter((c) => c.argv[0] === "push").map((c) => c.argv);
  assert.deepEqual(pushes, [["push", "origin", "refs/heads/builder/widget:refs/heads/builder/widget"]]);
  assert.equal(run.calls.some((c) => c.argv.some((arg) => /refs\/heads\/main$/.test(arg))), false);
});

test("a review whose branch moved past the submitted commit opens nothing", async () => {
  const run = fakeRun("f".repeat(40));
  const result = await mergeReview(REVIEW, {}, { run, cwd: "/host" });
  assert.equal(result.landed, false);
  assert.equal(result.opened, undefined);
  assert.match(result.detail, /moved past the submitted commit/);
  assert.equal(run.calls.some((c) => c.argv[0] === "push" || c.file === "gh"), false);
});
