// OpenCode in OpenShell against the fake openshell and a fake `opencode serve`: staging, the forwarded server, landing on close.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "@ag-ui/core";
import openCodeAdapter from "../runner/adapters/opencode.ts";
import { forwardPort, OPENCODE_IN, opencodePolicy, parseJsonc, sandboxConfig } from "../runner/adapters/opencode-sandbox.ts";
import { opencodeSandboxName, sandboxName } from "../lib/sandbox.ts";
import { openshellHarnesses } from "../lib/sessions/launch.ts";
import { tempDir } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OPENSHELL = path.join(HERE, "helpers", "fake-openshell-forward.mjs");
const SERVE = path.join(HERE, "helpers", "fake-opencode-serve.mjs");
for (const file of [OPENSHELL, SERVE, path.join(HERE, "helpers", "fake-openshell.mjs")]) chmodSync(file, 0o755);
const BOX = opencodeSandboxName("demo");
const HOST_CONFIG = `{
  // a comment, and a URL whose // is no comment
  "plugin": ["host-only-plugin"],
  "mcp": { "codegraph": { "type": "local", "command": ["codegraph"] } },
  "provider": {
    "halogen": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://127.0.0.1:8731/v1" }, },
    "remote": { "options": { "baseURL": "https://api.example.com/v1" } },
  },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
}`;

// A host git worktree, an OpenCode config and login, and the fakes' env.
function lab() {
  const home = tempDir({ after }, "ai-collab-opencode-sandbox-");
  const root = path.join(home, "repo");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "host.txt"), "host\n");
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), HOST_CONFIG);
  mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(path.join(home, ".local", "share", "opencode", "auth.json"), '{"copilot":"never-print-me"}\n', { mode: 0o600 });
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, "state"), AI_COLLAB_OPENSHELL_BIN: OPENSHELL, AI_COLLAB_OPENCODE_BIN: SERVE,
    FAKE_OPENSHELL_LOG: path.join(home, "openshell.log"), FAKE_OPENSHELL_STATE: path.join(home, "openshell.json"),
  };
  return { home, root, env, git };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const box = (t, ...rest) => path.join(t.home, "sandboxes", BOX, ...rest);
const sandboxes = (t) => JSON.parse(readFileSync(t.env.FAKE_OPENSHELL_STATE, "utf8")).sandboxes;
const serverCalls = (t) => lines(box(t, "home", ".fake-opencode-calls.jsonl"));
const options = (t, extra = {}) => ({ project: "demo", cwd: t.root, place: "openshell", permissionMode: "full-access", permission: { autoReply: ["*"] }, model: "halogen/halogen-qwen3.8-flash-next", env: t.env, ...extra });

