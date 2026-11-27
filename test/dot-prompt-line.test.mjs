import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, after } from "node:test";
import { loadConfig } from "../lib/config.mjs";
import { checkTeamText, listPatterns } from "../lib/patterns.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function setup() {
  const home = tempDir({ after }, "ai-collab-dot-prompt-");
  const root = path.join(home, "repo");
  mkdirSync(root);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: "http://127.0.0.1:9", peers: "claude,codex,cursor" },
  ]));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEER: "operator", AI_COLLAB_PEERS: "claude,codex,cursor", AI_COLLAB_URL: "http://127.0.0.1:9" };
  return { env, cfg: loadConfig(env), root };
}

const FULL = `digraph pipe {
  a [agent="claude", prompt="A."];
  b [agent="codex", prompt="B."];
  a -> b [on="go"];
  b -> done [on="finish"];
}
`;

test("checkTeamText reports the line of a node that has no prompt", () => {
  const { cfg } = setup();
  const missing = checkTeamText(cfg, "pipe", FULL.replace(', prompt="B."', ""));
  assert.equal(missing.ok, false);
  assert.equal(missing.line, 3);
  assert.match(missing.error, /^line 3: role "b" needs a prompt$/);
  assert.equal(checkTeamText(cfg, "pipe", FULL).ok, true, "a full team still checks");
});

test("a team file without a prompt lists as invalid with its line", () => {
  const { env, cfg, root } = setup();
  const dir = path.join(root, ".ai-collab", "teams", "pipe");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "team.dot"), FULL.replace(', prompt="B."', ""));
  assert.equal(listPatterns(cfg, env).pipe.invalid, 'line 3: role "b" needs a prompt');
});
