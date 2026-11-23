// runner/sandbox.mjs against the fake openshell: naming, argv shapes, phase handling, and the sync fallbacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  destroySandbox, downloadArgv, downloadTree, ensureSandbox, execArgv, ownedSandboxNames, parseSandboxList,
  sandboxName, sandboxPhase, stateCommand, uploadArgv, uploadFile, uploadTree,
} from "../runner/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(OPENSHELL, 0o755);

function env() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-sandbox-"));
  const root = path.join(home, "work");
  mkdirSync(root);
  writeFileSync(path.join(root, "a.txt"), "one\n");
  return {
    home, root,
    env: {
      PATH: process.env.PATH, HOME: home, AI_COLLAB_OPENSHELL_BIN: OPENSHELL,
      FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
    },
  };
}

const calls = (t) => (existsSync(t.env.FAKE_OPENSHELL_LOG)
  ? readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : []);

test("sandboxName fits OpenShell's 19-character limit and distinguishes long projects", () => {
  assert.equal(sandboxName("My_Repo"), "ai-collab-my-repo");
  assert.equal(sandboxName("--x--"), "ai-collab-x");
  assert.equal(sandboxName("123456789").length, 19);
  assert.match(sandboxName("My_Project.v2"), /^ai-collab-[a-f0-9]{8}$/);
  const longProject = "a".repeat(80);
  assert.match(sandboxName(longProject), /^ai-collab-[a-f0-9]{8}$/);
  assert.notEqual(sandboxName(longProject), sandboxName(`${longProject}b`));
  assert.deepEqual(ownedSandboxNames(longProject), [sandboxName(longProject)]);
  assert.deepEqual(ownedSandboxNames("demo"), ["ai-collab-demo"]);
});

test("sandboxPhase reads the phase 0.1.9 writes, and stateCommand maps it to a lifecycle step", () => {
  assert.equal(sandboxPhase({ phase: "Ready" }), "Ready");
  assert.equal(sandboxPhase({ status: { phase: "stopped" } }), "stopped");
  assert.equal(sandboxPhase({}), "");
  assert.deepEqual(stateCommand("s", "Ready"), null);
  assert.deepEqual(stateCommand("s", "suspended"), ["resume", "s"]);
  assert.deepEqual(stateCommand("s", "stopped"), ["start", "s"]);
  assert.deepEqual(stateCommand("s", "EXITED"), ["start", "s"]);
});

test("execArgv sets env before --workdir and the command after --", () => {
  assert.deepEqual(execArgv({ openshell: "openshell", sandbox: "s", command: ["acp"] }), [
    "openshell", "sandbox", "exec", "--no-tty", "-n", "s", "--", "acp",
  ]);
  assert.deepEqual(execArgv({
    openshell: "openshell", sandbox: "s", workdir: "/w", env: { A: "1", B: "2" }, command: ["cli", "acp"],
  }), ["openshell", "sandbox", "exec", "--no-tty", "-n", "s", "--env", "A=1", "--env", "B=2", "--workdir", "/w", "--", "cli", "acp"]);
});

test("upload and download argv keep the trailing slash that preserves the basename", () => {
  assert.deepEqual(uploadArgv({ openshell: "openshell", sandbox: "s", local: "/tmp/x", remote: "/sandbox/work" }), [
    "openshell", "sandbox", "upload", "s", "/tmp/x/", "/sandbox/work/",
  ]);
  assert.deepEqual(downloadArgv({ openshell: "openshell", sandbox: "s", remote: "/sandbox/work/x", local: "/tmp/x" }), [
    "openshell", "sandbox", "download", "s", "/sandbox/work/x", "/tmp/x",
  ]);
});

test("parseSandboxList reads the reply and rejects a non-JSON one", () => {
  assert.deepEqual(parseSandboxList('{"sandboxes":[{"name":"a"}]}'), [{ name: "a" }]);
  assert.deepEqual(parseSandboxList('{"next_page_token":"","sandboxes":[]}'), []);
  assert.throws(() => parseSandboxList("not json"), /no JSON/);
});

test("ensureSandbox creates once, reuses a ready one, and starts a stopped one", async () => {
  const t = env();
  assert.equal(await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" }), "ai-collab-demo");
  assert.deepEqual(calls(t).slice(1).map((c) => c.slice(0, 2).join(" ")), ["sandbox create"]);
  writeFileSync(t.env.FAKE_OPENSHELL_LOG, "");
  assert.equal(await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" }), "ai-collab-demo");
  assert.deepEqual(calls(t).map((c) => c.slice(0, 2).join(" ")), ["sandbox list"], "a ready sandbox is reused");
  assert.ok(!calls(t).some((c) => c[1] === "create"));

  writeFileSync(t.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: "ai-collab-demo", phase: "stopped" }] }));
  await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" });
  assert.ok(calls(t).some((c) => c.join(" ") === "sandbox start ai-collab-demo"));
  assert.ok(!calls(t).some((c) => c[1] === "create"));
});

test("ensureSandbox recreates a sandbox in Error only when asked, and leaves it alone otherwise", async () => {
  const t = env();
  writeFileSync(t.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: "ai-collab-code", phase: "Error" }] }));
  await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-code" });
  assert.ok(!calls(t).some((c) => c[1] === "delete" || c[1] === "create"), "without recreateBroken a broken sandbox is kept");
  writeFileSync(t.env.FAKE_OPENSHELL_LOG, "");
  assert.equal(await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-code", recreateBroken: true }), "ai-collab-code");
  assert.deepEqual(calls(t).map((c) => c.slice(0, 2).join(" ")), ["sandbox list", "sandbox delete", "sandbox create"]);
});

test("ensureSandbox reports a failing openshell instead of throwing away its output", async () => {
  await assert.rejects(
    ensureSandbox({ openshell: "/nonexistent/openshell", env: { PATH: process.env.PATH }, name: "ai-collab-demo" }),
    /openshell sandbox list failed/,
  );
});

test("upload, download and delete move real files through the fake sandbox", async () => {
  const t = env();
  await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" });
  await uploadTree({ openshell: OPENSHELL, env: t.env, sandbox: "ai-collab-demo", local: t.root, remote: "/sandbox/work" });
  writeFileSync(path.join(t.root, "b.txt"), "two\n");
  await uploadFile({ openshell: OPENSHELL, env: t.env, sandbox: "ai-collab-demo", local: path.join(t.root, "b.txt"), remoteDir: "/sandbox/work/work" });
  const out = path.join(t.home, "back");
  await downloadTree({ openshell: OPENSHELL, env: t.env, sandbox: "ai-collab-demo", remote: "/sandbox/work/work", local: out });
  assert.equal(readFileSync(path.join(out, "a.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(path.join(out, "b.txt"), "utf8"), "two\n");

  const gone = await destroySandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" });
  assert.equal(gone.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
});

test("a download of a path the sandbox does not have throws with the client's message", async () => {
  const t = env();
  await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: "ai-collab-demo" });
  await assert.rejects(
    downloadTree({ openshell: OPENSHELL, env: t.env, sandbox: "ai-collab-demo", remote: "/sandbox/missing", local: path.join(t.home, "x") }),
    /sandbox download failed: .*missing/,
  );
});
