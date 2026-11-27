import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RULES_MAX } from "../lib/mission.mjs";
import { REVIEW_HEADING, REVIEW_MAX_LINES, reviewBlock, withReview } from "../lib/pm-review.ts";
import { tickFn } from "../runner/schedules.mjs";

function project() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-review-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  // A registered project, so withMission resolves MISSION.md the way the runner does.
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"), AI_COLLAB_STATE_DIR: path.join(home, "state") };
  return { root, env };
}

test("the review asks for a short review, openmem lessons and a mission rule", () => {
  const block = reviewBlock({ project: "ai-collab" });
  assert.ok(block.startsWith(`${REVIEW_HEADING}:`));
  assert.match(block, new RegExp(`at most ${REVIEW_MAX_LINES} lines`));
  assert.match(block, /memory_add, bank "coding-agent::ai-collab"/);
  assert.match(block, /ai-collab mission add-rule/);
  assert.match(block, new RegExp(`At ${RULES_MAX} rules`));
  // Without a project the bank is not guessed.
  assert.equal(/bank "/.test(reviewBlock()), false);
});

test("withReview appends to a harness prompt and leaves a plain script alone", () => {
  const harness = withReview(["cursor-agent", "-p", "--resume", "abc", "PM tick"], { project: "demo" });
  assert.deepEqual(harness.slice(0, 4), ["cursor-agent", "-p", "--resume", "abc"]);
  assert.match(harness.at(-1), /^PM tick\n\nRun review, before you finish:/);
  assert.ok(harness.at(-1).endsWith(reviewBlock({ project: "demo" })));
  for (const command of [["node", "pm.mjs"], ["/usr/bin/npx", "cursor-agent"], ["true"], []]) {
    assert.deepEqual(withReview(command, { project: "demo" }), command, JSON.stringify(command));
  }
  // A command whose last argument is the prompt flag takes the block as its prompt, and the input argv is not mutated.
  const empty = ["claude", "-p"];
  assert.deepEqual(withReview(empty, {}), ["claude", `-p\n\n${reviewBlock()}`]);
  assert.deepEqual(empty, ["claude", "-p"]);
});

test("a tick's prompt ends with the mission, then the review", async () => {
  const { root, env } = project();
  const mission = "# T\n\np\n\n## Goals\n\n- [ ] A\n\n## Rules\n\n- R\n";
  writeFileSync(path.join(root, "MISSION.md"), mission);
  // A stand-in harness: argv[0] is named cursor-agent, so the tick treats the last argument as its prompt.
  const bin = path.join(root, "cursor-agent");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const entry = { name: "pm", everyMs: 60_000, cwd: root, command: [bin, "-p", "PM tick"], timeoutMs: 10_000 };
  const wf = { step: async (_name, fn) => fn(), signal: undefined };
  const tick = async () => JSON.parse((await tickFn(entry, { env, projects: [{ root, project: "demo" }], log: () => {} })(new Date(0), new Date(0), wf)).tail)[1];
  const prompt = await tick();
  assert.match(prompt, /^PM tick\n\nMission file MISSION\.md/);
  assert.ok(prompt.endsWith(reviewBlock({ project: "demo" })), "the review is the closing instruction");
  assert.match(prompt, /Review project outcomes with ai-collab task outcomes/);
  assert.ok(prompt.indexOf("Mission file MISSION.md") < prompt.indexOf(REVIEW_HEADING), "the review follows the mission");
  // A project with no mission file still gets the outcome instructions and the closing review.
  rmSync(path.join(root, "MISSION.md"));
  const withoutMission = await tick();
  assert.match(withoutMission, /^PM tick\nReview project outcomes/);
  assert.ok(withoutMission.endsWith(reviewBlock({ project: "demo" })));
});

test("a plain script's tick is untouched by the review", async () => {
  const { root, env } = project();
  const entry = { name: "cleanup", everyMs: 60_000, cwd: root, command: [process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "as-is"], timeoutMs: 10_000 };
  const wf = { step: async (_name, fn) => fn(), signal: undefined };
  const { tail } = await tickFn(entry, { env, projects: [{ root, project: "demo" }], log: () => {} })(new Date(0), new Date(0), wf);
  assert.deepEqual(JSON.parse(tail), ["as-is"]);
});
