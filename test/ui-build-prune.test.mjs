import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("a publish keeps the current build, the build it replaced and the newest other", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-ui-prune-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const web = path.join(root, "web");
  const builds = path.join(web, ".next-builds");
  const deploy = path.join(root, "deploy");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin");
  mkdirSync(deploy, { recursive: true });
  mkdirSync(nextBin, { recursive: true });
  copyFileSync(new URL("../deploy/build-ui.mjs", import.meta.url), path.join(deploy, "build-ui.mjs"));
  writeFileSync(path.join(nextBin, "next"), `
    const fs = require("node:fs");
    const path = require("node:path");
    fs.writeFileSync(path.join(process.argv[3], process.env.AI_COLLAB_NEXT_DIST, "BUILD_ID"), process.argv[4]);
    if (process.argv[4] === "failed") process.exit(42);
  `);
  const build = (id) => spawnSync(process.execPath, [path.join(deploy, "build-ui.mjs"), id], {
    env: { ...process.env, AI_COLLAB_NEXT_DIST: "" }, encoding: "utf8",
  });
  const current = () => readFileSync(path.join(builds, "current"), "utf8").trim();
  const dirs = () => readdirSync(builds).filter((name) => name.startsWith("build-")).sort();
  const idOf = (name) => readFileSync(path.join(builds, name, "BUILD_ID"), "utf8");

  const published = [];
  for (const [i, id] of ["b1", "b2", "b3", "b4"].entries()) {
    assert.equal(build(id).status, 0);
    published.push(current());
    // Distinct mtimes, oldest first, so the newest order is deterministic.
    const at = new Date(Date.UTC(2026, 0, 1 + i));
    utimesSync(path.join(builds, current()), at, at);
  }
  assert.deepEqual(dirs(), published.slice(1).sort());

  // The replaced build stays even when its mtime is the oldest: a server started on it may still run.
  const old = new Date(Date.UTC(2020, 0, 1));
  utimesSync(path.join(builds, published[3]), old, old);
  assert.equal(build("b5").status, 0);
  assert.deepEqual(dirs().map(idOf).sort(), ["b3", "b4", "b5"]);

  // A failed build prunes nothing.
  assert.equal(build("failed").status, 42);
  assert.deepEqual(dirs().map(idOf).sort(), ["b3", "b4", "b5"]);
});
