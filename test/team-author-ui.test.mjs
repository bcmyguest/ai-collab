import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chmodSync } from "node:fs";
import { loadConfig } from "../lib/config.mjs";
import { listPatterns } from "../lib/patterns.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";

const base = "http://127.0.0.1:8796";

const DOT = `digraph "scout" {
  researcher [agent="cursor:deepseek-v41-flash-1017-high", prompt="Find the answer."];
  writer     [agent="claude:claude-haiku-5-5", prompt="Write the answer."];
  researcher -> writer [on="sources", required=true];
  writer     -> done   [on="written", required=true];
}
`;

// A fake writing agent: prints a fixed answer, or fails when asked to. `name` picks the harness executable to fake.
// `fail: true` exits 3 with "nope" on stderr. A string exits 1 with that text on stderr (a usage limit is stderr-only).
function fakeAuthor(home, { answer = `\`\`\`dot\n${DOT}\`\`\``, fail = false, name = "cursor-agent" } = {}) {
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  const record = `printf '%s\\n' "$@" > ${JSON.stringify(path.join(home, "author-args"))}\n`;
  if (fail) {
    const text = typeof fail === "string" ? fail : "nope";
    const code = typeof fail === "string" ? 1 : 3;
    writeFileSync(file, `#!/bin/sh\n${record}printf '%s\\n' ${JSON.stringify(text)} >&2\nexit ${code}\n`);
  } else {
    writeFileSync(file, `#!/bin/sh\n${record}printf '%s\\n' '${answer.replace(/'/g, "'\\''")}'\n`);
  }
  chmodSync(file, 0o755);
  return bin;
}

function setup({ answer, fail, name, peers = "claude,codex,cursor" } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-team-author-ui-"));
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers },
  ]));
  const bin = fakeAuthor(home, { answer, fail, name });
  const env = {
    HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: bin,
    AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: peers, AI_COLLAB_URL: "http://127.0.0.1:9",
  };
  return { home, root, env, cfg: loadConfig(env) };
}

async function ui(t, { answer, fail, name, peers } = {}) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const made = setup({ answer, fail, name, peers });
  const cfg = loadConfig({ ...made.env, AI_COLLAB_URL: fake.url });
  const server = createUi({ cfg, env: made.env, models: async () => ({ claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high", "grok-4.7-high"] }) });
  t.after(() => server.close());
  const post = (body) => server.handle(new Request(`${base}/api/pattern`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ project: "demo", ...body }),
  }), "pattern").then(async (r) => ({ status: r.status, body: await r.json() }));
  return { ...made, cfg, post };
}

test("describe-a-team drafts DOT through a writing agent and saves it only when asked", async (t) => {
  const { post, root } = await ui(t, { name: "agent" });
  const made = await post({ authorRequest: "Find something, then write it up.", team: "scout", authorScope: "project" });
  assert.equal(made.status, 201);
  assert.equal(made.body.status, "answered");
  assert.equal(made.body.ok, true);
  assert.equal(made.body.pattern.name, "scout");
  assert.equal(made.body.exists, "");
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout", "team.dot")), false, "a draft writes nothing");

  const saved = await post({ team: "scout", authorScope: "project", authorDot: made.body.dot });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.source, "project");
  assert.equal(readFileSync(path.join(root, ".ai-collab", "teams", "scout", "team.dot"), "utf8"), `${DOT.trimEnd()}\n`);
});

test("a second save of the same name needs the confirm, and an invalid draft is refused with its line", async (t) => {
  const { post, root } = await ui(t);
  const made = await post({ authorRequest: "x", team: "scout" });
  await post({ team: "scout", authorDot: made.body.dot });
  const again = await post({ team: "scout", authorDot: made.body.dot });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already exists; confirm the replacement/);
  const replaced = await post({ team: "scout", authorDot: made.body.dot, authorReplace: "scout" });
  assert.equal(replaced.status, 201);

  const bad = made.body.dot.replace('agent="claude:claude-haiku-5-5"', 'agent="gemini"');
  const refused = await post({ team: "other", authorDot: bad });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /agent harness must be one of/);
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "other")), false);
});

test("a writing agent that fails reports the failure and writes nothing", async (t) => {
  const { post, root } = await ui(t, { fail: true });
  const made = await post({ authorRequest: "x", team: "scout" });
  assert.equal(made.status, 201);
  assert.equal(made.body.status, "failed");
  assert.match(made.body.detail, /cursor-agent exited 3: nope/);
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout")), false);
});

