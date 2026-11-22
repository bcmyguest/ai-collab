import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionLabel } from "../lib/config.mjs";
import { COMMANDS, SUPPORT, commandFor, commandSupport, matchCommands, parseCommand } from "../web/lib/slash-commands.js";
import { modelRef, slashCommand } from "../lib/slash.mjs";

const HARNESSES = ["claude", "codex", "opencode", "cursor"];
const OPENCODE_ID = "ses_abcdefghijklmnopqrstuvwxyz";
// A session as the registry records it: a native ID, an absolute workspace, and a peer id ending in the label.
const peer = (harness, sessionId = harness === "opencode" ? OPENCODE_ID : "1f0c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f") => ({
  harness, sessionId, cwd: "/work", id: `${harness}-x#${sessionLabel(sessionId)}`,
});

// A fake OpenCode service call that records each request and answers ok.
function fakeOpencode(reply = { ok: true, status: 200, body: null }) {
  const calls = [];
  const fn = async (method, path, options) => {
    calls.push({ method, path, body: options?.body });
    return reply;
  };
  return { calls, fn };
}

test("parseCommand reads the name and arguments of a leading slash", () => {
  assert.deepEqual(parseCommand("/model anthropic/claude-x "), { name: "model", args: "anthropic/claude-x" });
  assert.deepEqual(parseCommand("/Compact"), { name: "compact", args: "" });
  assert.equal(parseCommand("compact the notes"), null);
  assert.equal(parseCommand("/ spaced"), null);
  assert.equal(parseCommand("/1x"), null);
});

test("commandFor makes a message a command only for a known name or a name the picker inserted", () => {
  assert.deepEqual(commandFor("/compact"), { name: "compact", args: "" });
  assert.deepEqual(commandFor("/clear now"), { name: "clear", args: "now" });
  assert.equal(commandFor("/home/x is broken"), null, "a path is chat");
  assert.equal(commandFor("/review main"), null, "an unpicked name is chat");
  assert.deepEqual(commandFor("/review main", new Set(["review"])), { name: "review", args: "main" });
  assert.equal(commandFor("compact"), null);
});

test("every harness states support for every known command and for passthrough", () => {
  for (const harness of HARNESSES) {
    for (const { name } of COMMANDS) {
      const entry = SUPPORT[harness][name];
      assert.ok(["supported", "partial", "unverified", "unsupported"].includes(entry.status), `${harness} ${name}`);
      assert.ok(entry.reason.length > 0, `${harness} ${name} needs a reason`);
    }
    assert.ok(SUPPORT[harness].passthrough, `${harness} passthrough`);
  }
});

test("claude and codex compact are partial: an owned session compacts, a terminal one only gets a request", () => {
  assert.equal(SUPPORT.claude.compact.status, "partial");
  assert.match(SUPPORT.claude.compact.reason, /runner-owned session compacts in place/);
  assert.equal(SUPPORT.codex.compact.status, "partial");
  assert.match(SUPPORT.codex.compact.reason, /runner-owned session compacts in place/);
  assert.equal(SUPPORT.opencode.compact.status, "supported");
});

test("claude and cursor support no model switch, clear or passthrough", () => {
  for (const harness of ["claude", "cursor"]) {
    for (const name of ["model", "clear", "passthrough"]) assert.equal(SUPPORT[harness][name].status, "unsupported", `${harness} ${name}`);
  }
  assert.equal(commandSupport("claude", "anything-typed").status, "unsupported");
});

test("unknown names fall back to passthrough support", () => {
  assert.equal(commandSupport("opencode", "review").status, "unverified");
  assert.equal(commandSupport("codex", "review").status, "unsupported");
  assert.equal(commandSupport("nope", "compact").status, "unsupported");
});

test("matchCommands filters by prefix and carries the support status", () => {
  assert.deepEqual(matchCommands("opencode", "co").map(c => [c.name, c.status]), [["compact", "supported"]]);
  assert.deepEqual(matchCommands("codex", "").map(c => c.name), ["compact", "model", "clear"]);
});

test("matchCommands offers a typed name that no known command matches as passthrough", () => {
  assert.deepEqual(matchCommands("opencode", "review").map(c => [c.name, c.status]), [["review", "unverified"]]);
  assert.deepEqual(matchCommands("codex", "review").map(c => [c.name, c.status]), [["review", "unsupported"]]);
  assert.deepEqual(matchCommands("opencode", "Bad Name!"), []);
});

