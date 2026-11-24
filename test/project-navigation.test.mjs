import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelection, projectNavigation } from "../web/lib/selection.js";

test("project navigation links use the existing levels and preserve the project", () => {
  const project = "demo & tools";
  for (const level of ["project", "tasks", "patterns"]) {
    const links = projectNavigation(project, level);
    assert.deepEqual(links.map(link => link.label), ["Chat", "Tasks", "Patterns"]);
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
    ["project=demo&level=patterns&pattern=scout&edit=1", "Patterns"],
  ]) {
    const { project, level } = parseSelection(hash);
    assert.deepEqual(projectNavigation(project, level).filter(link => link.current).map(link => link.label), [label]);
  }
});

test("project navigation appears only within a project", () => {
  for (const level of ["home", "inbox"]) {
    assert.deepEqual(projectNavigation("demo", level), []);
  }
  assert.deepEqual(projectNavigation("", "project"), []);
  for (const level of ["session", "compactions"]) {
    const links = projectNavigation("demo", level);
    assert.equal(links.length, 3);
    assert.equal(links.some(link => link.current), false);
  }
});
