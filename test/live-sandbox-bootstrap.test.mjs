import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, after } from "node:test";
import { sandboxRun } from "../runner/sandbox-run.mjs";
import { parseSandboxList, runTool } from "../lib/sandbox.ts";
import { tempDir } from "./helpers/tmp.mjs";

const matrix = ["claude", "codex", "cursor-agent", "opencode"];

test("live OpenShell schedule bootstrap matrix", {
  skip: process.env.AI_COLLAB_LIVE_SANDBOX_BOOTSTRAP !== "1",
}, async (t) => {
  const openshell = process.env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const listSandboxes = async () => {
    const result = await runTool(openshell, ["sandbox", "list", "-o", "json"], { env: process.env });
    assert.equal(result.code, 0, `${openshell} sandbox list failed: ${result.stderr.trim()}`);
    return parseSandboxList(result.stdout);
  };
  await listSandboxes();

  // Run serially so the matrix only uses one slot under the host's sandbox cap.
  for (const command of matrix) {
    await t.test(command, async () => {
      const cwd = tempDir({ after }, "sandbox-bootstrap-");
      try {
        const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
        git("init", "--quiet", "--template=");
        git("config", "user.name", "Sandbox Bootstrap");
        git("config", "user.email", "sandbox-bootstrap@example.invalid");
        writeFileSync(join(cwd, "fixture.txt"), "sandbox bootstrap\n");
        git("add", "fixture.txt");
        git("commit", "--quiet", "--no-verify", "-m", "Bootstrap fixture");
        const originalHead = git("rev-parse", "HEAD").toString();

        const logs = [];
        let stdout = "";
        let stderr = "";
        const code = await sandboxRun({
          name: `boot-${command}-${basename(cwd)}`,
          cwd,
          project: basename(cwd),
          command: [command, "--version"],
        }, {
          env: { ...process.env, AI_COLLAB_STATE_DIR: join(cwd, "state") },
          log: (line) => logs.push(line),
          stdout: { write: (chunk) => { stdout += chunk; } },
          stderr: { write: (chunk) => { stderr += chunk; } },
        });

        const created = logs.map((line) => /^sandbox (\S+) created$/.exec(line)).find(Boolean);
        const diagnostics = logs.join("\n");
        assert.ok(created, diagnostics);
        const sandbox = created[1];
        assert.ok(logs.includes(`sandbox ${sandbox} deleted`), diagnostics);
        assert.ok(!(await listSandboxes()).some(({ name }) => name === sandbox), `${sandbox} still exists`);
        assert.ok(logs.includes("no new commits"), diagnostics);
        assert.equal(git("rev-parse", "HEAD").toString(), originalHead);
        assert.equal(code, 0, stderr.trim() || diagnostics);
        assert.match(stdout + stderr, /\b\d+\.\d+\.\d+\b/, `${command} did not print a version`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
