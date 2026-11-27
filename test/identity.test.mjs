import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { claimInbox, sendMessage } from "../lib/inbox.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("Cursor can send as its conversation without setting identity variables", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const root = tempDir(t, "ai-collab-identity-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "ai-collab"));
  writeFileSync(join(root, "ai-collab", "projects.json"), JSON.stringify([
    { root, project: "demo", url: fake.url, peers: "operator,cursor" },
  ]));
  const env = { XDG_CONFIG_HOME: root, XDG_STATE_HOME: root };
  const first = loadConfig({ ...env, CURSOR_CONVERSATION_ID: "first-cursor" }, { cwd: root });
  const second = loadConfig({ ...env, CURSOR_CONVERSATION_ID: "second-cursor" }, { cwd: root });
  const operator = loadConfig({ ...env, AI_COLLAB_PEER: "operator" }, { cwd: root });
  assert.equal(first.peer, "cursor");
  assert.equal(first.session, sessionLabel("first-cursor"));
  assert.notEqual(first.session, second.session);
  await sendMessage(first, "all", "Hello from Cursor");
  assert.match(fake.state.publishes.at(-1).title, /^ai-collab from cursor#[a-f0-9]{16}$/);
  assert.equal((await claimInbox(operator))[0].from, `cursor#${first.session}`);

  await sendMessage(operator, `cursor#${second.session}`, "For the second session");
  assert.deepEqual((await claimInbox(first)).map(({ body }) => body), []);
  assert.deepEqual((await claimInbox(second)).map(({ body }) => body), [
    "For the second session",
  ]);
});
