import test from "node:test";
import assert from "node:assert/strict";
import { REPORT_TEXT_MAX, SPAWN_NOTE, spawnAgent, spawnBriefNote, spawnReport } from "../lib/spawn.ts";

const cfg = { project: "demo", peer: "claude", session: "0123456789abcdef" };
const env = { AI_COLLAB_RUNNER_SOCKET: "/run/test/runner.sock" };

// A runner stand-in that records each request and answers with one reply.
function stub(reply = { status: 201, body: { status: "started", session: "opencode#fedcba9876543210", cwd: "/repo" } }) {
  const seen = [];
  const request = async (method, path, body, options) => {
    seen.push({ method, path, body, options });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { seen, request };
}

test("spawnAgent posts a managed spawn to the runner and returns the child's address", async () => {
  const runner = stub();
  const result = await spawnAgent(cfg, { harness: "opencode", model: "qwen/qwen3", brief: "  say hi  " }, { env, request: runner.request });
  assert.deepEqual(runner.seen, [{
    method: "POST", path: "/v1/sessions", options: { socket: "/run/test/runner.sock" },
    body: { project: "demo", harness: "opencode", model: "qwen/qwen3", prompt: "say hi", place: "folder", managed: true, parent: "claude#0123456789abcdef", spawn: true, system: false },
  }]);
  assert.deepEqual(result, { status: "started", session: "opencode#fedcba9876543210", harness: "opencode", model: "qwen/qwen3", cwd: "/repo", note: SPAWN_NOTE });
});

test("spawnAgent takes the model from harness:model, an explicit model wins, and worktree picks the place", async () => {
  const runner = stub();
  await spawnAgent(cfg, { harness: "codex:gpt-5", brief: "x", worktree: true }, { env, request: runner.request });
  assert.equal(runner.seen[0].body.model, "gpt-5");
  assert.equal(runner.seen[0].body.place, "worktree");
  await spawnAgent(cfg, { harness: "codex:gpt-5", model: "gpt-6", brief: "x" }, { env, request: runner.request });
  assert.equal(runner.seen[1].body.model, "gpt-6");
  await spawnAgent(cfg, { harness: "claude", brief: "x" }, { env, request: runner.request });
  assert.equal("model" in runner.seen[2].body, false);
});

test("spawnAgent refuses without a session, with a long brief and with an unknown harness", async () => {
  const runner = stub();
  await assert.rejects(spawnAgent({ ...cfg, session: "" }, { harness: "codex", brief: "x" }, { env, request: runner.request }), /needs this session's address/);
  await assert.rejects(spawnAgent(cfg, { harness: "codex", brief: "a".repeat(4001) }, { env, request: runner.request }), /1–4000/);
  await assert.rejects(spawnAgent(cfg, { harness: "vim", brief: "x" }, { env, request: runner.request }), /not a harness/);
  await assert.rejects(spawnAgent(cfg, { harness: "codex", model: "bad model", brief: "x" }, { env, request: runner.request }), /model name/);
  assert.equal(runner.seen.length, 0);
});

test("spawnAgent names the runner when it is down, and passes a runner refusal through", async () => {
  const down = stub(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  await assert.rejects(spawnAgent(cfg, { harness: "codex", brief: "x" }, { env, request: down.request }), /needs the ai-collab runner/);
  const refused = stub({ status: 429, body: { error: "this session already has 4 live spawned agents" } });
  await assert.rejects(spawnAgent(cfg, { harness: "codex", brief: "x" }, { env, request: refused.request }), { status: 429, message: /4 live spawned agents/ });
});

test("spawnReport names the child and outcome, keeps the text's tail and fills an empty text", () => {
  assert.equal(spawnReport("codex#3f2a9c0d1e4b5a69", "success", "done.\n"), "[spawn_agent] codex#3f2a9c0d1e4b5a69 finished (success):\ndone.");
  assert.equal(spawnReport("codex#3f2a9c0d1e4b5a69", "error", ""), "[spawn_agent] codex#3f2a9c0d1e4b5a69 finished (error):\n(no reply text)");
  const long = spawnReport("codex#3f2a9c0d1e4b5a69", "success", "a".repeat(10) + "b".repeat(REPORT_TEXT_MAX));
  const text = long.split("\n")[1];
  assert.equal(text, "…" + "b".repeat(REPORT_TEXT_MAX));
  const emoji = spawnReport("codex#3f2a9c0d1e4b5a69", "success", "x" + "😀".repeat(REPORT_TEXT_MAX)).split("\n")[1];
  assert.ok(!/^…[\uDC00-\uDFFF]/.test(emoji));
});

test("spawnBriefNote names the parent once", () => {
  assert.equal(spawnBriefNote("do it", "claude#0123456789abcdef"), "do it\n\n[ai-collab] You were started by claude#0123456789abcdef; your result reaches it automatically when your run ends.");
  assert.equal(spawnBriefNote("tell claude#0123456789abcdef", "claude#0123456789abcdef"), "tell claude#0123456789abcdef");
});
