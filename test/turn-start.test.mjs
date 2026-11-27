// A working thread's time runs from its session's turn start, which the snapshot carries per session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, sessionLabel } from "../lib/config.mjs";
import { publishActivity } from "../lib/activity.ts";
import { recordSession } from "../lib/sessions.mjs";
import { createUi } from "../web/server/ui.mjs";
import { turnStarts } from "../web/lib/activity-rows.js";
import { threadGroups, workingTime } from "../web/lib/thread-groups.ts";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const NOW = 1_800_000_000_000;

test("a turn starts at the first prompt after the session's last stop", () => {
  const rows = [
    { agent: "a#1", type: "prompt", time: 100 }, { agent: "a#1", type: "stop", time: 200 },
    { agent: "a#1", type: "prompt", time: 300 }, { agent: "a#1", type: "tool_call", time: 310 },
    { agent: "a#1", type: "prompt", time: 320 },
    { agent: "b#2", type: "prompt", time: 50 }, { agent: "b#2", type: "stop", time: 60 },
  ];
  assert.deepEqual([...turnStarts(rows)], [["a#1", 300_000]]);
});

test("a working thread's time runs from its earliest turn start, not its open tool call", () => {
  const [row] = threadGroups([{ id: "th_1", sessions: ["a#1", "b#2"] }], [
    { id: "a#1", turnStartAt: NOW - 7 * 60_000, openCallAt: NOW - 10_000 },
    { id: "b#2", turnStartAt: NOW - 3 * 60_000, lastActivityAt: NOW - 1000 },
  ], NOW).working;
  assert.equal(workingTime(row, NOW), "7m");
});

test("the snapshot carries each session's turn start until the turn stops", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const stateDir = tempDir(t, "ai-collab-turn-");
  const folder = path.join(tempDir(t, "ai-collab-turn-root-"), "webapp");
  mkdirSync(folder);
  const env = peer => peerEnv(fake, { peer, stateDir, AI_COLLAB_PROJECT: "demo", AI_COLLAB_PEERS: "claude" });
  const id = "22222222-0000-4000-8000-000000000001";
  const claude = { ...loadConfig(env("claude")), session: sessionLabel(id) };
  await recordSession(claude, { id, cwd: folder, harness: "claude", event: "SessionStart" });
  await publishActivity(claude, "claude", [{ type: "prompt", input: "Fix the reconnect test" }, { type: "tool_call", tool: "Bash", input: { command: "npm test" }, callId: "c1" }]);

  const ui = createUi({ projects: [loadConfig(env("operator"))] });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const address = `claude#${claude.session}`;
  const stream = sse(ui.events(new Request("http://127.0.0.1:8795/api/events?project=demo", { signal: ctrl.signal })));
  const next = async check => {
    // Pulls frames by hand: a for-await that returns would close the stream for the next wait.
    for (let frame = await stream.next(); !frame.done; frame = await stream.next()) {
      const { event, data } = frame.value;
      if (event === "state" && check(data.agents?.find(agent => agent.id === address))) return data;
    }
    throw new Error("stream ended");
  };
  const started = (await next(agent => agent?.turnStartAt > 0)).agents.find(agent => agent.id === address);
  assert.ok(started.turnStartAt <= started.lastActivityAt, "the turn starts at the prompt, before the tool call");
  await publishActivity(claude, "claude", [{ type: "stop" }]);
  await next(agent => agent && agent.turnStartAt === undefined);
});
