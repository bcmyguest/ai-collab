import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { parseDot } from "../lib/catalog/dot.ts";
import { checkTeamText, listPatterns } from "../lib/patterns.mjs";
import { AUTHOR_PROMPT_MAX, authorCommand, authorHarness, authorModel, authorTeam, buildAuthorPrompt, draftTeam, extractDot, saveAuthoredTeam } from "../lib/catalog/author.ts";
import { tempDir } from "./helpers/tmp.mjs";

const MODELS = { claude: ["claude-haiku-5-5"], codex: ["gpt-5"], cursor: ["deepseek-v41-flash-1017-high"] };

function setup() {
  const home = tempDir({ after }, "ai-collab-team-author-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env), root, globalDir: path.join(home, ".config", "ai-collab", "teams") };
}

// What a writing agent answers: prose, one ```dot block, more prose.
const REPLIES = {
  scout: `Here is the team you asked for.

\`\`\`dot
digraph "scout" {
  graph [description="Look something up, then write it down."];
  researcher [agent="cursor:deepseek-v41-flash-1017-high", prompt="Find the answer and hand the sources to the writer."];
  writer     [agent="claude:claude-haiku-5-5", prompt="Write the answer for the operator."];
  researcher -> writer [on="sources", kind="pair", required=true];
  writer     -> done   [on="written", kind="pair", required=true];
}
\`\`\`

Save it as scout.`,
};

test("the prompt carries the request, the name, the scope and the DOT contract", () => {
  const text = buildAuthorPrompt({ request: "  Find things,   then write them up.  ", name: "scout", scope: "global", peers: ["claude", "cursor"] });
  assert.match(text, /digraph "scout"/);
  assert.match(text, /Team name: scout/);
  assert.match(text, /Scope: global/);
  assert.match(text, /Operator request:\nFind things, then write them up\./);
  assert.match(text, /This project may run: claude, cursor\./);
  assert.match(text, /required=true means the run cannot finish without it/);
  assert.match(text, /This project may run: claude, cursor\./);
  assert.doesNotMatch(text, /This project may run: [^\n]*codex/, "only the project's peers are named");
});

test("the prompt shows the team being edited and the chat so far", () => {
  const current = 'digraph "scout" {\n  a [agent="claude", prompt="A."];\n  a -> done [on="x"];\n}\n';
  const text = buildAuthorPrompt({
    request: "Add a reviewer before done.", name: "scout", current,
    turns: [{ from: "operator", text: "Two roles please." }, { from: "agent", text: "Done. ```dot digraph ...```" }],
  });
  assert.match(text, /The team as it is now; change only what the request asks for:/);
  assert.match(text, /digraph "scout" \{/);
  assert.match(text, /Conversation so far, oldest first:\nOperator: Two roles please\./);
  assert.match(text, /New request from the operator:\nAdd a reviewer before done\./);
});

test("a long request, history and current team still make one start prompt", () => {
  const text = buildAuthorPrompt({
    request: "x".repeat(3000), name: "scout",
    current: `digraph "scout" {\n${'  // padding line\n'.repeat(80)}}`,
    turns: Array.from({ length: 9 }, (_, i) => ({ from: "operator", text: `${i} `.concat("y".repeat(1000)) })),
  });
  assert.ok(text.length <= AUTHOR_PROMPT_MAX, `brief is ${text.length} characters`);
  assert.match(text, /Team name: scout/, "the name survives the trimming");
  assert.match(text, /The file must pass these checks:/, "the contract survives the trimming");
});

test("the DOT is pulled out of prose and round-trips through the same check the save uses", () => {
  const { env, cfg } = setup();
  assert.equal(extractDot(REPLIES.scout), REPLIES.scout.split("```dot\n")[1].split("```")[0].trim());
  const draft = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  assert.equal(draft.ok, true);
  assert.equal(draft.exists, "");
  assert.equal(draft.pattern.roles[1].harness, "claude");
  assert.equal(draft.pattern.handoffs[0].required, true);
  assert.equal(parseDot(draft.dot).name, "scout");
  assert.equal(checkTeamText(cfg, "scout", draft.dot).ok, true);
});

test("a bare digraph with no fence is accepted, and an answer with no DOT is refused", () => {
  const { env, cfg } = setup();
  const bare = 'digraph "scout" {\n  a [agent="claude", prompt="A."];\n  a -> done [on="x"];\n}';
  const draft = draftTeam(cfg, { name: "scout", reply: `Sure:\n\n${bare}\n\nThanks.`, env });
  assert.equal(draft.ok, true);
  assert.equal(draft.dot, bare);
  const empty = draftTeam(cfg, { name: "scout", reply: "I would rather not.", env });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no DOT block/);
});

test("invalid DOT is refused with the parser's line, and nothing is written", async () => {
  const { env, cfg, root, globalDir } = setup();
  const bad = REPLIES.scout.replace('agent="claude:claude-haiku-5-5"', 'agent="gemini"');
  const draft = draftTeam(cfg, { name: "scout", reply: bad, env });
  assert.equal(draft.ok, false);
  assert.equal(draft.line, 4);
  assert.match(draft.error, /^line 4: agent harness must be one of/);
  await assert.rejects(saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, env, models: MODELS }), /agent harness must be one of/);
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout", "team.dot")), false);
  assert.equal(existsSync(path.join(globalDir, "scout", "team.dot")), false);
});

