import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { closedProjectNames, readProjectsFile, removeProject, setProjectClosed, writeProjectsFile } from "../lib/teams.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function setup(entries) {
  const home = tempDir({ after }, "ai-collab-close-");
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  mkdirSync(path.join(env.XDG_CONFIG_HOME, "ai-collab"), { recursive: true });
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify(entries));
  return env;
}

const entries = [{ project: "alpha", root: "/tmp/alpha" }, { project: "beta", root: "/tmp/beta" }];

test("closing a project marks it closed and reopening clears the mark", () => {
  const env = setup(entries);
  setProjectClosed(env, "alpha", true);
  assert.deepEqual(closedProjectNames(env), ["alpha"]);
  assert.equal(readProjectsFile(env).length, 2);
  setProjectClosed(env, "alpha", false);
  assert.deepEqual(closedProjectNames(env), []);
});

test("deleting a project removes only its registry entry", () => {
  const env = setup(entries);
  removeProject(env, "beta");
  assert.deepEqual(readProjectsFile(env).map((entry) => entry.project), ["alpha"]);
});

test("closing or deleting an unregistered project throws with status 404", () => {
  const env = setup(entries);
  assert.throws(() => setProjectClosed(env, "gamma", true), { status: 404 });
  assert.throws(() => removeProject(env, "gamma"), { status: 404 });
});

test("writes go through a temp file and leave no temp file behind", () => {
  const env = setup(entries);
  writeProjectsFile(env, [{ project: "solo", root: "/tmp/solo" }]);
  const dir = path.join(env.XDG_CONFIG_HOME, "ai-collab");
  assert.deepEqual(readdirSync(dir).sort(), ["projects.json"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf8"))[0].project, "solo");
});
