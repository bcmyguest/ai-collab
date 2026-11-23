import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelection, projectNavigation, projectViewCounts } from "../web/lib/selection.js";

test("project navigation links use the existing levels and preserve the project", () => {
  const project = "demo & tools";
  for (const level of ["project", "tasks", "patterns"]) {
    const links = projectNavigation(project, level);
    assert.deepEqual(links.map(link => link.label), ["Chat", "Tasks", "Teams"]);
    assert.deepEqual(links.map(link => {
      const selection = parseSelection(link.href.slice(1));
      assert.equal(selection.project, project);
      assert.equal(link.current, selection.level === level);
      return selection.level;
    }), ["project", "tasks", "patterns"]);
  }
});

test("task and pattern deep links highlight their parent view", () => {
  for (const [hash, label] of [
    ["project=demo&level=tasks&task=deploy", "Tasks"],
    ["project=demo&level=project&tab=tasks", "Tasks"],
    ["project=demo&level=patterns&pattern=scout&edit=1", "Teams"],
  ]) {
    const { project, level } = parseSelection(hash);
    assert.deepEqual(projectNavigation(project, level).filter(link => link.current).map(link => link.label), [label]);
  }
});

test("project navigation is scoped to a picked project", () => {
  // Home and the inbox are not inside a project; with no project there is nothing to link to.
  for (const level of ["home", "inbox"]) assert.deepEqual(projectNavigation("demo", level), []);
  assert.deepEqual(projectNavigation("", "project"), []);
  // Inside a project every level keeps the three views, so the rail and the phone's bar never come and go. A session is
  // not one of them, so none is current there.
  for (const level of ["session", "compactions"]) {
    const links = projectNavigation("demo", level);
    assert.deepEqual(links.map(link => link.label), ["Chat", "Tasks", "Teams"]);
    assert.deepEqual(links.map(link => link.current), [false, false, false]);
    assert.deepEqual(links.map(link => parseSelection(link.href.slice(1)).level), ["project", "tasks", "patterns"]);
  }
});

test("each view badge counts that project's tasks and patterns, with the tasks waiting on a decision", () => {
  const data = {
    tasks: { tasks: [
      { id: "a", question: { text: "Which?", answer: null } },
      { id: "b", question: { text: "Which?", answer: { text: "that" } } },
      { id: "c" },
    ] },
    patterns: [{ name: "pair" }, { name: "crew" }],
  };
  assert.deepEqual(projectViewCounts(data), { tasks: 3, waiting: 1, patterns: 2 });
  assert.deepEqual(projectViewCounts({}), { tasks: 0, waiting: 0, patterns: 0 });
  const links = projectNavigation("demo", "tasks", projectViewCounts(data));
  assert.deepEqual(links.map(link => [link.label, link.count, link.waiting]), [
    ["Chat", 0, 0], ["Tasks", 3, 1], ["Teams", 2, 0],
  ]);
  assert.deepEqual(projectNavigation("demo", "project", {}).map(link => [link.count, link.waiting]), [[0, 0], [0, 0], [0, 0]]);
  // A session's nav carries the same counts as the views it links to.
  assert.deepEqual(projectNavigation("demo", "session", projectViewCounts(data)).map(link => link.count), [0, 3, 2]);
});
