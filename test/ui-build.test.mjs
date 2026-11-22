import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { productionDistDir } from "../lib/ui-build-output.mjs";

test("UI builds publish only successful releases and retain previous output", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-collab-ui-build-"));
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
    const output = path.join(process.argv[3], process.env.AI_COLLAB_NEXT_DIST);
    fs.writeFileSync(path.join(output, "BUILD_ID"), process.argv[4]);
    if (process.argv[4] === "failed") process.exit(42);
  `);
  const build = (id) => spawnSync(process.execPath, [path.join(deploy, "build-ui.mjs"), id], {
    env: { ...process.env, AI_COLLAB_NEXT_DIST: "" },
    encoding: "utf8",
  });
  assert.equal(productionDistDir(web), ".next");
  const first = build("first");
  assert.equal(first.status, 0, first.stderr);
  const firstDir = productionDistDir(web);
  assert.equal(build("failed").status, 42);
  assert.equal(productionDistDir(web), firstDir);
  assert.equal(readdirSync(builds).length, 2);

  const second = build("second");
  assert.equal(second.status, 0, second.stderr);
  const secondDir = productionDistDir(web);
  assert.notEqual(secondDir, firstDir);
  assert.equal(readFileSync(path.join(web, firstDir, "BUILD_ID"), "utf8"), "first");
  assert.equal(readFileSync(path.join(web, secondDir, "BUILD_ID"), "utf8"), "second");
});
