// The Cursor adapter's OpenShell staging against the fake openshell: worktree, CLI tree, auth, and the round trip on close.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import cursorAdapter, { prepareSandbox, sandboxName } from "../runner/adapters/cursor.mjs";
import { ensureSandbox } from "../lib/sandbox.ts";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURSOR = path.join(HERE, "helpers", "fake-cursor-agent.mjs");
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell.mjs");
chmodSync(CURSOR, 0o755);
chmodSync(OPENSHELL, 0o755);

// A host install tree shaped like the real one: <home>/cursor-agent/versions/<v>/{cursor-agent,node}.
function lab({ auth = true } = {}) {
  const home = tempDir({ after }, "ai-collab-cursor-sandbox-");
  const root = path.join(home, "repo");
  const version = path.join(home, "cursor-agent", "versions", "2026.11.22-fake");
  for (const dir of [root, version]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(root, "host.txt"), "host\n");
  writeFileSync(path.join(version, "cursor-agent"), "#!/bin/sh\nexit 0\n");
  writeFileSync(path.join(version, "node"), "#!/bin/sh\nexit 0\n");
  let authPath = "";
  if (auth) {
    authPath = path.join(home, ".config", "cursor", "auth.json");
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, '{"token":"never-print-me"}\n', { mode: 0o600 });
  }
  const env = {
    PATH: process.env.PATH, HOME: home, AI_COLLAB_CURSOR_BIN: CURSOR, AI_COLLAB_OPENSHELL_BIN: OPENSHELL,
    LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
    // The real tree layout, since a lone fake binary has no node beside it to upload.
    AI_COLLAB_CURSOR_TREE: version,
    FAKE_CURSOR_LOG: path.join(home, "cursor.log"), FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"),
    FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"), FAKE_SANDBOX_CURSOR_BIN: CURSOR,
  };
  return { home, root, version, env, authPath };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
// The fake sandbox's directory for one sandbox name.
const sandboxDir = (t, name) => path.join(path.dirname(t.env.FAKE_OPENSHELL_STATE), "sandboxes", name);

function ctx() {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal };
}

test("prepareSandbox uploads the worktree and the CLI tree, and stages the auth file out of argv", async () => {
  const t = lab();
  const ctxOf = ctx();
  const sandbox = await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: sandboxName("demo") });
  const prepared = await prepareSandbox({
    openshell: OPENSHELL, env: t.env, sandbox, cwd: t.root, home: t.home, cursorTree: t.version, log: (l) => ctxOf.log(l),
  });
  assert.equal(prepared.workdir, "/sandbox/work/repo");
  assert.deepEqual(Object.keys(prepared.env).sort(), ["HOME", "PATH", "XDG_CONFIG_HOME"]);

  const box = sandboxDir(t, sandbox);
  assert.equal(readFileSync(path.join(box, "work", "repo", "host.txt"), "utf8"), "host\n", "the worktree is uploaded");
  assert.ok(existsSync(path.join(box, "agent", "2026.11.22-fake", "cursor-agent")), "the CLI tree is uploaded");
  assert.equal(readlinkSync(path.join(box, "bin", "cursor-agent")),
    "/sandbox/agent/2026.11.22-fake/cursor-agent", "a launcher on PATH points at the uploaded tree");
  const auth = path.join(box, "home", ".config", "cursor", "auth.json");
  assert.equal(readFileSync(auth, "utf8"), '{"token":"never-print-me"}\n');
  assert.equal(statSync(auth).mode & 0o077, 0, "the staged auth file stays private");
  assert.ok(!readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8").includes("never-print-me"), "the token never reaches argv");
  assert.ok(!ctxOf.logs.join("\n").includes("never-print-me"), "the token never reaches a log line");
});

