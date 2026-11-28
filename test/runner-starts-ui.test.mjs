import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadProjects } from "../lib/config.ts";
import { createUi } from "../web/server/ui.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const base = "http://127.0.0.1:8795";
const ID = "44444444-2222-4333-8444-555555555555";
const FAKE = (name) => `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_RECORD + "/${name}.jsonl", JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
console.log(JSON.stringify({ session_id: "${ID}" }));
console.log("Started background session ${ID}");
`;

async function setup(t) {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const home = tempDir({ after }, "ai-collab-runner-starts-");
  const bin = path.join(home, "bin");
  const root = path.join(home, "project");
  const record = path.join(home, "record");
  const runtime = path.join(home, "run");
  for (const dir of [bin, root, record, path.join(root, ".git"), path.join(home, ".config", "ai-collab"), path.join(runtime, "ai-collab")]) mkdirSync(dir, { recursive: true });
  for (const name of ["claude", "cursor-agent", "git"]) {
    writeFileSync(path.join(bin, name), FAKE(name));
    chmodSync(path.join(bin, name), 0o755);
  }
  writeFileSync(path.join(runtime, "ai-collab", "runner.sock"), "");
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root, project: "demo", url: fake.url, peers: "claude,cursor" }]));
  writeFileSync(path.join(home, ".config", "ai-collab", "defaults.json"), JSON.stringify({ startPlace: "folder" }));
  const env = { HOME: home, PATH: bin + path.delimiter + path.dirname(process.execPath), FAKE_RECORD: record, XDG_RUNTIME_DIR: runtime, AI_COLLAB_STATE_DIR: path.join(home, "state") };
  const starts = [];
  const runner = () => ({ start: async (input) => { starts.push(input); return { status: 201, body: { status: "started", session: "cursor#0123456789abcdef" } }; } });
  const ui = createUi({ projects: loadProjects(env, { host: "operator" }), env, runner, runnerStarts: true });
  t.after(() => ui.close());
  const post = async (body) => {
    const response = await ui.handle(new Request(`${base}/api/start`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }), "start");
    return { status: response.status, body: await response.json() };
  };
  return { post, starts, record };
}

async function recorded(record, name) {
  for (let i = 0; i < 200; i++) {
    const file = path.join(record, name + ".jsonl");
    if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    await delay(20);
  }
  throw new Error("fake " + name + " never ran");
}

test("a non-Claude agent start is a runner session; Claude and plan-mode starts stay CLI runs", async (t) => {
  const { post, starts, record } = await setup(t);

  const agent = await post({ project: "demo", harness: "cursor", prompt: "review the code", place: "folder" });
  assert.equal(agent.status, 201);
  assert.equal(agent.body.session, "cursor#0123456789abcdef");
  assert.deepEqual(starts, [{ project: "demo", harness: "cursor", prompt: "review the code", place: "folder", system: false }]);

  await delay(10_100);
  const plan = await post({ project: "demo", harness: "cursor", prompt: "plan it", place: "folder", startMode: "plan" });
  assert.equal(plan.status, 201);
  assert.equal(starts.length, 1);
  assert.ok((await recorded(record, "cursor-agent"))[0].argv.includes("plan"));

  await delay(10_100);
  const claude = await post({ project: "demo", harness: "claude", prompt: "fix it", place: "folder" });
  assert.equal(claude.status, 201);
  assert.equal(starts.length, 1);
  assert.equal((await recorded(record, "claude")).length, 1);
});
