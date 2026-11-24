import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareSandbox } from "../runner/adapters/cursor.mjs";

const openshell = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));

test("Cursor uploads generated launcher and credentials without Git discovery", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aic-cursor-stage-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cwd = join(home, "work");
  const cursorTree = join(home, "cursor-fixture");
  const config = join(home, ".config", "ai-collab");
  const token = join(home, "fixture-token");
  mkdirSync(cwd);
  mkdirSync(cursorTree);
  mkdirSync(config, { recursive: true });
  writeFileSync(join(cursorTree, "cursor-agent"), "#!/bin/sh\n");
  writeFileSync(token, "fixture\n", { mode: 0o600 });
  mkdirSync(join(home, ".config", "cursor"));
  writeFileSync(join(home, ".config", "cursor", "auth.json"), '{"token":"fixture"}', { mode: 0o600 });
  writeFileSync(join(config, "defaults.json"), JSON.stringify({ tokenFile: token }));
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    FAKE_OPENSHELL_STATE: join(home, "openshell.json"), FAKE_OPENSHELL_LOG: join(home, "openshell.log"),
  };
  await prepareSandbox({ openshell, env, sandbox: "fixture", cwd, cursorTree, home, project: "fixture" });
  const uploads = readFileSync(env.FAKE_OPENSHELL_LOG, "utf8").trim().split("\n")
    .map(line => JSON.parse(line)).filter(args => args[1] === "upload");
  const stagedPaths = [
    /ai-collab-sandbox-bin-[^/]+\/bin\/$/,
    /ai-collab-sandbox-ntfy-[^/]+\/ai-collab\/$/,
    /ai-collab-sandbox-secret-[^/]+\/ntfy-token$/,
    /ai-collab-sandbox-auth-[^/]+\/auth\.json$/,
  ];
  for (const stagedPath of stagedPaths) {
    const upload = uploads.find(args => args.some(arg => stagedPath.test(arg)));
    assert.ok(upload?.includes("--no-git-ignore"), `Git filtering must be disabled for ${stagedPath}`);
  }
  assert.ok(uploads.some(args => args[3] === cwd + "/" && !args.includes("--no-git-ignore")));
});
