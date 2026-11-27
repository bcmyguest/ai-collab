import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sessionLabel } from "../lib/config.ts";
import { controlSession, nativeSessionId } from "../lib/sessions/control.ts";
import { installOpenCode, mcpEntry, mergeMcp, opencodeConfigDir, pluginShim } from "../lib/install-opencode.ts";
import { opencodeModels, parseOpenCodeModels } from "../lib/models.ts";
import { packageRoot } from "../lib/install-cursor.ts";
import { WAKE_PROMPT } from "../lib/mode.ts";
import { sessionDirectory } from "../lib/sessions.mjs";
import { START_HARNESSES, outputId, startCommand } from "../lib/start.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SRC = packageRoot(import.meta.url);
const ID = "ses_0123456789abcdefABCDEFghij";
const exited = { pid: 4_194_000, pidStart: "1" };
const peer = { sessionId: ID, cwd: "/tmp", id: "opencode#" + sessionLabel(ID), harness: "opencode", ...exited };
const host = { runner: { kind: "host" } };

function tempHome() {
  return tempDir({ after }, "ai-collab-opencode-home-");
}

test("opencode start: fixed run argv with --format json, provider/model names, session id from the JSON events", () => {
  assert.ok(START_HARNESSES.includes("opencode"));
  assert.deepEqual(startCommand("opencode", "/r", "hi"), ["opencode", ["run", "--format", "json", "hi"]]);
  assert.deepEqual(startCommand("opencode", "/r", "hi", { model: "anthropic/claude-sonnet-4-5" }), ["opencode", ["run", "--format", "json", "-m", "anthropic/claude-sonnet-4-5", "hi"]]);
  assert.ok(startCommand("opencode", "/r", "hi", { model: "openrouter/meta/llama-4:free#high" }));
  for (const bad of ["sonnet", "--yolo/x", "a/b c", "a/;rm", "/x", ""]) assert.equal(startCommand("opencode", "/r", "hi", { model: bad }), null, bad);
  assert.equal(startCommand("claude", "/r", "hi", { model: "anthropic/x" }), null, "slashes stay OpenCode-only");
  const out = `${JSON.stringify({ type: "step_start", timestamp: 1, sessionID: ID })}\n${JSON.stringify({ type: "text", sessionID: ID })}\n`;
  assert.equal(outputId("opencode", out), ID);
  assert.equal(outputId("opencode", '{"type":"text","session_id":"x"}'), "");
});

test("opencode models: provider/model lines from `opencode models`, cached a day, stale cache on failure", async (t) => {
  assert.deepEqual(parseOpenCodeModels("anthropic/claude-sonnet-4-5\nopenai/gpt-6 (default)\n\nnot a model\n-x/y\nanthropic/claude-sonnet-4-5\n"),
    ["anthropic/claude-sonnet-4-5", "openai/gpt-6"]);
  const stateDir = tempDir(t, "ai-collab-opencode-models-");
  const bin = path.join(stateDir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "opencode"), "", { mode: 0o755 });
  const env = { HOME: stateDir, PATH: bin };
  let runs = 0;
  const run = async (file, vars, args) => { runs++; assert.deepEqual(args, ["models"]); return "anthropic/claude-opus-5\n"; };
  const now = Date.now();
  assert.deepEqual(await opencodeModels(stateDir, env, { now, run }), ["anthropic/claude-opus-5"]);
  assert.deepEqual(await opencodeModels(stateDir, env, { now: now + 1000, run }), ["anthropic/claude-opus-5"]);
  assert.equal(runs, 1, "second read uses the cache");
  assert.deepEqual(await opencodeModels(stateDir, env, { now: now + 2 * 86400_000, run: async () => "" }), ["anthropic/claude-opus-5"]);
  rmSync(stateDir, { recursive: true, force: true });
});

test("opencode wake resumes with `opencode run --session`; compact goes through the server API even while running", async () => {
  assert.ok(nativeSessionId("opencode", ID));
  assert.equal(nativeSessionId("opencode", "00000000-abcd-1234-9876-000000000001"), false);
  assert.equal(nativeSessionId("claude", ID), false);
  const seen = [];
  const execute = async (file, args) => { seen.push([file, args]); return 0; };
  assert.equal((await controlSession("wake", peer, { ...host, execute })).status, "succeeded");
  assert.deepEqual(seen[0], ["opencode", ["run", "--session", ID, WAKE_PROMPT]]);
  const selfStart = (() => { const s = readFileSync("/proc/self/stat", "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19]; })();
  const running = { ...peer, pid: process.pid, pidStart: selfStart };
  assert.equal((await controlSession("wake", running, { ...host, execute })).status, "queued");
  const compacted = await controlSession("compact", running, { ...host, execute });
  assert.deepEqual([compacted.status, compacted.detail], ["succeeded", "OpenCode compacted the session."]);
  assert.deepEqual(seen[1], ["opencode", ["api", "session.compact", "--param", `sessionID=${ID}`, "--data", "{}"]]);
  assert.equal((await controlSession("compact", { ...peer, sessionId: "ses_bad id" }, { ...host, execute })).status, "unsupported");
  assert.equal(seen.length, 2);
});

test("opencode session directory lists the resume command", (t) => {
  const stateDir = tempDir(t, "ai-collab-opencode-sessions-");
  const cfg = { stateDir, project: "demo", peers: [] };
  const dir = path.join(stateDir, "demo", "registry");
  mkdirSync(dir, { recursive: true });
  const id = `opencode#${sessionLabel(ID)}`;
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, sessionId: ID, harness: "opencode", cwd: "/w", seenAt: 1 }));
  const [entry] = sessionDirectory(cfg);
  assert.equal(entry?.resume, `opencode run --session ${ID} "<prompt>"`);
  rmSync(stateDir, { recursive: true, force: true });
});

