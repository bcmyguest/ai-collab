// Live host smoke. See docs/sandbox-smoke.md for credential and gateway setup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import { parseWireEnvelope } from "../lib/agui.mjs";
import { builderPaths } from "../lib/builder.ts";
import { activityTopic } from "../lib/config.mjs";
import { cursorBinary, findExecutable } from "../lib/start.mjs";
import { openTasks } from "../lib/tasks.mjs";
import { runnerClient, runnerRequest } from "../runner/client.ts";
import { destroySandbox, parseSandboxList, runTool, sandboxName } from "../runner/sandbox.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "scripts", "ai-collab.mjs");
const credentials = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
  cursor: ".config/cursor/auth.json",
  opencode: ".local/share/opencode/auth.json",
};
const cases = Object.keys(credentials).flatMap(harness => [
  ["builder", harness],
  ["scheduled", harness],
]);
cases.push(["runner-owned", "cursor"], ["builder-owned", "codex"]);

const enabled = process.env.AI_COLLAB_LIVE_SANDBOX === "1";
const selection = process.env.AI_COLLAB_LIVE_CASES?.split(",").map(value => value.trim());
const waitMs = 10 * 60_000;

async function until(description, check, timeout = waitMs) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

function stageLogin(source, home, harness) {
  const relative = credentials[harness];
  const input = join(source, relative);
  const info = statSync(input);
  assert.ok(info.isFile() && info.size && !(info.mode & 0o077), `Use a private, nonempty disposable login at ${relative}`);
  const output = join(home, relative);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  copyFileSync(input, output);
  chmodSync(output, 0o600);
}

function scheduleCommand(harness, binary, model, prompt) {
  const args = {
    cursor: ["-p", "--force", "--trust", "--sandbox", "disabled"],
    claude: ["-p", "--tools", "", "--setting-sources", ""],
    codex: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
    opencode: ["run", "--standalone", "--format", "json"],
  };
  return [binary, ...args[harness], "--model", model, prompt];
}