test("a writing agent that exits 1 reports the usage-limit text from stderr", async (t) => {
  const { post, root } = await ui(t, { fail: "ActionRequiredError: You've hit your usage limit. Switch to a different model or set a Spend Limit to continue with this model." });
  const made = await post({ authorRequest: "x", team: "scout" });
  assert.equal(made.status, 201);
  assert.equal(made.body.status, "failed");
  assert.match(made.body.detail, /cursor-agent exited 1: ActionRequiredError: You've hit your usage limit/);
  assert.match(made.body.detail, /Switch to a different model/);
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout")), false);
});

test("the draft runs the harness and model the operator selected", async (t) => {
  const { post, home } = await ui(t, { name: "agent" });
  const made = await post({ authorRequest: "Find something, then write it up.", team: "scout", authorHarness: "cursor", authorModel: "grok-4.7-high" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.status, "answered");
  assert.equal(made.body.harness, "cursor");
  const args = readFileSync(path.join(home, "author-args"), "utf8").split("\n");
  assert.equal(args[0], "-p");
  assert.equal(args[2], "--model");
  assert.equal(args[3], "grok-4.7-high");
});

test("an unknown writing model is refused before the agent starts", async (t) => {
  const { post, home } = await ui(t, { name: "agent" });
  const made = await post({ authorRequest: "x", authorHarness: "cursor", authorModel: "not-a-model" });
  assert.equal(made.status, 400);
  assert.match(made.body.error, /not available for this harness/);
  assert.equal(existsSync(path.join(home, "author-args")), false);
});

test("a project with no cursor-agent drafts through a harness it can run", async (t) => {
  // Only a fake claude is on PATH, so the default writer (cursor) is not installed and claude writes instead, with no
  // model (the deepseek name belongs to cursor). The test's own PATH keeps the real cursor-agent out of reach.
  const { post, root } = await ui(t, { name: "claude" });
  const made = await post({ authorRequest: "Find something, then write it up.", team: "scout" });
  assert.equal(made.body.status, "answered", JSON.stringify(made.body));
  assert.equal(made.body.ok, true);
  assert.equal(made.body.harness, "claude");
  const saved = await post({ team: "scout", authorDot: made.body.dot });
  assert.equal(saved.status, 201);
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout", "team.dot")), true);
});

test("a name typed after the draft saves under that name, and a taken name needs the confirm", async (t) => {
  const { post, root } = await ui(t);
  // The composer drafts with no name, so the agent's digraph is the proposal.
  const made = await post({ authorRequest: "Find something, then write it up." });
  assert.equal(made.body.ok, true);
  assert.equal(made.body.suggested, "scout");

  // The operator then types a name; the UI renames the digraph the way the DOT editor does, so the save is accepted.
  const renamed = made.body.dot.replace('digraph "scout"', 'digraph "finder"');
  const saved = await post({ team: "finder", authorDot: renamed });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.name, "finder");
  assert.match(readFileSync(path.join(root, ".ai-collab", "teams", "finder", "team.dot"), "utf8"), /^digraph "finder"/);

  // Typing the name of a team that already exists is refused once, so the UI can offer Replace instead of a dead end.
  const taken = await post({ team: "finder", authorDot: renamed });
  assert.equal(taken.status, 400);
  assert.match(taken.body.error, /already exists/);
  const replaced = await post({ team: "finder", authorDot: renamed, authorReplace: "finder" });
  assert.equal(replaced.status, 201);
});

test("the Patterns page action edits only an existing project roster", async (t) => {
  const { post, home } = await ui(t);
  const config = path.join(home, ".config", "ai-collab");
  const projectsFile = path.join(config, "projects.json");
  const [project] = JSON.parse(readFileSync(projectsFile, "utf8"));
  writeFileSync(projectsFile, JSON.stringify([{ ...project, teams: { local: ["codex"] } }]));
  writeFileSync(path.join(config, "teams.json"), JSON.stringify({ shared: ["claude"] }));

  const edit = (team, members) => post({ editTeam: true, team, members });
  const saved = await edit("local", ["claude", "codex:gpt-5"]);
  assert.equal(saved.status, 201);
  assert.deepEqual(saved.body.members, ["claude", "codex:gpt-5"]);
  for (const [name, members] of [
    ["local", []],
    ["local", ["claude", "claude"]],
    ["local", ["codex:unknown"]],
    ["shared", ["codex"]],
    ["missing", ["codex"]],
  ]) {
    assert.equal((await edit(name, members)).status, 400);
  }
  assert.deepEqual(JSON.parse(readFileSync(projectsFile, "utf8"))[0].teams, { local: ["claude", "codex:gpt-5"] });
});
