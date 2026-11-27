import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { productionDistDir } from "../lib/ui-build-output.ts";
import { tempDir } from "./helpers/tmp.mjs";

test("UI builds publish only successful releases and retain previous output", (t) => {
  const root = tempDir(t, "ai-collab-ui-build-");
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
  const tools = path.join(root, "tools");
  mkdirSync(tools);
  copyFileSync(new URL("../deploy/verify-ui.mjs", import.meta.url), path.join(deploy, "verify-ui.mjs"));
  const log = path.join(root, "deploy.log");
  writeFileSync(path.join(root, "systemctl"), `#!/bin/sh
echo "restart $*" >> "$MOCK_DEPLOY_LOG"
if [ -n "$MOCK_RESTART_STATUS" ]; then exit "$MOCK_RESTART_STATUS"; fi
`, { mode: 0o755 });
  writeFileSync(path.join(tools, "smoke-ui.mjs"), `
    import { appendFileSync, readFileSync } from "node:fs";
    const current = readFileSync(new URL("../web/.next-builds/current", import.meta.url), "utf8").trim();
    const id = readFileSync(new URL("../web/.next-builds/" + current + "/BUILD_ID", import.meta.url), "utf8");
    appendFileSync(process.env.MOCK_DEPLOY_LOG, JSON.stringify([id, ...process.argv.slice(2)]) + "\\n");
    process.exit(id === "smoke-fails" ? 7 : 0);
  `);
  const build = (id, options = [], env = {}) => spawnSync(process.execPath, [path.join(deploy, "build-ui.mjs"), id, ...options], {
    env: { ...process.env, AI_COLLAB_NEXT_DIST: "", PATH: root + path.delimiter + process.env.PATH,
      MOCK_DEPLOY_LOG: log, AI_COLLAB_UI_VERIFY_URL: "http://localhost:9876/", ...env },
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
  const optIn = ["--deploy-and-verify"];
  assert.equal(build("failed", optIn).status, 42);
  assert.throws(() => readFileSync(log), { code: "ENOENT" });

  assert.equal(build("restart-fails", optIn, { MOCK_RESTART_STATUS: "9" }).status, 9);
  assert.equal(build("verified", optIn).status, 0);
  assert.equal(build("smoke-fails", optIn).status, 7);
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
    "restart --user restart ai-collab-ui.service",
    "restart --user restart ai-collab-ui.service",
    JSON.stringify(["verified", "http://localhost:9876/", "--operator-workflow"]),
    "restart --user restart ai-collab-ui.service",
    JSON.stringify(["smoke-fails", "http://localhost:9876/", "--operator-workflow"]),
  ]);
});