test("opencode install writes the plugin shim, the MCP server under mcp.servers, and the skills path into a temporary home", async () => {
  const home = tempHome();
  const dir = opencodeConfigDir({ home });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ model: "anthropic/x", plugins: ["other"], skills: ["/my/skills"], mcp: { servers: { other: { type: "local", command: ["x"] } } } }));
  const first = installOpenCode({ home, importMetaUrl: import.meta.url });
  assert.equal(first.ok, true, first.message);
  const second = installOpenCode({ home, importMetaUrl: import.meta.url });
  assert.equal(second.ok, true, second.message);
  const config = JSON.parse(readFileSync(first.config, "utf8"));
  assert.equal(config.model, "anthropic/x");
  assert.deepEqual(config.plugins, ["other"]);
  assert.deepEqual(config.skills, ["/my/skills", path.join(SRC, "skills")], "the skills path is added once");
  assert.deepEqual(Object.keys(config.mcp.servers), ["other", "ai-collab", "ai-collab-code"]);
  assert.deepEqual(config.mcp.servers["ai-collab"], { type: "local", command: ["node", path.join(SRC, "scripts", "ai-collab-mcp.mjs"), "opencode"], cwd: ".", enabled: true });
  assert.equal(first.plugin, path.join(dir, "plugins", "ai-collab.js"));
  assert.equal(readFileSync(first.plugin, "utf8"), pluginShim(SRC));
  // The shim resolves to the real plugin module, and that module loads as OpenCode would load it.
  const loaded = (await import(pathToFileURL(first.plugin).href)).default;
  assert.deepEqual([loaded.id, typeof loaded.setup], ["ai-collab", "function"]);
  rmSync(home, { recursive: true, force: true });
});

test("opencode install keeps a flat mcp layout, honours XDG_CONFIG_HOME, and refuses foreign files", () => {
  assert.deepEqual(mergeMcp({ mcp: { grep: { type: "local", command: ["g"] } } }, { type: "local" }).mcp, { grep: { type: "local", command: ["g"] }, "ai-collab": { type: "local" } });
  assert.deepEqual(mergeMcp({}, { type: "local" }).mcp, { servers: { "ai-collab": { type: "local" } } });
  const home = tempHome();
  const xdg = path.join(home, "xdg");
  const r = installOpenCode({ home, env: { XDG_CONFIG_HOME: xdg }, importMetaUrl: import.meta.url });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.config, path.join(xdg, "opencode", "opencode.json"));
  assert.equal(existsSync(path.join(home, ".config", "opencode")), false);

  const bad = tempHome();
  const dir = opencodeConfigDir({ home: bad });
  mkdirSync(path.join(dir, "plugins"), { recursive: true });
  writeFileSync(path.join(dir, "opencode.json"), "{ not json");
  const unparsable = installOpenCode({ home: bad, importMetaUrl: import.meta.url });
  assert.equal(unparsable.ok, false);
  assert.equal(readFileSync(path.join(dir, "opencode.json"), "utf8"), "{ not json", "a config it cannot parse is left alone");
  assert.equal(existsSync(path.join(dir, "plugins", "ai-collab.js")), false);
  writeFileSync(path.join(dir, "opencode.json"), "{}");
  writeFileSync(path.join(dir, "plugins", "ai-collab.js"), "export default {};\n");
  const foreign = installOpenCode({ home: bad, importMetaUrl: import.meta.url });
  assert.equal(foreign.ok, false);
  assert.equal(readFileSync(path.join(dir, "plugins", "ai-collab.js"), "utf8"), "export default {};\n");
  assert.deepEqual(mcpEntry("/src").command, ["node", "/src/scripts/ai-collab-mcp.mjs", "opencode"]);
  for (const h of [home, bad]) rmSync(h, { recursive: true, force: true });
});

test("opencode install adds the skills path to an object-form skills setting and keeps its other keys", async () => {
  const { mergeSkills } = await import("../lib/install-opencode.ts");
  const config = { skills: { paths: ["/a", "/b"], urls: ["https://x"] } };
  assert.deepEqual(mergeSkills(config, "/c").skills, { paths: ["/a", "/b", "/c"], urls: ["https://x"] });
  assert.deepEqual(mergeSkills(mergeSkills(config, "/c"), "/c").skills.paths, ["/a", "/b", "/c"], "added once");
});
