import assert from "node:assert/strict";
import { test } from "node:test";
import { LEVELS, parseSelection } from "../web/lib/selection.js";

const session = "session=claude%2328d7fa48c0ffee01&harness=claude&project=demo";

test("an empty hash, home, and level=home open Home", () => {
  for (const hash of ["", "home", "level=home&project=demo"]) assert.equal(parseSelection(hash).level, "home");
});

test("a session opens its timeline when no tab or an old chat or activity tab is named", () => {
  for (const tab of [null, "chat", "activity", "bogus"]) {
    const hash = `level=session&${session}` + (tab ? `&tab=${tab}` : "");
    assert.deepEqual(parseSelection(hash), { project: "demo", level: "session", harness: "claude", session: "claude#28d7fa48c0ffee01", tab: "activity", run: "" });
  }
});

test("a session keeps its subagents and raw tabs, with the run of a subagent view", () => {
  assert.equal(parseSelection(`level=session&${session}&tab=raw`).tab, "raw");
  const subagents = parseSelection(`level=session&${session}&tab=subagents&run=run1`);
  assert.equal(subagents.tab, "subagents");
  assert.equal(subagents.run, "run1");
});

test("a project has one chat, whatever tab the hash names", () => {
  for (const tab of [null, "chat", "activity", "raw", "subagents"]) {
    const hash = "level=project&project=demo" + (tab ? `&tab=${tab}` : "");
    assert.deepEqual(parseSelection(hash), { project: "demo", level: "project", harness: "", session: "", tab: "chat", run: "" });
  }
});

test("an unknown level falls back to the project chat", () => {
  assert.equal(parseSelection("project=demo&level=bogus").level, "project");
});

test("the task board has its own level, and an old project&tab=tasks link opens it", () => {
  const direct = parseSelection("project=demo&level=tasks");
  assert.deepEqual(direct, { project: "demo", level: "tasks", harness: "", session: "", tab: "chat", run: "" });
  const legacy = parseSelection("project=demo&level=project&tab=tasks");
  assert.equal(legacy.level, "tasks");
  assert.equal(legacy.project, "demo");
  // The tasks level carries no tab of its own: a stray tab in the hash is ignored.
  assert.equal(parseSelection("project=demo&level=tasks&tab=tasks").tab, "chat");
});

test("every sidebar level names itself in LEVELS, including Tasks", () => {
  assert.deepEqual(LEVELS.map(([id]) => id), ["project", "session", "tasks", "patterns", "compactions"]);
});
