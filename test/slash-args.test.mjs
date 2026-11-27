import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_PERMISSION_VALUES as HARNESS_VALUES } from "../lib/harness.ts";
import { CLAUDE_CLI_MODES as RUNNER_CLI_MODES, PERMISSION_TABLE } from "../runner/contract.ts";
import { CLAUDE_CLI_MODES, CLAUDE_PERMISSION_SUMMARIES, CLAUDE_PERMISSION_VALUES, RUNNER_MODE_SUMMARIES, RUNNER_PERMISSION_MODES } from "../web/lib/permission-modes.js";
import { matchArgs } from "../web/lib/slash-commands.js";

const values = (match) => match.options.map(option => option.value);

test("the browser's permission lists mirror lib/harness.ts and runner/contract.ts", () => {
  assert.deepEqual(CLAUDE_PERMISSION_VALUES, [...HARNESS_VALUES]);
  assert.deepEqual(CLAUDE_CLI_MODES, RUNNER_CLI_MODES);
  assert.deepEqual(RUNNER_PERMISSION_MODES, Object.fromEntries(Object.entries(PERMISSION_TABLE).map(([harness, table]) => [harness, Object.keys(table)])));
  for (const value of CLAUDE_PERMISSION_VALUES) assert.ok(CLAUDE_PERMISSION_SUMMARIES[value], value);
  for (const mode of RUNNER_PERMISSION_MODES.claude) assert.ok(RUNNER_MODE_SUMMARIES[mode], mode);
});

test("matchArgs is null until a known command with arguments and a space are typed", () => {
  assert.equal(matchArgs("claude", "/permission"), null);
  assert.equal(matchArgs("claude", "/compact "), null, "compact takes no arguments");
  assert.equal(matchArgs("claude", "/review x"), null, "unknown command");
  assert.equal(matchArgs("claude", "please /permission "), null);
});

test("/permission offers every Claude value, filtered by prefix, each with a summary", () => {
  const all = matchArgs("claude", "/permission ");
  assert.deepEqual(values(all), CLAUDE_PERMISSION_VALUES);
  assert.ok(all.options.every(option => option.summary));
  const auto = matchArgs("claude", "/permission AU");
  assert.deepEqual(values(auto), ["auto-afk", "auto"]);
  assert.equal(auto.options[1].text, "/permission auto", "the last argument gets no trailing space");
});

test("a value typed in full, or an argument past the last, gets no suggestions", () => {
  assert.deepEqual(matchArgs("claude", "/permission plan").options, []);
  assert.deepEqual(values(matchArgs("claude", "/permission auto")), ["auto-afk", "auto"], "auto is also a prefix of auto-afk");
  assert.deepEqual(matchArgs("claude", "/permission plan ").options, []);
});

test("an unsupported command reports its support and suggests nothing", () => {
  for (const harness of ["codex", "opencode", "cursor"]) {
    const match = matchArgs(harness, "/permission ");
    assert.equal(match.command.status, "unsupported", harness);
    assert.deepEqual(match.options, []);
  }
  assert.equal(matchArgs("cursor", "/mode ").command.status, "unsupported");
  assert.deepEqual(matchArgs("claude", "/model ", { models: ["anthropic/x"] }).options, [], "Claude has no model switch");
});

test("/mode offers the runner modes the harness accepts, and Claude's own names on Claude", () => {
  assert.deepEqual(values(matchArgs("claude", "/mode ")),
    ["supervised", "accept-edits", "auto", "full-access", "default", "acceptEdits", "bypassPermissions"]);
  assert.equal(matchArgs("claude", "/mode def").options[0].summary, "Claude's name for supervised");
  assert.deepEqual(values(matchArgs("codex", "/mode ")), ["supervised", "accept-edits", "auto", "full-access"]);
  assert.deepEqual(values(matchArgs("opencode", "/mode ")), ["supervised", "accept-edits", "full-access"]);
});

test("/team-permission offers the given teams, then the Claude values", () => {
  const teams = [{ name: "light-team", description: "Two reviewers" }, { name: "heavy" }];
  for (const harness of ["claude", "cursor"]) {
    const first = matchArgs(harness, "/team-permission ", { teams });
    assert.deepEqual(first.options.map(o => [o.value, o.summary, o.text]),
      [["light-team", "Two reviewers", "/team-permission light-team "], ["heavy", "", "/team-permission heavy "]]);
  }
  assert.deepEqual(values(matchArgs("claude", "/team-permission l", { teams })), ["light-team"]);
  assert.deepEqual(matchArgs("claude", "/team-permission ").options, [], "no team data, no team suggestions");
  const mode = matchArgs("claude", "/team-permission heavy  d", { teams });
  assert.deepEqual(mode.options.map(o => o.text), ["/team-permission heavy  default", "/team-permission heavy  dontAsk"]);
});

test("/model offers the harness's listed models only where the command runs", () => {
  const models = ["anthropic/claude-x", "openai/gpt-y"];
  assert.deepEqual(values(matchArgs("opencode", "/model op", { models })), ["openai/gpt-y"]);
  assert.deepEqual(matchArgs("opencode", "/model ").options, [], "no model list, no suggestions");
});
