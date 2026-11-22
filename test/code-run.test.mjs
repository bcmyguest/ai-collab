// run_code (lib/code-run.mjs, scripts/ai-collab-code-mcp.mjs) against fakes: a fake openshell, no real sandbox or CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP, CALLS_MAX, CODE_TOOLS, OUTPUT_MAX_CHARS, REMOTE_DIR, codeSandbox, formatRun, hostCaller, prepareSandbox,
  programArgv, runCodeTool, runProgram, schemaProblem, signature,
} from "../lib/code-run.mjs";
import { toolClient } from "../lib/tool-api.mjs";
import { addTask, taskStoreFile, writeStore } from "../lib/tasks.mjs";

const SERVER = fileURLToPath(new URL("../scripts/ai-collab-code-mcp.mjs", import.meta.url));
const FAKE_OPENSHELL = fileURLToPath(new URL("./helpers/fake-openshell.mjs", import.meta.url));
const SESSION = "aabbccddeeff0123";
// The bootstrap run on the host: tests the line protocol and limits; a real run_code only ever uses programArgv.
const LOCAL = [process.execPath, "-e", BOOTSTRAP];

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-code-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A fake openshell on PATH-free terms: a shell wrapper that runs the repo's fake with this node.
function fakeOpenshell(dir) {
  const bin = join(dir, "openshell");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_OPENSHELL}" "$@"\n`);
  chmodSync(bin, 0o755);
  // The "node" uploaded into the fake sandbox: a wrapper, so the test copies a few bytes, not the node binary.
  const node = join(dir, "node-wrapper");
  writeFileSync(node, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(node, 0o755);
  return { bin, node, state: join(dir, "openshell.json"), log: join(dir, "openshell.log") };
}