test("a name that differs from the digraph is refused by the same check", () => {
  const { env, cfg } = setup();
  const draft = draftTeam(cfg, { name: "other", reply: REPLIES.scout, env });
  assert.equal(draft.ok, false);
  assert.match(draft.error, /must match "other"/);
});

test("with no name yet, the digraph name the agent wrote is the proposal that gets checked", () => {
  const { env, cfg } = setup();
  const draft = draftTeam(cfg, { name: "", reply: REPLIES.scout, env });
  assert.equal(draft.ok, true, draft.error);
  assert.equal(draft.suggested, "scout");
  assert.equal(draft.name, "scout");
  assert.equal(draft.pattern.name, "scout");
});

test("a validated draft saves as a project team and reads back from the pattern list", async () => {
  const { env, cfg, root } = setup();
  const draft = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  const saved = await saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, scope: "project", env, models: MODELS });
  assert.equal(saved.source, "project");
  const file = path.join(root, ".ai-collab", "teams", "scout", "team.dot");
  assert.equal(saved.file, file);
  assert.equal(readFileSync(file, "utf8"), `${draft.dot.trimEnd()}\n`);
  const listed = listPatterns(cfg, env).scout;
  assert.equal(listed.source, "project");
  assert.deepEqual(listed.roles.map((role) => role.id), ["researcher", "writer"]);
});

test("global scope saves under the config directory, not inside the project", async () => {
  const { env, cfg, root, globalDir } = setup();
  const draft = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  const saved = await saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, scope: "global", env, models: MODELS });
  assert.equal(saved.source, "global");
  assert.equal(saved.file, path.join(globalDir, "scout", "team.dot"));
  assert.equal(existsSync(path.join(root, ".ai-collab", "teams", "scout", "team.dot")), false);
  assert.equal(listPatterns(cfg, env).scout.source, "global");
});

test("an existing name is refused until the replacement is confirmed, and the file stays as it was", async () => {
  const { env, cfg, root } = setup();
  const file = path.join(root, ".ai-collab", "teams", "scout", "team.dot");
  const first = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  await saveAuthoredTeam(cfg, { name: "scout", dot: first.dot, env, models: MODELS });
  const before = readFileSync(file, "utf8");
  const changed = first.dot.replace('"digraph "scout"', '"digraph "scout"').replace("Find the answer", "Find the answer twice");
  const draft = draftTeam(cfg, { name: "scout", reply: `\`\`\`dot\n${changed}\n\`\`\``, env });
  assert.equal(draft.ok, true);
  assert.equal(draft.exists, "project", "the draft names the entry it would replace");

  await assert.rejects(saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, env, models: MODELS }), /already exists; confirm the replacement/);
  assert.equal(readFileSync(file, "utf8"), before);

  await saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, replace: "scout", env, models: MODELS });
  assert.match(readFileSync(file, "utf8"), /Find the answer twice/);
});

test("a built-in name and a legacy team name are refused", async () => {
  const { env, cfg } = setup();
  const fix = readFileSync(new URL("../lib/team-templates/fix-and-review/team.dot", import.meta.url), "utf8");
  await assert.rejects(saveAuthoredTeam(cfg, { name: "fix-and-review", dot: fix, env, models: MODELS }), /built-in pattern/);

  const file = path.join(env.HOME, ".config", "ai-collab", "projects.json");
  const projects = JSON.parse(readFileSync(file, "utf8"));
  projects[0].teams = { crew: ["codex"] };
  writeFileSync(file, JSON.stringify(projects));
  const solo = 'digraph "crew" {\n  a [agent="codex", prompt="A."];\n  a -> done [on="x"];\n}';
  await assert.rejects(saveAuthoredTeam(cfg, { name: "crew", dot: solo, env, models: MODELS }), /is a team name/);
  assert.equal(listPatterns(cfg, env).crew.source, "team");
});

