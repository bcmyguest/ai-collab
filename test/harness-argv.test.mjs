import assert from "node:assert/strict";
import { test } from "node:test";
import { startCommand } from "../lib/start.mjs";
import { harnessCommand as builderCommand } from "../lib/builder.mjs";
import { harnessCommand as wakeCommand } from "../lib/sessions/control.ts";
import { codexRequiredRunCodeArgs } from "../lib/code-mode.mjs";
import { authorCommand } from "../lib/catalog/author.ts";
import { pushSession } from "../lib/deliver-push.mjs";
import { acpArgs } from "../runner/adapters/cursor.mjs";
import { argv } from "../lib/harness.ts";
import { WAKE_PROMPT } from "../lib/mode.mjs";

// Pinned from the per-harness sites before they moved into lib/harness.ts; each row is what that site returned.
const MODEL = { claude: "claude-haiku-5-5", codex: "gpt-5-codex", cursor: "deepseek-v41-flash-1017-high", opencode: "openai/gpt-5" };
const UUID = "6f1d2c3a-4b5e-4f60-8a7b-9c0d1e2f3a4b";

test("start argv per harness and option", () => {
  const start = (harness, opts) => startCommand(harness, "/w/proj", "Do it", opts);
  assert.deepEqual(start("claude", {}), ["claude", ["--bg", "Do it"]]);
  assert.deepEqual(start("claude", { model: MODEL.claude }), ["claude", ["--bg", "--model", "claude-haiku-5-5", "Do it"]]);
  assert.deepEqual(start("claude", { model: MODEL.claude, mode: "plan" }), ["claude", ["--bg", "--permission-mode", "plan", "--model", "claude-haiku-5-5", "Do it"]]);
  assert.deepEqual(start("claude", { model: MODEL.claude, worktree: "wt-1" }), ["claude", ["--bg", "--worktree", "wt-1", "--model", "claude-haiku-5-5", "Do it"]]);
  assert.deepEqual(start("claude", { model: MODEL.claude, codeMode: true }), ["claude", ["--bg", "--model", "claude-haiku-5-5", "Do it"]]);
  assert.deepEqual(start("codex", {}), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "Do it"]]);
  assert.deepEqual(start("codex", { model: MODEL.codex }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-m", "gpt-5-codex", "Do it"]]);
  assert.deepEqual(start("codex", { model: MODEL.codex, mode: "plan" }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-s", "read-only", "-m", "gpt-5-codex", "Do it"]]);
  assert.deepEqual(start("codex", { model: MODEL.codex, codeMode: true }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=true", "-m", "gpt-5-codex", "Do it"]]);
  assert.deepEqual(start("codex", { model: MODEL.codex, codeMode: false }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=false", "-m", "gpt-5-codex", "Do it"]]);
  assert.deepEqual(start("codex", { requireRunCode: true, codeMode: true }), ["codex", ["exec", "--json", "--dangerously-bypass-hook-trust", "-c", "features.code_mode=true", ...codexRequiredRunCodeArgs(), "Do it"]]);
  assert.deepEqual(start("cursor", {}), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/w/proj", "Do it"]]);
  assert.deepEqual(start("cursor", { model: MODEL.cursor }), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/w/proj", "--model", "deepseek-v41-flash-1017-high", "Do it"]]);
  assert.deepEqual(start("cursor", { model: MODEL.cursor, mode: "plan" }), ["cursor-agent", ["-p", "--trust", "--output-format", "stream-json", "--workspace", "/w/proj", "--mode", "plan", "--model", "deepseek-v41-flash-1017-high", "Do it"]]);
  assert.deepEqual(start("opencode", {}), ["opencode", ["run", "--format", "json", "Do it"]]);
  assert.deepEqual(start("opencode", { model: MODEL.opencode }), ["opencode", ["run", "--format", "json", "-m", "openai/gpt-5", "Do it"]]);
  assert.deepEqual(start("opencode", { model: MODEL.opencode, mode: "plan" }), ["opencode", ["run", "--format", "json", "--agent", "plan", "-m", "openai/gpt-5", "Do it"]]);
  assert.equal(start("claude", { model: "bad model!" }), null);
  assert.equal(start("cursor", { model: "bad model!" }), null);
});

test("wake argv per harness; compact only for opencode", () => {
  const wake = (harness, requireRunCode = false) => wakeCommand("wake", harness, "ses-1", requireRunCode, { path: "" });
  assert.deepEqual(wake("claude"), ["claude", ["--print", "--resume", "ses-1", WAKE_PROMPT]]);
  assert.deepEqual(wake("codex"), ["codex", ["exec", "resume", "ses-1", WAKE_PROMPT]]);
  assert.deepEqual(wake("codex", true), ["codex", ["exec", ...codexRequiredRunCodeArgs(), "resume", "ses-1", WAKE_PROMPT]]);
  assert.deepEqual(wake("cursor"), ["agent", ["--print", "--resume", "ses-1", WAKE_PROMPT]]);
  assert.deepEqual(wake("opencode"), ["opencode", ["run", "--session", "ses-1", WAKE_PROMPT]]);
  for (const harness of ["claude", "codex", "cursor"]) {
    assert.equal(wakeCommand("compact", harness, "ses-1", false, { path: "" }), null);
  }
  assert.deepEqual(wakeCommand("compact", "opencode", "ses-1", false, { path: "" }), ["opencode", ["api", "session.compact", "--param", "sessionID=ses-1", "--data", "{}"]]);
});

test("builder argv per harness, flattened as the sandbox exec takes it", () => {
  const build = (harness, extra = {}) => builderCommand({ harness, model: MODEL[harness], brief: "BRIEF", workdir: "/sandbox/work", ...extra });
  const claudeFlags = ["-p", "--model", "claude-haiku-5-5", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose",
    "--tools", "Bash,Read,Edit,Write,Glob,Grep", "--strict-mcp-config", "--mcp-config", "/sandbox/home/.claude/builder-mcp.json",
    "--disable-slash-commands", "--no-chrome", "--setting-sources", "", "--settings", "/sandbox/home/.claude/builder-settings.json", "BRIEF"];
  assert.deepEqual(build("claude"), ["/sandbox/tools/bin/claude", ...claudeFlags]);
  assert.deepEqual(build("claude", { launcher: "/opt/bin/claude" }), ["/opt/bin/claude", ...claudeFlags]);
  assert.deepEqual(build("codex"), ["codex", "exec", "-m", "gpt-5-codex", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--skip-git-repo-check", "-C", "/sandbox/work", "BRIEF"]);
  assert.deepEqual(build("cursor"), ["cursor-agent", "-p", "--force", "--trust", "--sandbox", "disabled", "--model", "deepseek-v41-flash-1017-high", "BRIEF"]);
  assert.deepEqual(build("cursor", { builderCode: true }), ["cursor-agent", "-p", "--force", "--trust", "--sandbox", "disabled", "--model", "deepseek-v41-flash-1017-high", "--approve-mcps", "--output-format", "stream-json", "BRIEF"]);
  assert.deepEqual(build("opencode"), ["opencode", "run", "--standalone", "--auto", "--format", "json", "--model", "openai/gpt-5", "BRIEF"]);
});

test("author argv per harness, with and without a model", () => {
  assert.deepEqual(authorCommand("claude", "PROMPT", MODEL.claude), ["claude", ["-p", "--model", "claude-haiku-5-5", "PROMPT"]]);
  assert.deepEqual(authorCommand("claude", "PROMPT"), ["claude", ["-p", "PROMPT"]]);
  assert.deepEqual(authorCommand("codex", "PROMPT", MODEL.codex), ["codex", ["exec", "-m", "gpt-5-codex", "PROMPT"]]);
  assert.deepEqual(authorCommand("codex", "PROMPT"), ["codex", ["exec", "PROMPT"]]);
  assert.deepEqual(authorCommand("cursor", "PROMPT", MODEL.cursor), ["cursor-agent", ["-p", "--trust", "--model", "deepseek-v41-flash-1017-high", "PROMPT"]]);
  assert.deepEqual(authorCommand("cursor", "PROMPT"), ["cursor-agent", ["-p", "--trust", "PROMPT"]]);
  assert.deepEqual(authorCommand("opencode", "PROMPT", MODEL.opencode), ["opencode", ["run", "-m", "openai/gpt-5", "PROMPT"]]);
  assert.deepEqual(authorCommand("opencode", "PROMPT"), ["opencode", ["run", "PROMPT"]]);
});

test("queue argv is the codex queue call; other harnesses take none", async () => {
  const calls = [];
  const run = async (file, args) => { calls.push([file, args]); return 0; };
  await pushSession({ harness: "codex", sessionId: UUID }, "hello there", { urgent: false, ids: [] }, { run, env: {} });
  assert.deepEqual(calls, [["codex", ["queue", "--thread", UUID, "--message", "hello there", "--resume"]]]);
});

test("argv is the one owner: interrupt and the kinds a harness lacks return null", () => {
  assert.deepEqual(argv("codex", "interrupt", {}), ["codex", ["app-server", "proxy"]]);
  for (const harness of ["claude", "cursor", "opencode"]) assert.equal(argv(harness, "interrupt", {}), null);
  assert.equal(argv("claude", "queue", { id: UUID, text: "x" }), null);
  assert.equal(argv("codex", "compact", { id: UUID }), null);
  assert.equal(argv("opencode", "acp", {}), null);
  assert.deepEqual(argv("cursor", "wake", { id: "ses-1", prompt: "WAKE", path: "" }), ["agent", ["--print", "--resume", "ses-1", "WAKE"]]);
  assert.deepEqual(argv("codex", "wake", { id: "ses-1", prompt: "WAKE", requireRunCode: true }), ["codex", ["exec", ...codexRequiredRunCodeArgs(), "resume", "ses-1", "WAKE"]]);
});

test("acp argv", () => {
  assert.deepEqual(acpArgs({}), ["acp"]);
  assert.deepEqual(acpArgs({ force: true }), ["acp", "--force"]);
  assert.deepEqual(acpArgs({ force: true, model: MODEL.cursor }), ["acp", "--force", "--model", "deepseek-v41-flash-1017-high"]);
});
