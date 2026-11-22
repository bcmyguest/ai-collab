import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionOfCommand, projectOfFolder } from "../lib/schedule-session.mjs";
import { sessionLabel } from "../lib/config.mjs";
import { runLink, runLabel, runWindow, RUN_WINDOW_SLACK_MS } from "../web/lib/scheduled.js";
import { parseSelection } from "../web/lib/selection.js";

const CONVERSATION = "36329f36-ceda-4ac6-ae5f-4b36e16c8e95";
const LABEL = sessionLabel(CONVERSATION);

test("a Cursor schedule that resumes a conversation names that session", () => {
  const command = ["/home/b/.local/bin/cursor-agent", "-p", "--force", "--resume", CONVERSATION, "PM tick"];
  assert.deepEqual(sessionOfCommand(command), { harness: "cursor", session: LABEL });
  // The binary is found by its name, wherever it is installed.
  assert.deepEqual(sessionOfCommand(["agent", "-p", `--resume=${CONVERSATION}`]), { harness: "cursor", session: LABEL });
});

test("Claude, Codex and OpenCode resume flags name their session too", () => {
  assert.deepEqual(sessionOfCommand(["claude", "-p", "--resume", "abc-123"]), { harness: "claude", session: sessionLabel("abc-123") });
  assert.deepEqual(sessionOfCommand(["codex", "exec", "resume", "thread-7"]), { harness: "codex", session: sessionLabel("thread-7") });
  assert.deepEqual(sessionOfCommand(["opencode", "run", "--session", "ses_42"]), { harness: "opencode", session: sessionLabel("ses_42") });
});

test("a command with no resumed session, a wrapper binary or a bad id names none", () => {
  for (const command of [
    ["node", "pm.mjs", "--once"],
    ["/usr/bin/npx", "claude", "--resume", CONVERSATION],
    ["cursor-agent", "-p", "PM tick"],
    ["cursor-agent", "-p", "--resume", "--force", "tick"],
    ["cursor-agent", "-p", "--resume", "/etc/passwd"],
    [],
    "not an array",
  ]) assert.equal(sessionOfCommand(command), null, JSON.stringify(command));
});

test("a schedule folder resolves to the deepest registered project holding it", () => {
  const projects = [
    { project: "ai-collab", root: "/home/b/ai-collab" },
    { project: "mono", root: "/home/b" },
  ];
  assert.equal(projectOfFolder("/home/b/ai-collab", projects), "ai-collab");
  assert.equal(projectOfFolder("/home/b/ai-collab/sub", projects), "ai-collab");
  assert.equal(projectOfFolder("/home/b/other", projects), "mono");
  assert.equal(projectOfFolder("/srv/elsewhere", projects), "");
  assert.equal(projectOfFolder("/home/b/ai-collab-evil", projects), "mono");
  assert.equal(projectOfFolder("", projects), "");
});

test("a run link opens the session timeline cut to the run's window", () => {
  const startedAt = Date.UTC(2026, 10, 22, 18, 0, 0);
  const run = { id: `pm@${new Date(startedAt).toISOString()}`, status: "SUCCESS", startedAt, finishedAt: startedAt + 120_000, session: { harness: "cursor", session: LABEL } };
  const link = runLink(run, "ai-collab");
  assert.match(link, /^#/);
  const selected = parseSelection(link.slice(1));
  assert.deepEqual(selected, {
    project: "ai-collab", level: "session", harness: "cursor", session: "cursor#" + LABEL, tab: "activity",
    run: "", window: { from: startedAt - RUN_WINDOW_SLACK_MS, to: startedAt + 120_000 + RUN_WINDOW_SLACK_MS },
  });
  // The run's own project wins over the sheet's, so a link from Home reaches the right project.
  assert.equal(parseSelection(runLink({ ...run, project: "mono" }, "ai-collab").slice(1)).project, "mono");
});

test("a run without a session or a start time has no link, and a run without an end uses its start", () => {
  assert.equal(runLink({ id: "x", status: "SUCCESS" }, "ai-collab"), "");
  assert.equal(runLink({ id: "x", status: "SUCCESS", session: { harness: "cursor", session: LABEL } }, "ai-collab"), "");
  const startedAt = 1_700_000_000_000;
  const run = { startedAt, session: { harness: "cursor", session: LABEL } };
  assert.deepEqual(runWindow(run), { project: "", harness: "cursor", session: "cursor#" + LABEL, from: startedAt - RUN_WINDOW_SLACK_MS, to: startedAt + RUN_WINDOW_SLACK_MS });
  assert.equal(runWindow({ startedAt }), null);
});

test("a window only applies to the timeline; other views and a bad range ignore it", () => {
  const hash = `level=session&project=demo&harness=cursor&session=cursor%23${LABEL}&tab=activity&from=1000&to=2000`;
  assert.deepEqual(parseSelection(hash).window, { from: 1000, to: 2000 });
  // A missing, inverted or non-positive bound leaves the timeline whole.
  for (const bad of ["from=1000", "from=2000&to=1000", "from=0&to=1000", "from=abc&to=1000"]) {
    assert.equal(parseSelection(`${hash.replace("from=1000&to=2000", bad)}`).window, undefined, bad);
  }
  for (const tab of ["subagents", "raw"]) {
    assert.equal(parseSelection(hash.replace("tab=activity", "tab=" + tab)).window, undefined, tab);
  }
});

test("neighbouring runs of one schedule get disjoint windows, at the midpoint between them", () => {
  const base = Date.UTC(2026, 10, 22, 18, 0, 0);
  const every = 30 * 60_000;
  const session = { harness: "cursor", session: LABEL };
  // Newest first, as the runner lists them; each tick lasts a minute.
  const runs = [2, 1, 0].map(i => ({ id: "pm@" + i, status: "SUCCESS", startedAt: base + i * every, finishedAt: base + i * every + 60_000, session }));
  const windows = runs.map(run => runWindow(run, "demo", runs));
  for (const window of windows) assert.notEqual(window, null);
  // Listed newest first, so each window starts where the next newer one ends: neighbours touch but never overlap.
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i - 1].from, windows[i].to, JSON.stringify(windows));
  // The newest run reaches 15 minutes past its own end; the oldest reaches 15 minutes before its start.
  assert.equal(windows[0].to, runs[0].finishedAt + RUN_WINDOW_SLACK_MS);
  assert.equal(windows[2].from, runs[2].startedAt - RUN_WINDOW_SLACK_MS);
  // A single run keeps its own slack on both sides.
  assert.deepEqual(runWindow(runs[1], "demo"), { project: "demo", harness: "cursor", session: "cursor#" + LABEL, from: runs[1].startedAt - RUN_WINDOW_SLACK_MS, to: runs[1].finishedAt + RUN_WINDOW_SLACK_MS });
});

test("a run from a runner that predates run detail lists without a window or a link", () => {
  // The old shape: no startedAt, no session; the row still renders, just without a timeline link.
  const old = { id: "pm@2026-11-22T18:00:00.000Z", status: "SUCCESS", scheduledTime: "2026-11-22T18:00:00.000Z", updatedAt: 1_700_000_000_000, output: {}, error: null };
  assert.equal(runWindow(old, "ai-collab"), null);
  assert.equal(runLink(old, "ai-collab"), "");
  assert.equal(runLabel(old), "");
});

test("a run row names its start time and duration", () => {
  const startedAt = Date.UTC(2026, 10, 22, 18, 0, 0);
  assert.notEqual(runLabel({ startedAt }), "");
  assert.equal(runLabel({}), "");
  assert.equal(runLabel({ startedAt: "yesterday" }), "");
});