test("prepareSandbox without a CLI tree falls back to the sandbox's own PATH, and without host auth keeps going", async () => {
  const t = lab({ auth: false });
  const sandbox = await ensureSandbox({ openshell: OPENSHELL, env: t.env, name: sandboxName("demo") });
  const logs = [];
  const prepared = await prepareSandbox({
    openshell: OPENSHELL, env: t.env, sandbox, cwd: t.root, home: t.home, cursorTree: "", log: (l) => logs.push(l),
  });
  assert.match(logs.join("\n"), /no CLI install tree found/);
  assert.equal(prepared.env.PATH, undefined, "the sandbox's own PATH is left alone");
  const withTree = await prepareSandbox({
    openshell: OPENSHELL, env: t.env, sandbox, cwd: t.root, home: t.home, cursorTree: t.version, staged: new Set(), log: (l) => logs.push(l),
  });
  assert.match(withTree.env.PATH, /^\/sandbox\/bin:/);
  assert.match(logs.join("\n"), /no host auth\.json found/);
});

test("a closed sandbox session copies its edits to the host and deletes the sandbox", async () => {
  const t = lab();
  const sandbox = sandboxName("demo");
  const handle = await cursorAdapter({ env: t.env }).open({
    project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env,
  }, ctx());
  assert.ok(existsSync(path.join(sandboxDir(t, sandbox), "work", "repo", "host.txt")), "the session starts from the uploaded tree");

  // An edit made inside the sandbox, as the CLI would make it.
  writeFileSync(path.join(sandboxDir(t, sandbox), "work", "repo", "made-inside.txt"), "from the sandbox\n");
  await handle.close();
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "from the sandbox\n", "the edit lands on the host");
  assert.deepEqual(JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, [], "the sandbox is deleted");
  assert.ok(lines(t.env.FAKE_OPENSHELL_LOG).some((c) => c.join(" ") === `sandbox delete ${sandbox}`));
});

test("two sessions share one sandbox; it is deleted when the last one closes", async () => {
  const t = lab();
  const adapter = cursorAdapter({ env: t.env });
  const options = { project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env };
  const first = await adapter.open(options, ctx());
  const second = await adapter.open(options, ctx());
  await first.close();
  assert.equal(JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes.length, 1, "the sandbox outlives the first close");
  await second.close();
  assert.deepEqual(JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, []);
  await adapter.shutdown();
});

test("a failed open releases the sandbox it claimed", async () => {
  const t = lab();
  const env = { ...t.env, FAKE_CURSOR_NEW_ERROR: "not logged in" };
  const adapter = cursorAdapter({ env });
  await assert.rejects(adapter.open({
    project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env,
  }, ctx()), /not logged in/);
  assert.deepEqual(JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes, [], "no sandbox is left behind");
});

test("a sandbox session asks session/new for the sandbox path, not the host path", async () => {
  const t = lab();
  const handle = await cursorAdapter({ env: t.env }).open({
    project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env: t.env,
  }, ctx());
  const created = lines(t.env.FAKE_CURSOR_LOG).find((e) => e.kind === "rpc" && e.method === "session/new");
  assert.equal(created.params.cwd, "/sandbox/work/repo", "the CLI runs inside the sandbox, so it needs the sandbox path");
  await handle.close();
});

test("a sandbox prompt streams through exec and finishes the run", async () => {
  const t = lab();
  const c = ctx();
  const project = "cursor-owned-session-smoke";
  const policy = path.join(t.root, "policy.yaml");
  writeFileSync(policy, "{}\n");
  const env = { ...t.env, AI_COLLAB_OPENSHELL_POLICY: policy };
  const handle = await cursorAdapter({ env }).open({
    project, cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { force: true }, env,
  }, c);
  const commands = lines(t.env.FAKE_OPENSHELL_LOG);
  const create = commands.find(([scope, command]) => scope === "sandbox" && command === "create");
  assert.equal(create?.[create.indexOf("--name") + 1], sandboxName(project));
  assert.ok(create?.includes("--policy"));
  assert.equal(create[create.indexOf("--policy") + 1], policy);
  const exec = commands.find((command) => command.includes("acp"));
  assert.deepEqual(exec?.slice(exec.indexOf("--force")), ["--force", "acp"]);
  await handle.send({ text: "hello" });
  for (let i = 0; i < 200 && !c.events.some((e) => e.type === EventType.RUN_FINISHED); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(c.events.find((e) => e.type === EventType.RUN_FINISHED)?.outcome, { type: "success" });
  assert.equal(c.events.find((e) => e.type === EventType.TEXT_MESSAGE_CHUNK)?.delta, "echo: hello");
  await handle.close();
});