test("the description lists the allowed ai.* calls from the tool schemas and leaves start and interrupt out", () => {
  const tool = runCodeTool(toolClient().listTools());
  assert.equal(tool.name, "run_code");
  for (const name of CODE_TOOLS) assert.match(tool.description, new RegExp(`ai\\.${name}\\(`), name);
  for (const name of ["team_start", "pattern_start", "interrupt", "ask_question", "send_to_all", "pattern_advance"]) {
    assert.doesNotMatch(tool.description, new RegExp(`ai\\.${name}\\(`), name);
  }
  assert.match(tool.description, /ai\.task_list\(args\?: \{ status\?: "open" \| "decided"/);
  assert.doesNotMatch(signature(toolClient().listTools().find((t) => t.name === "send")), /session\??:/);
  assert.deepEqual(tool.inputSchema.required, ["code", "session"]);
});

test("schemaProblem checks types, patterns, enums, required and unknown keys", () => {
  const schema = toolClient().listTools().find((t) => t.name === "send").inputSchema;
  assert.equal(schemaProblem(schema, { to: "all", body: "hi", session: SESSION }), "");
  assert.match(schemaProblem(schema, { to: "all", session: SESSION }), /body is required/);
  assert.match(schemaProblem(schema, { to: "Bad Name", body: "hi", session: SESSION }), /does not match/);
  assert.match(schemaProblem(schema, { to: "all", body: "hi", session: SESSION, priority: "loud" }), /one of/);
  assert.match(schemaProblem(schema, { to: "all", body: "hi", session: SESSION, extra: 1 }), /not a known argument/);
  assert.match(schemaProblem(schema, { to: "all", body: "hi", session: SESSION, await_reply: 99 }), /above 45/);
});

test("hostCaller fills in the caller's session, refuses other tools and bad args, and reaches the real tool", async (t) => {
  const home = temp(t);
  const env = { HOME: home, XDG_DATA_HOME: home, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "builder" };
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha", status: "open" }, 1);
  writeStore(taskStoreFile("demo", env), doc);
  const call = hostCaller({ client: toolClient({ env, cwd: home }), session: SESSION });
  await call("task_update", { id: "alpha", status: "building", session: "ffffffffffffffff" });
  const { tasks } = await call("task_list", {});
  assert.equal(tasks[0].status, "building");
  await assert.rejects(call("interrupt", { to: "codex#0123456789abcdef" }), /not available in run_code/);
  await assert.rejects(call("team_start", { name: "x", member: "codex", task: "t" }), /not available in run_code/);
  await assert.rejects(call("task_update", { id: "Bad Id" }), /does not match/);
});

test("a program returns its value and printed lines, and its ai.* calls go through callTool", async () => {
  const seen = [];
  const callTool = async (name, args) => { seen.push([name, args]); return name === "task_list" ? { tasks: [{ id: "a", owner: "codex#1" }, { id: "b" }] } : { agents: [] }; };
  const code = "const [{ tasks }, { agents }] = await Promise.all([ai.task_list(), ai.list_agents({ all: true })]);\n"
    + "console.log('tasks', tasks.length);\nreturn tasks.filter((t) => t.owner && !agents.length).map((t) => t.id);";
  const run = await runProgram({ argv: LOCAL, code, callTool });
  assert.equal(run.ok, true, run.error);
  assert.deepEqual(run.value, ["a"]);
  assert.deepEqual(run.logs, ["tasks 2"]);
  assert.equal(run.calls, 2);
  assert.deepEqual(seen.map(([name]) => name).sort(), ["list_agents", "task_list"]);
  assert.deepEqual(seen.find(([name]) => name === "list_agents")[1], { all: true });
});

test("a tool error throws inside the program, and a call outside the allowlist never reaches callTool", async () => {
  const seen = [];
  const callTool = async (name) => { seen.push(name); throw new Error("boom"); };
  const code = "const out = [];\ntry { await ai.task_list(); } catch (e) { out.push(e.message); }\n"
    + "out.push(typeof ai.interrupt);\nreturn out;";
  const run = await runProgram({ argv: LOCAL, code, callTool });
  assert.deepEqual(run.value, ["boom", "undefined"]);
  assert.deepEqual(seen, ["task_list"]);
});

test("the host refuses a forged call to a tool outside the allowlist", async () => {
  let reached = false;
  const code = "process.stdout.write(JSON.stringify({ call: 999, tool: 'team_start', args: {} }) + '\\n');\nawait new Promise((r) => setTimeout(r, 300));\nreturn 'done';";
  const run = await runProgram({ argv: LOCAL, code, callTool: async () => { reached = true; return {}; } });
  assert.equal(run.ok, true);
  assert.equal(reached, false);
  assert.equal(run.calls, 0);
});

test("syntax errors, thrown errors, timeouts and the call cap end the run with an error", async () => {
  const syntax = await runProgram({ argv: LOCAL, code: "return (", callTool: async () => ({}) });
  assert.equal(syntax.ok, false);
  assert.match(syntax.error, /SyntaxError/);
  const thrown = await runProgram({ argv: LOCAL, code: "throw new Error('nope')", callTool: async () => ({}) });
  assert.match(thrown.error, /nope/);
  const slow = await runProgram({ argv: LOCAL, code: "for (;;) {}", callTool: async () => ({}), timeoutMs: 1000 });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out after 1000 ms/);
  const many = await runProgram({ argv: LOCAL, code: `let n = 0;\nfor (let i = 0; i < ${CALLS_MAX + 5}; i++) { try { await ai.task_list(); } catch { n++; } }\nreturn n;`, callTool: async () => ({}) });
  assert.equal(many.value, 5);
});

test("formatRun clips the result text and says so", () => {
  const run = { ok: true, value: "x".repeat(OUTPUT_MAX_CHARS * 2), logs: [], calls: 0, ms: 1 };
  const text = formatRun(run);
  assert.ok(text.length < OUTPUT_MAX_CHARS + 100);
  assert.match(text, /\[clipped \d+ characters; return less\]$/);
  assert.deepEqual(JSON.parse(formatRun({ ok: false, error: "e", logs: ["l"], calls: 1, ms: 2 })), { ok: false, error: "e", logs: ["l"], calls: 1, ms: 2 });
});

test("without openshell nothing runs, and the error says why", async () => {
  assert.throws(() => codeSandbox({ PATH: "/nonexistent" }), /needs OpenShell.*nothing ran/);
  assert.throws(() => codeSandbox({ PATH: "/nonexistent", AI_COLLAB_OPENSHELL_BIN: "/x/openshell", AI_COLLAB_CODE_SANDBOX: "Bad_Name" }), /not a valid sandbox name/);
  await assert.rejects(prepareSandbox({ env: { PATH: "/nonexistent" } }), /needs OpenShell/);
  const failing = { PATH: "/nonexistent", AI_COLLAB_OPENSHELL_BIN: "/x/openshell" };
  await assert.rejects(prepareSandbox({ env: failing, ensure: async () => { throw new Error("gateway down"); } }), /could not reach its OpenShell sandbox ai-collab-code; nothing ran: gateway down/);
});

test("prepareSandbox uploads node and its marker once, then reuses the staged runtime", async (t) => {
  const dir = temp(t);
  const fake = fakeOpenshell(dir);
  const env = { PATH: process.env.PATH, AI_COLLAB_OPENSHELL_BIN: fake.bin, FAKE_OPENSHELL_STATE: fake.state, FAKE_OPENSHELL_LOG: fake.log };
  const uploads = () => readFileSync(fake.log, "utf8").split("\n").filter((l) => l.includes('"upload"')).length;
  const first = await prepareSandbox({ env, nodePath: fake.node, libs: async () => [] });
  assert.deepEqual(first, { openshell: fake.bin, name: "ai-collab-code" });
  const staged = join(dir, "sandboxes", "ai-collab-code", REMOTE_DIR.replace(/^\/sandbox\//, ""), "rt");
  assert.ok(existsSync(join(staged, "node")));
  assert.ok(existsSync(join(staged, "MARKER")));
  assert.equal(uploads(), 1);
  await prepareSandbox({ env, nodePath: fake.node, libs: async () => [] });
  assert.equal(uploads(), 1, "a matching marker skips the upload");
});

// Speaks MCP to the server over stdio; resolves the response for each request.
function mcp(env, cwd) {
  const child = spawn(process.execPath, [SERVER, "claude"], { env, cwd, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on("line", (line) => { const m = JSON.parse(line); pending.get(m.id)?.(m); });
  return {
    request: (method, params) => new Promise((resolve) => { const at = ++id; pending.set(at, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: at, method, params })}\n`); }),
    close: () => child.kill(),
  };
}

test("the MCP server lists run_code, runs a program in the (fake) sandbox, and answers its ai.* calls on the host", async (t) => {
  const dir = temp(t);
  const fake = fakeOpenshell(dir);
  const env = {
    PATH: process.env.PATH, HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"),
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude",
    AI_COLLAB_OPENSHELL_BIN: fake.bin, AI_COLLAB_CODE_NODE: fake.node, FAKE_OPENSHELL_STATE: fake.state, FAKE_OPENSHELL_LOG: fake.log,
  };
  const doc = { v: 1, tasks: [] };
  addTask(doc, { id: "alpha", title: "Alpha", status: "open" }, 1);
  addTask(doc, { id: "beta", title: "Beta", status: "building" }, 2).owner = "codex#0123456789abcdef";
  writeStore(taskStoreFile("demo", env), doc);
  const server = mcp(env, dir);
  t.after(() => server.close());
  await server.request("initialize", { protocolVersion: "2025-06-18" });
  const { result: listed } = await server.request("tools/list", {});
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["run_code", "run_read_code"]);
  const code = "const { tasks } = await ai.task_list();\nconst { agents } = await ai.list_agents();\nconst live = new Set(agents.map((a) => a.address));\n"
    + "return tasks.filter((t) => t.owner && !live.has(t.owner)).map((t) => t.id);";
  const { result } = await server.request("tools/call", { name: "run_code", arguments: { code, session: SESSION } });
  assert.equal(result.isError, undefined, result.content[0].text);
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(body.result, ["beta"], result.content[0].text);
  assert.equal(body.calls, 2);
  assert.doesNotMatch(listed.tools[1].description, /ai\.(send|task_update)\(/);
  const readCode = [
    "process.stdout.write(JSON.stringify({ call: 999, tool: 'task_update', args: { id: 'beta', status: 'done' } }) + '\\n');",
    "const { tasks } = await ai.task_list();",
    "return [typeof ai.send, typeof ai.task_update, tasks.find(t => t.id === 'beta').status];",
  ].join("\n");
  const { result: read } = await server.request("tools/call", { name: "run_read_code", arguments: { code: readCode, session: SESSION } });
  assert.equal(read.isError, undefined, read.content[0].text);
  const readBody = JSON.parse(read.content[0].text);
  assert.deepEqual(readBody.result, ["undefined", "undefined", "building"]);
  assert.equal(readBody.calls, 1);
  const operations = readFileSync(fake.log, "utf8").trim().split("\n").map(JSON.parse);
  const create = operations.find((args) => args[1] === "create" && args.includes("--policy"));
  const readSandbox = create[create.indexOf("--name") + 1];
  assert.match(readSandbox, /^aic-ro-[a-f0-9]{12}$/);
  assert.match(readFileSync(create[create.indexOf("--policy") + 1], "utf8"), /network_policies: \{\}/);
  assert.ok(operations.some((args) => args[1] === "delete" && args[2] === readSandbox));
  const execs = readFileSync(fake.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[1] === "exec");
  assert.ok(execs.some((a) => a.includes(`${REMOTE_DIR}/rt/node`) && a.includes("ai-collab-code")), "the program ran through openshell sandbox exec");
  const { result: bad } = await server.request("tools/call", { name: "run_code", arguments: { code: "return 1", session: "nope" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /session label/);
});

test("the MCP server refuses to run when openshell is missing", async (t) => {
  const dir = temp(t);
  const server = mcp({ PATH: "/nonexistent", HOME: dir, XDG_DATA_HOME: dir, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "claude" }, dir);
  t.after(() => server.close());
  await server.request("initialize", {});
  const { result } = await server.request("tools/call", { name: "run_code", arguments: { code: "return 1", session: SESSION } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs OpenShell.*nothing ran/);
});

test("programArgv runs the bootstrap through sandbox exec with the staged node", async () => {
  const argv = await programArgv({ openshell: "openshell", name: "ai-collab-code" });
  assert.deepEqual(argv.slice(0, 6), ["openshell", "sandbox", "exec", "--no-tty", "-n", "ai-collab-code"]);
  assert.ok(argv.includes(`LD_LIBRARY_PATH=${REMOTE_DIR}/rt/lib`));
  assert.deepEqual(argv.slice(argv.indexOf("--") + 1, argv.indexOf("--") + 4), [`${REMOTE_DIR}/rt/node`, "--max-old-space-size=256", "-e"]);
});