async function runCase(launch, harness) {
  const source = process.env.AI_COLLAB_LIVE_CREDENTIALS;
  assert.ok(source, "Set AI_COLLAB_LIVE_CREDENTIALS to the disposable credential directory");
  const model = process.env[`AI_COLLAB_LIVE_MODEL_${harness.toUpperCase()}`];
  assert.ok(model, `Set AI_COLLAB_LIVE_MODEL_${harness.toUpperCase()} to an authenticated model`);
  const path = process.env.PATH;
  const binary = harness === "cursor" ? cursorBinary(path) : harness;
  assert.ok(findExecutable(binary, path), `Install ${binary} on PATH`);
  const openshell = findExecutable("openshell", path);
  assert.ok(openshell, "Install OpenShell on the smoke host");

  const home = tempDir({ after }, "aic-live-");
  const root = join(home, "project");
  const config = join(home, ".config", "ai-collab");
  const id = randomBytes(4).toString("hex");
  const project = `sm-${id}`;
  const schedule = id;
  const socket = join(home, "runner.sock");
  const env = {
    PATH: path, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`,
    ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
    AI_COLLAB_RUNNER_SOCKET: socket,
    AI_COLLAB_RUNNER_HARNESSES: launch === "scheduled" ? "none" : harness,
    TMPDIR: tmpdir(),
  };
  const paths = builderPaths(project, env);
  const client = runnerClient({ socket, timeoutMs: 240_000 });
  const marker = randomBytes(8).toString("hex");
  const prompt = `Reply with only the concatenation of ${marker.slice(0, 8)} and ${marker.slice(8)}. Do not use tools or modify files.`;
  const builder = launch.startsWith("builder");
  const owned = launch.endsWith("owned");
  const matchesSandbox = name => builder ? name === paths.sandbox
    : owned ? name === sandboxName(project) : name.startsWith(`s-${schedule}-`);
  let ntfy, runner, exited, address, runnerEnded = false, armed = false;

  const command = (bin, args, timeoutMs = 60_000) => runTool(bin, args, { env, cwd: root, timeoutMs });
  const checked = async (bin, args, timeoutMs) => {
    const result = await command(bin, args, timeoutMs);
    assert.equal(result.code, 0, `${bin} ${args.slice(0, 2).join(" ")} failed (exit ${result.code})`);
    return result.stdout;
  };
  const sandboxes = async () => parseSandboxList(await checked(openshell, ["sandbox", "list", "-o", "json"]))
    .map(item => item?.name).filter(Boolean);
  const state = () => existsSync(paths.state) && JSON.parse(readFileSync(paths.state, "utf8"));

  try {
    stageLogin(source, home, harness);
    mkdirSync(config, { recursive: true });
    mkdirSync(root);
    ntfy = await startFakeNtfy();
    writeFileSync(join(config, "defaults.json"), JSON.stringify({ url: ntfy.url, codeMode: false }));
    writeFileSync(join(config, "projects.json"), JSON.stringify([{ root, project, url: ntfy.url }]));
    await checked("git", ["init", "-q", "-b", "main"]);
    await checked("git", ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "--allow-empty", "-qm", "Initial commit"]);
    const originalHead = await checked("git", ["rev-parse", "HEAD"]);
    await checked("git", ["config", "user.name", "Smoke"]);
    await checked("git", ["config", "user.email", "smoke@example.invalid"]);
    assert.ok(!(await sandboxes()).some(matchesSandbox), "Smoke sandbox name already exists");
    armed = true;

    if (launch === "scheduled") {
      writeFileSync(join(config, "schedules.json"), JSON.stringify([{
        name: schedule, everyMinutes: 525_600, timeoutSec: 540, cwd: root, sandbox: true,
        command: scheduleCommand(harness, binary, model, prompt),
      }]));
    }
    if (launch !== "builder") {
      runner = spawn(process.execPath, [join(repo, "runner", "main.mjs")], { cwd: root, env, stdio: "ignore" });
      exited = new Promise(resolve => {
        runner.once("exit", resolve);
        runner.once("error", resolve);
      }).then(() => { runnerEnded = true; });
      await until("runner control socket", async () => {
        assert.ok(!runnerEnded, "Runner exited during startup");
        return await client.health().then(result => result.status === 200, () => false);
      }, 30_000);
    }

    if (builder) {
      await openTasks(project, env).add({ id: project, title: "Sandbox smoke" });
      const brief = join(home, "brief.md");
      writeFileSync(brief, prompt);
      const output = await checked(process.execPath, [cli, "builder", "start", "--task", project, "--harness", harness, "--model", model, "--brief", brief], 250_000);
      assert.equal(state().owned, owned, "Builder used the wrong launch path");
      if (owned) address = output.trim().split("\t")[0];
    } else if (owned) {
      const { status, body } = await client.start({ project, harness, place: "openshell", model, prompt, codeMode: false, permissionMode: "full-access" });
      assert.equal(status, 201, `Runner start returned HTTP ${status}`);
      address = body.session;
    }

    if (owned) {
      assert.match(address, new RegExp(`^${harness}#`));
      const [, session] = address.split("#");
      await until("successful turn and assistant output in session activity", () => {
        const rows = ntfy.state.publishes.filter(item => item.topic === activityTopic(project))
          .map(item => parseWireEnvelope(item.message)).filter(row => row?.session === session && row.from === harness);
        assert.ok(!rows.some(row => row.type === "stop" && row.input === "turn ended · failed"), "Runner turn failed");
        return rows.some(row => row.type === "stop" && row.input === "turn ended")
          && rows.filter(row => row.type === "text").map(row => row.output).join("").includes(marker);
      });
      if (!builder) {
        assert.ok((await sandboxes()).includes(sandboxName(project)), "Owned session has no OpenShell sandbox");
        assert.equal((await client.close(address)).status, 200);
        address = undefined;
      }
    } else if (launch === "scheduled") {
      const runs = async () => {
        const response = await runnerRequest("GET", `/v1/schedules/${schedule}/runs`, undefined, { socket });
        assert.equal(response.status, 200);
        return response.body;
      };
      // The service normally fires the current tick on boot. Trigger one manually if boot lands just before a boundary.
      let run = (await runs())[0];
      if (!run) {
        const { status, body } = await client.runSchedule(schedule, "sandbox-smoke");
        assert.equal(status, 202);
        run = { id: body.id };
      }
      const finished = await until("scheduled run history", async () =>
        (await runs()).find(item => item.id === run.id && item.finishedAt));
      assert.equal(finished.output?.ok, true, "Scheduled harness failed");
      assert.ok(finished.output.tail.includes(marker), "Assistant output missing from scheduled run history");
      assert.match(finished.output.tail, new RegExp(`sandbox s-${schedule}-[0-9a-f]{6} deleted`));
      assert.equal(await checked("git", ["rev-parse", "HEAD"]), originalHead);
    }

    if (builder) {
      const final = await until("builder settlement", () => {
        const current = state();
        return ["finished", "failed", "stopped"].includes(current?.phase) && current;
      });
      assert.equal(final.phase, "finished");
      assert.equal(final.exitCode, 0, "Builder harness failed");
      assert.ok(!final.fallback, "Builder retried with a different harness");
      await until("builder teardown recorded", () => state()?.sandboxDeleted, 60_000);
      if (!owned) {
        const journal = await checked("journalctl", ["--user", "--unit", paths.unit, "--no-pager", "--output=cat"]);
        assert.ok(journal.includes(marker), "Assistant output missing from builder journal");
      }
    }

    await until("OpenShell teardown", async () => !(await sandboxes()).some(matchesSandbox), 60_000);
  } finally {
    try {
      if (address && !builder) await client.close(address).catch(() => {});
      if (runner) {
        runner.kill("SIGTERM");
        await until("runner shutdown", () => runnerEnded, 90_000)
          .catch(() => runner.kill("SIGKILL"));
        await exited;
      }
      if (launch === "builder" && state() && !["finished", "failed", "stopped"].includes(state().phase)) {
        await checked("systemctl", ["--user", "stop", paths.unit], 41 * 60_000);
      }
    } finally {
      try {
        if (armed) {
          for (const name of (await sandboxes()).filter(matchesSandbox)) {
            const result = await destroySandbox({ openshell, env, name });
            assert.ok(result.ok, `Could not delete smoke sandbox ${name}`);
          }
        }
      } finally {
        await ntfy?.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
}

test("live OpenShell bootstrap matrix", { skip: !enabled }, async t => {
  for (const name of selection || []) {
    assert.ok(cases.some(parts => parts.join(":") === name), `Unknown matrix case ${name}`);
  }
  for (const [launch, harness] of cases) {
    const name = `${launch}:${harness}`;
    if (!selection || selection.includes(name)) await t.test(name, () => runCase(launch, harness));
  }
});
