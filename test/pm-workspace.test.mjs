import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { refreshPmWorkspace } from "../lib/pm-workspace.mjs";
import { loadSchedules, tickFn } from "../runner/schedules.mjs";
import { tempDir } from "./helpers/tmp.mjs";

// The user's global push.pushOption makes pushes to the local test remote fail.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";

const ID = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
const mission = (line) => `# T\n\n${line}\n\n## Goals\n\n- [ ] A\n\n## Rules\n\n- R\n`;

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...ID, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function originAndSource() {
  const root = tempDir({ after }, "ai-collab-pm-src-");
  const bare = path.join(root, "bare.git");
  const seed = path.join(root, "seed");
  const source = path.join(root, "source");
  mkdirSync(bare);
  spawnSync("git", ["init", "--bare", "--quiet", "--template=", "-b", "main", bare], { encoding: "utf8" });
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--template=", "-b", "main");
  writeFileSync(path.join(seed, "MISSION.md"), "base\n");
  git(seed, "add", "MISSION.md");
  git(seed, "commit", "--quiet", "-m", "base");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  spawnSync("git", ["clone", "--quiet", bare, source], { encoding: "utf8" });
  writeFileSync(path.join(source, "NOTES"), "source dirty\n");
  return { bare, seed, source };
}

test("a pm tick with workspace runs there and appends that directory's mission, not the host project's", async (t) => {
  const home = tempDir(t, "ai-collab-pm-tick-");
  const host = path.join(home, "host");
  const workspace = path.join(home, "workspace");
  mkdirSync(host);
  mkdirSync(workspace);
  mkdirSync(path.join(home, ".config", "ai-collab"), { recursive: true });
  writeFileSync(path.join(home, ".config", "ai-collab", "projects.json"), JSON.stringify([{ root: host, project: "demo" }]));
  writeFileSync(path.join(host, "MISSION.md"), mission("HOST PROJECT MISSION"));
  writeFileSync(path.join(workspace, "MISSION.md"), mission("WORKSPACE MISSION"));
  const bin = path.join(host, "cursor-agent");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, HOME: home, AI_COLLAB_STATE_DIR: path.join(home, "state"), AI_COLLAB_SCOPE: "off" };
  const wf = { step: async (_name, fn) => fn(), signal: undefined };
  const projects = [{ root: host, project: "demo" }];
  const run = (entry) => tickFn(entry, { env, projects, log: () => {} })(new Date(0), new Date(0), wf);

  const withWorkspace = JSON.parse((await run({
    name: "pm", everyMs: 60_000, cwd: host, workspace, command: [bin, "-p", "PM tick"], timeoutMs: 10_000,
  })).tail);
  assert.equal(withWorkspace.cwd, workspace);
  assert.match(withWorkspace.args.at(-1), /WORKSPACE MISSION/);
  assert.equal(withWorkspace.args.at(-1).includes("HOST PROJECT MISSION"), false);

  const plain = JSON.parse((await run({
    name: "pm", everyMs: 60_000, cwd: host, command: [bin, "-p", "PM tick"], timeoutMs: 10_000,
  })).tail);
  assert.equal(plain.cwd, host);
  assert.match(plain.args.at(-1), /HOST PROJECT MISSION/);
});

test("a dirty PM clone is not overwritten", () => {
  const { bare, seed, source } = originAndSource();
  const workspace = path.join(path.dirname(source), "pm");
  const calls = [];
  const logs = [];
  const run = (file, args, opts) => {
    calls.push(args);
    return spawnSync(file, args, opts);
  };
  const refresh = () => refreshPmWorkspace(workspace, { source, run, log: (line) => logs.push(line) });

  const sourceHead = git(source, "rev-parse", "HEAD");
  const created = refresh();
  assert.equal(created.cloned, true);
  assert.equal(statSync(path.join(workspace, ".git")).isDirectory(), true);
  assert.equal(readFileSync(path.join(workspace, "MISSION.md"), "utf8"), "base\n");
  assert.equal(readFileSync(path.join(source, "NOTES"), "utf8"), "source dirty\n");
  assert.equal(git(source, "rev-parse", "HEAD"), sourceHead);

  writeFileSync(path.join(seed, "MISSION.md"), "second\n");
  git(seed, "add", "MISSION.md");
  git(seed, "commit", "--quiet", "-m", "second");
  git(seed, "push", "--quiet", "origin", "main");
  const pulled = refresh();
  assert.equal(pulled.ok, true);
  assert.equal(git(workspace, "rev-parse", "HEAD"), git(bare, "rev-parse", "main"));
  assert.equal(readFileSync(path.join(workspace, "MISSION.md"), "utf8"), "second\n");

  const kept = git(workspace, "rev-parse", "HEAD");
  writeFileSync(path.join(workspace, "MISSION.md"), "local edit\n");
  writeFileSync(path.join(seed, "MISSION.md"), "third\n");
  git(seed, "add", "MISSION.md");
  git(seed, "commit", "--quiet", "-m", "third");
  git(seed, "push", "--quiet", "origin", "main");
  logs.length = 0;
  const left = refresh();
  assert.equal(left.dirty, true);
  assert.match(logs.join("\n"), /dirty; left it/);
  assert.equal(readFileSync(path.join(workspace, "MISSION.md"), "utf8"), "local edit\n");
  assert.equal(git(workspace, "rev-parse", "HEAD"), kept);
  assert.equal(readFileSync(path.join(source, "NOTES"), "utf8"), "source dirty\n");
  for (const args of calls) {
    assert.equal(/\b(reset|checkout)\b/.test(args.join(" ")), false, args.join(" "));
  }
  assert.deepEqual(calls.filter((args) => args.includes(source)).map((args) => args.slice(0, 3)), [["-C", source, "remote"]]);
});

test("loadSchedules accepts the workspace key", (t) => {
  const dir = tempDir(t, "ai-collab-pm-sched-");
  const file = path.join(dir, "schedules.json");
  const workspace = path.join(dir, "not-created-yet");
  writeFileSync(file, JSON.stringify([{
    name: "pm", everyMinutes: 30, cwd: dir, command: ["cursor-agent", "-p", "tick"], workspace,
  }]));
  const loaded = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.entries[0].workspace, workspace);
  assert.equal(loaded.entries[0].cwd, dir);

  writeFileSync(file, JSON.stringify([{ name: "pm", everyMinutes: 30, cwd: dir, command: ["x"], workspace: "relative" }]));
  const relative = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.match(relative.errors[0], /workspace must be an absolute path/);

  writeFileSync(file, JSON.stringify([{ name: "pm", everyMinutes: 30, cwd: dir, command: ["x"], extra: 1 }]));
  const unknown = loadSchedules({ AI_COLLAB_SCHEDULES: file });
  assert.match(unknown.errors[0], /unknown key extra/);
});
