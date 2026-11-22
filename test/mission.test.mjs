import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "../lib/cli.mjs";
import { MISSION_FILE, parseMission, readMission, renderMission, withMission } from "../lib/mission.mjs";
import { tickFn } from "../runner/schedules.mjs";
import { projectOfFolder } from "../lib/schedule-session.mjs";

const GOOD = `# Ship the phone loop

Give the operator one place to run and steer agents.

Second paragraph.

## Goals

- [x] Runner-owned sessions
- [ ] PM reads a mission file each tick

## Rules

- Builders run in worktrees.
- Do not edit a test assertion without approval.
`;

function project() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-mission-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo" }]));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, "data"),
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "cursor", AI_COLLAB_STATE_DIR: path.join(home, "state"),
  };
  const out = [];
  const err = [];
  const cli = (...argv) => {
    out.length = 0;
    err.length = 0;
    return runCli(["mission", ...argv], { env, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } })
      .then((code) => ({ code, out: out.join(""), err: err.join("") }));
  };
  return { root, env, file: path.join(root, MISSION_FILE), cli };
}

test("a mission file parses into its title, prose, goals and rules", () => {
  assert.deepEqual(parseMission(GOOD), {
    v: 1,
    title: "Ship the phone loop",
    mission: "Give the operator one place to run and steer agents.\n\nSecond paragraph.",
    goals: [{ text: "Runner-owned sessions", done: true }, { text: "PM reads a mission file each tick", done: false }],
    rules: ["Builders run in worktrees.", "Do not edit a test assertion without approval."],
  });
});

test("rendering a parsed mission gives the same text back", () => {
  assert.equal(renderMission(parseMission(GOOD)), GOOD);
});

test("a blank line inside a paragraph does not break the prose, and CRLF is refused", () => {
  const doc = parseMission("# T\n\nOne.\n\n\nTwo.\n\n## Goals\n\n- [ ] A\n\n## Rules\n\n- R\n");
  assert.equal(doc.mission, "One.\n\nTwo.");
  assert.throws(() => parseMission(GOOD.replace(/\n/g, "\r\n")), /use LF line endings/);
});

test("a file with no title, no sections, an unknown heading or a bad goal names the problem", () => {
  assert.throws(() => parseMission(""), /the file is empty/);
  assert.throws(() => parseMission("# T\n\nprose only\n"), /add a "## Goals" section/);
  assert.throws(() => parseMission("# T\n\np\n\n## Goals\n\n- [ ] A\n"), /add a "## Rules" section/);
  assert.throws(() => parseMission("# T\n\np\n\n## Notes\n\nx\n\n## Goals\n\n- [ ] A\n\n## Rules\n\n- R\n"), /line 5: unknown section "## Notes"/);
  assert.throws(() => parseMission("# T\n\np\n\n## Goals\n\n- A\n\n## Rules\n\n- R\n"), /line 7: a goal is "- \[ \] text"/);
  assert.throws(() => parseMission("# T\n\np\n\n## Rules\n\n- R\n\n## Goals\n\n- [ ] A\n"), /"## Goals" comes before "## Rules"/);
  assert.throws(() => parseMission(`# T\n\np\n\n## Goals\n\n- [ ] ${"x".repeat(400)}\n\n## Rules\n\n- R\n`), /a goal is over 300 characters/);
  assert.throws(() => parseMission("# T\n\np\u0007q\n\n## Goals\n\n- [ ] A\n\n## Rules\n\n- R\n"), /control character/);
});

test("an empty goals or rules section is valid, so a new file can be built up", () => {
  const doc = parseMission("# T\n\np\n\n## Goals\n\n## Rules\n\n- R\n");
  assert.deepEqual([doc.goals, doc.rules], [[], ["R"]]);
});

test("readMission returns null for a missing file and names the path for an invalid one", () => {
  const { file } = project();
  assert.equal(readMission(file), null);
  writeFileSync(file, "# T\n\np\n");
  assert.throws(() => readMission(file), new RegExp(`${MISSION_FILE}: .*add a "## Goals" section`));
});