function ctx() {
  const events = [];
  const logs = [];
  return { events, logs, emit: (e) => events.push(e), log: (m) => logs.push(m), signal: new AbortController().signal };
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("parseJsonc reads comments and trailing commas, and keeps // inside strings", () => {
  assert.equal(parseJsonc(HOST_CONFIG).provider.halogen.options.baseURL, "http://127.0.0.1:8731/v1");
  assert.deepEqual(parseJsonc('{"a": "x/*y*/z", /* gone */ "b": [1, 2,],}'), { a: "x/*y*/z", b: [1, 2] });
});

test("sandboxConfig keeps providers and permissions, points loopback providers at the host, and drops host-only keys", () => {
  const { config, ports } = sandboxConfig(parseJsonc(HOST_CONFIG));
  assert.equal(config.provider.halogen.options.baseURL, "http://host.openshell.internal:8731/v1");
  assert.equal(config.provider.remote.options.baseURL, "https://api.example.com/v1", "a remote provider is left alone");
  assert.deepEqual(ports, [8731]);
  assert.equal(config.plugin, undefined);
  assert.equal(config.mcp, undefined);
  assert.equal(config.autoupdate, false);
  assert.deepEqual(config.permissions, [{ action: "shell", resource: "*", effect: "ask" }]);
});

test("opencodePolicy lets only the uploaded binary reach each host provider port", () => {
  const policy = opencodePolicy([8731, 13305]);
  assert.deepEqual(policy.network_policies.host_providers.endpoints.map((e) => `${e.host}:${e.port}`), ["host.openshell.internal:8731", "host.openshell.internal:13305"]);
  assert.deepEqual(policy.network_policies.host_providers.binaries, [{ path: OPENCODE_IN }]);
  assert.deepEqual(policy.network_policies.opencode.binaries, [{ path: OPENCODE_IN }]);
  assert.equal(opencodePolicy([]).network_policies.host_providers, undefined);
});

test("forwardPort reads the port openshell 0.1.9 prints", () => {
  assert.equal(forwardPort("✓ Forwarding 127.0.0.1:41593 -> 127.0.0.1:4096 in sandbox aic-oc-x via gRPC\n"), 41593);
  assert.equal(forwardPort("Starting...\n"), 0);
});

test("the OpenCode sandbox is apart from Cursor's, and OpenCode may start in OpenShell", () => {
  assert.notEqual(opencodeSandboxName("demo"), sandboxName("demo"));
  assert.ok(opencodeSandboxName("a-very-long-project-name").length <= 19);
  assert.ok(openshellHarnesses({ PATH: process.env.PATH }).includes("opencode"));
  assert.deepEqual(openCodeAdapter({ env: {} }).capabilities.places, ["folder", "worktree", "openshell"]);
});

test("an openshell session runs on the sandboxed server, and its close lands the work and deletes the sandbox", async () => {
  const t = lab();
  const c = ctx();
  const adapter = openCodeAdapter({ env: t.env });
  const handle = await adapter.open(options(t), c);
  assert.equal(handle.nativeId, "ses_box1");

  const [created] = sandboxes(t);
  assert.equal(created.name, BOX);
  assert.equal(created.labels["ai-collab.owner"], "opencode-demo");
  assert.equal(readFileSync(box(t, "work", "repo", "host.txt"), "utf8"), "host\n", "the worktree is uploaded");
  assert.ok(existsSync(box(t, "work", "repo", ".git")), "as a git clone");
  assert.ok(existsSync(box(t, "opencode", "opencode")), "the binary is installed at /sandbox/opencode/opencode");
  const config = JSON.parse(readFileSync(box(t, "home", ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(config.provider.halogen.options.baseURL, "http://host.openshell.internal:8731/v1");
  assert.equal(statSync(box(t, "home", ".opencode-serve", "password")).mode & 0o077, 0, "the password file stays private");
  assert.equal(readFileSync(box(t, "home", ".local", "share", "opencode", "auth.json"), "utf8"), '{"copilot":"never-print-me"}\n');
  const password = readFileSync(box(t, "home", ".opencode-serve", "password"), "utf8");
  const argv = readFileSync(t.env.FAKE_OPENSHELL_LOG, "utf8");
  assert.ok(!argv.includes(password), "the server password never reaches argv");
  assert.ok(!argv.includes("never-print-me"), "the login never reaches argv");
  assert.ok(lines(t.env.FAKE_OPENSHELL_LOG).some((a) => a.join(" ") === `forward service ${BOX} --target-port 4096 --local 127.0.0.1:0`));
  assert.ok(lines(t.env.FAKE_OPENSHELL_LOG).some((a) => a[0] === "sandbox" && a[1] === "create" && a.includes("--policy")));

  const session = serverCalls(t).find((call) => call.method === "POST" && call.path === "/api/session");
  assert.deepEqual(session.body.location, { directory: "/sandbox/work/repo" }, "the session works in the sandbox's copy");
  assert.deepEqual(session.body.model, { providerID: "halogen", id: "halogen-qwen3.8-flash-next" });

  await until(() => serverCalls(t).some((call) => call.path === "/api/event"), "the event stream");
  await handle.send({ text: "say PONG" });
  await until(() => c.events.some((e) => e.type === EventType.RUN_FINISHED), "the run to finish");
  assert.deepEqual(c.events.map((e) => e.type), [EventType.RUN_STARTED, EventType.TEXT_MESSAGE_CHUNK, EventType.RUN_FINISHED]);
  assert.equal(c.events[1].delta, "PONG");

  // An edit the agent left uncommitted inside the sandbox.
  writeFileSync(box(t, "work", "repo", "made-inside.txt"), "from the sandbox\n");
  await handle.close();
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "from the sandbox\n", "the edit lands on the host");
  assert.match(t.git("log", "-1", "--format=%B"), /Assisted-by: OpenCode:opencode/);
  assert.deepEqual(sandboxes(t), [], "the sandbox is deleted");
  await adapter.shutdown();
});

test("two sessions of a project share one sandbox and one server; the last close deletes it; Cursor's sandbox is left alone", async () => {
  const t = lab();
  writeFileSync(t.env.FAKE_OPENSHELL_STATE, JSON.stringify({ sandboxes: [{ name: sandboxName("demo"), phase: "Ready", labels: { "ai-collab.managed": "true", "ai-collab.project": "demo", "ai-collab.kind": "session", "ai-collab.owner": "demo" } }] }));
  const adapter = openCodeAdapter({ env: t.env });
  const first = await adapter.open(options(t), ctx());
  const second = await adapter.open(options(t), ctx());
  assert.equal(lines(t.env.FAKE_OPENSHELL_LOG).filter((a) => a[0] === "forward").length, 1, "one server and forward");
  await first.close();
  assert.ok(sandboxes(t).some((s) => s.name === BOX), "the sandbox outlives the first close");
  await second.close();
  assert.deepEqual(sandboxes(t).map((s) => s.name), [sandboxName("demo")]);
  await adapter.shutdown();
});

test("after a runner restart the session resumes in the kept sandbox without a new upload, and release lands it", async () => {
  const t = lab();
  const before = openCodeAdapter({ env: t.env });
  const handle = await before.open(options(t), ctx());
  writeFileSync(box(t, "work", "repo", "made-inside.txt"), "kept\n");
  await before.shutdown();
  assert.ok(sandboxes(t).some((s) => s.name === BOX), "shutdown keeps the sandbox");

  const record = { address: "opencode#abc", project: "demo", cwd: t.root, place: "openshell", status: "idle", nativeId: handle.nativeId, permissionMode: "full-access" };
  const after = openCodeAdapter({ env: t.env });
  after.restore(record);
  const resumed = await after.resume(record, ctx(), t.env);
  assert.equal(resumed.nativeId, "ses_box1");
  assert.equal(readFileSync(box(t, "work", "repo", "made-inside.txt"), "utf8"), "kept\n", "the sandbox's work is not overwritten");
  assert.equal(lines(t.env.FAKE_OPENSHELL_LOG).filter((a) => a[0] === "forward").length, 2, "a new server and forward");
  await resumed.close();
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "kept\n");
  assert.deepEqual(sandboxes(t), []);
  await after.shutdown();
});

test("a restored record that never resumes is landed and its sandbox deleted on release", async () => {
  const t = lab();
  const before = openCodeAdapter({ env: t.env });
  await before.open(options(t), ctx());
  writeFileSync(box(t, "work", "repo", "made-inside.txt"), "released\n");
  await before.shutdown();
  const record = { address: "opencode#def", project: "demo", cwd: t.root, place: "openshell", status: "idle" };
  const after = openCodeAdapter({ env: t.env });
  after.restore(record);
  assert.equal(await after.release(record), true);
  assert.equal(readFileSync(path.join(t.root, "made-inside.txt"), "utf8"), "released\n");
  assert.deepEqual(sandboxes(t), []);
});

test("an OpenShell team run is refused before any sandbox is made", async () => {
  const t = lab();
  await assert.rejects(openCodeAdapter({ env: t.env }).open(options(t, { patternRun: "run1" }), ctx()), /team run/);
  assert.equal(existsSync(t.env.FAKE_OPENSHELL_LOG), false);
});