test("saving the same name into the other scope is refused instead of silently shadowing", async () => {
  const { env, cfg } = setup();
  const draft = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  await saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, scope: "global", env, models: MODELS });
  await assert.rejects(saveAuthoredTeam(cfg, { name: "scout", dot: draft.dot, replace: "scout", scope: "project", env, models: MODELS }), /is a global team/);
});

test("a save outside the teams directories is impossible: the name decides the folder", async () => {
  const { env, cfg } = setup();
  const draft = draftTeam(cfg, { name: "scout", reply: REPLIES.scout, env });
  for (const name of ["../escape", "a/b", "UPPER", "-lead", "a".repeat(25), ""]) {
    await assert.rejects(saveAuthoredTeam(cfg, { name, dot: draft.dot, env, models: MODELS }), /1-24 chars/);
  }
});

test("one authoring turn builds the brief, asks the writer, and checks what comes back", async () => {
  const { env, cfg } = setup();
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    // The brief is one argv element; nothing is split or shell-quoted.
    assert.equal(args.at(-1), args.at(-1).trim());
    assert.match(args.at(-1), /Operator request:\nReview a change, then land it\./);
    return { code: 0, stdout: `Sure.\n${REPLIES.scout.split("```dot\n")[1].split("```")[0].trim()}\n` };
  };
  const made = await authorTeam(cfg, { request: "Review a change, then land it.", name: "scout", env, harness: "cursor", model: "deepseek-v41-flash-1017-high", run, peers: ["cursor"] });
  assert.equal(made.status, "answered");
  assert.equal(made.ok, true);
  assert.match(calls[0].file, /cursor-agent$/);
  assert.deepEqual(calls[0].args.slice(0, 4), ["-p", "--trust", "--model", "deepseek-v41-flash-1017-high"]);
  assert.equal(made.pattern.roles.length, 2);
  assert.equal(existsSync(path.join(env.HOME, "repo", ".ai-collab", "teams", "scout")), false, "an authoring turn writes nothing");
});

test("a writing agent that fails or answers no DOT reports it without writing", async () => {
  const { env, cfg } = setup();
  const broken = await authorTeam(cfg, { request: "x", name: "scout", env, run: async () => ({ code: 2, stdout: "boom" }) });
  assert.equal(broken.status, "failed");
  assert.match(broken.detail, /exited 2: boom/);
  const empty = await authorTeam(cfg, { request: "x", name: "scout", env, run: async () => ({ code: 0, stdout: "No idea, sorry." }) });
  assert.equal(empty.status, "answered");
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no DOT block/);
});

test("the writing agent's harness and model come from the env, defaulting to cursor deepseek", () => {
  assert.deepEqual(authorModel({}), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  assert.deepEqual(authorModel({ AI_COLLAB_TEAM_AUTHOR_MODEL: "claude:claude-haiku-5-5" }), { harness: "claude", model: "claude-haiku-5-5" });
  assert.deepEqual(authorModel({ AI_COLLAB_TEAM_AUTHOR_MODEL: "codex" }), { harness: "codex", model: "" });
  assert.deepEqual(authorModel({ AI_COLLAB_TEAM_AUTHOR_MODEL: "gemini" }), { harness: "cursor", model: "deepseek-v41-flash-1017-high" });
  assert.deepEqual(authorCommand("opencode", "brief", "openai/gpt-5"), ["opencode", ["run", "-m", "openai/gpt-5", "brief"]]);
  assert.equal(authorCommand("nope", "brief"), null);
});

test("a project without the configured writer harness falls back to one it can run", () => {
  // The default writer is cursor; on a machine with only codex installed, codex writes and no model is passed.
  assert.deepEqual(authorHarness({}, ["codex"]), { harness: "codex", model: "" });
  assert.deepEqual(authorHarness({}, ["cursor", "codex"]), { harness: "cursor", model: "deepseek-v41-flash-1017-high" }, "the configured harness wins when it is installed");
  assert.deepEqual(authorHarness({}, []), { harness: "cursor", model: "deepseek-v41-flash-1017-high" }, "no harness list means no fallback");
  assert.deepEqual(authorHarness({ AI_COLLAB_TEAM_AUTHOR_MODEL: "claude:claude-haiku-5-5" }, ["codex"]), { harness: "codex", model: "" });
});