test("the mission CLI shows, checks, adds and completes goals and rules", async () => {
  const { file, cli } = project();
  writeFileSync(file, GOOD);
  assert.equal(JSON.parse((await cli("show")).out).title, "Ship the phone loop");
  assert.equal((await cli("check")).out, `${file}: ok (2 goals, 2 rules)\n`);

  await cli("add-goal", "Hand", "off", "a", "task");
  assert.match(readFileSync(file, "utf8"), /- \[ \] Hand off a task\n/);
  await cli("done-goal", "3");
  assert.match(readFileSync(file, "utf8"), /- \[x\] Hand off a task\n/);
  await cli("open-goal", "3");
  assert.match(readFileSync(file, "utf8"), /- \[ \] Hand off a task\n/);
  await cli("add-rule", "Commit the mission with the change.");
  assert.match(readFileSync(file, "utf8"), /- Commit the mission with the change\.\n/);
  await cli("remove-goal", "3");
  await cli("remove-rule", "3");
  assert.equal(readFileSync(file, "utf8"), GOOD, "adding and removing the same line leaves the file as it was");
});

test("the mission CLI rejects a bad index, a bad subcommand and a missing file", async () => {
  const { file, cli } = project();
  const missing = await cli("add-goal", "x");
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no mission file/);
  assert.equal((await cli("show")).out.startsWith("no MISSION.md at "), true);
  writeFileSync(file, GOOD);
  const before = readFileSync(file, "utf8");
  for (const argv of [["done-goal", "0"], ["done-goal", "9"], ["remove-rule", "x"], ["done-goal"], ["add-goal", "   "]]) {
    const result = await cli(...argv);
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.err, /^ai-collab: (usage: )?mission /);
  }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal((await cli("bogus")).code, 1);
});

test("withMission appends the file to a harness prompt and leaves a plain script alone", () => {
  const { root, env } = project();
  writeFileSync(path.join(root, MISSION_FILE), GOOD);
  const projects = [{ root, project: "demo" }];
  const harness = withMission(["cursor-agent", "-p", "--resume", "abc", "PM tick"], { project: "demo", env });
  assert.deepEqual(harness.slice(0, 4), ["cursor-agent", "-p", "--resume", "abc"]);
  assert.match(harness.at(-1), /^PM tick\n\nMission file MISSION\.md/);
  assert.ok(harness.at(-1).endsWith(GOOD));
  assert.deepEqual(withMission(["node", "pm.mjs"], { project: "demo", env }), ["node", "pm.mjs"]);
  assert.deepEqual(withMission(["/usr/bin/npx", "cursor-agent"], { project: "demo", env }), ["/usr/bin/npx", "cursor-agent"]);
  assert.equal(projectOfFolder(root, projects), "demo");
  assert.deepEqual(withMission(["cursor-agent", "-p", "tick"], { project: "", env }), ["cursor-agent", "-p", "tick"]);
});

test("withMission runs without the file when it is missing or invalid, and says why", () => {
  const { root, env } = project();
  const logs = [];
  const log = (line) => logs.push(line);
  const command = ["cursor-agent", "-p", "tick"];
  assert.deepEqual(withMission(command, { project: "demo", env, log }), command);
  assert.match(logs[0], /no MISSION\.md for project demo/);
  writeFileSync(path.join(root, MISSION_FILE), "# T\n\np\n");
  assert.deepEqual(withMission(command, { project: "demo", env, log }), command);
  assert.match(logs[1], /add a "## Goals" section/);
});

test("a tick reads the mission at run time, so an edit reaches the next tick", async () => {
  const { root, env } = project();
  writeFileSync(path.join(root, MISSION_FILE), GOOD);
  const projects = [{ root, project: "demo" }];
  // A stand-in harness: argv[0] is named cursor-agent, so the tick treats the last argument as its prompt.
  const bin = path.join(root, "cursor-agent");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const entry = { name: "pm", everyMs: 60_000, cwd: root, command: [bin, "-p", "PM tick"], timeoutMs: 10_000 };

  // A workflow stub: the tick's one step runs the command and returns its result.
  const run = async () => {
    const wf = { step: async (_name, fn) => fn(), signal: undefined };
    const { tail } = await tickFn({ ...entry }, { env, projects, log: () => {} })(new Date(0), new Date(0), wf);
    return JSON.parse(tail)[1];
  };
  assert.match(await run(), /PM reads a mission file each tick/);
  assert.ok((await run()).endsWith(GOOD));

  writeFileSync(path.join(root, MISSION_FILE), GOOD.replace("PM reads a mission file each tick", "PM reads the newest mission"));
  assert.match(await run(), /PM reads the newest mission/);
});