test("modelRef splits provider/model and rejects a missing part", () => {
  assert.deepEqual(modelRef("anthropic/claude-x"), { providerID: "anthropic", modelID: "claude-x" });
  assert.deepEqual(modelRef("openai/gpt/5"), { providerID: "openai", modelID: "gpt/5" });
  assert.equal(modelRef("claude-x"), null);
  assert.equal(modelRef("anthropic/"), null);
  assert.equal(modelRef("/claude-x"), null);
});

test("an unsupported command returns its reason without calling the harness", async () => {
  let compacted = false;
  const r = await slashCommand(peer("claude"), { name: "model", args: "x/y" }, { compact: () => { compacted = true; } });
  assert.equal(r.status, "unsupported");
  assert.match(r.detail, /socket/);
  assert.equal(compacted, false);
});

test("compact goes to the caller's compaction control for every harness that supports it", async () => {
  const seen = [];
  const compact = async (p) => { seen.push(p.harness); return { status: "requested", detail: "done" }; };
  for (const harness of ["claude", "codex", "opencode"]) {
    assert.deepEqual(await slashCommand(peer(harness), { name: "compact", args: "" }, { compact }), { status: "requested", detail: "done" });
  }
  assert.deepEqual(seen, ["claude", "codex", "opencode"]);
});

test("compact with instructions is refused for every harness, and nothing is compacted", async () => {
  let compacted = false;
  const compact = () => { compacted = true; };
  for (const harness of ["claude", "codex", "opencode"]) {
    const r = await slashCommand(peer(harness), { name: "compact", args: "keep the API notes" }, { compact });
    assert.equal(r.status, "unsupported", harness);
    assert.match(r.detail, /instructions/);
  }
  assert.equal(compacted, false);
});

test("a missing registration is unsupported", async () => {
  assert.equal((await slashCommand(null, { name: "compact", args: "" }, { compact: () => {} })).status, "unsupported");
});

test("every command refuses a session ID that is not native, a relative workspace, or a mismatched label", async () => {
  const { calls, fn } = fakeOpencode();
  let compacted = false;
  const compact = () => { compacted = true; };
  const bad = [
    { ...peer("opencode"), sessionId: ".." },
    { ...peer("opencode"), sessionId: "ses_../../x" },
    { ...peer("opencode"), cwd: "work" },
    { ...peer("opencode"), id: "opencode-x#0000000000000000" },
    { ...peer("opencode"), id: undefined },
  ];
  for (const p of bad) {
    for (const command of [{ name: "compact", args: "" }, { name: "model", args: "a/b" }, { name: "review", args: "" }]) {
      const r = await slashCommand(p, command, { compact, opencode: fn });
      assert.equal(r.status, "unsupported", `${p.sessionId} ${command.name}`);
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(compacted, false);
});

test("opencode model posts provider and model to the session's model route", async () => {
  const { calls, fn } = fakeOpencode();
  const r = await slashCommand(peer("opencode"), { name: "model", args: "anthropic/claude-x" }, { opencode: fn });
  assert.deepEqual(calls, [{ method: "POST", path: `/api/session/${OPENCODE_ID}/model`, body: { providerID: "anthropic", modelID: "claude-x" } }]);
  assert.deepEqual(r, { status: "succeeded", detail: "Switched the model to anthropic/claude-x." });
});

test("opencode model without provider/model fails before any request", async () => {
  const { calls, fn } = fakeOpencode();
  const r = await slashCommand(peer("opencode"), { name: "model", args: "claude-x" }, { opencode: fn });
  assert.equal(r.status, "failed");
  assert.equal(calls.length, 0);
});

test("opencode passthrough posts the command and its arguments to the command route", async () => {
  const { calls, fn } = fakeOpencode();
  const r = await slashCommand(peer("opencode"), { name: "review", args: "main" }, { opencode: fn });
  assert.deepEqual(calls, [{ method: "POST", path: `/api/session/${OPENCODE_ID}/command`, body: { command: "review", arguments: "main" } }]);
  assert.deepEqual(r, { status: "succeeded", detail: "Ran /review." });
});

test("a failed opencode request reports its error", async () => {
  const { fn } = fakeOpencode({ ok: false, status: 404, error: "404 not found" });
  const r = await slashCommand(peer("opencode"), { name: "model", args: "a/b" }, { opencode: fn });
  assert.deepEqual(r, { status: "failed", detail: "404 not found" });
});

test("codex passthrough is unsupported and sends nothing", async () => {
  const { calls, fn } = fakeOpencode();
  const r = await slashCommand(peer("codex"), { name: "review", args: "" }, { opencode: fn });
  assert.equal(r.status, "unsupported");
  assert.equal(calls.length, 0);
});
