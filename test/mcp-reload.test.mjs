import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { toolWorkers } from "../lib/surfaces/mcp-reload.ts";

const RELOAD = new URL("../lib/surfaces/mcp-reload.ts", import.meta.url).href;

// A plugin copy whose worker lists the tool names in tools.json; replacing package.json stands for a deploy.
function plugin(names) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-reload-"));
  writeFileSync(join(dir, "tools.json"), JSON.stringify(names));
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "worker.mjs"), `
    import { readFileSync } from "node:fs";
    import { serveToolWorker } from ${JSON.stringify(RELOAD)};
    const names = JSON.parse(readFileSync(new URL("./tools.json", import.meta.url), "utf8"));
    serveToolWorker({
      listTools: () => names.map((name) => ({ name })),
      callTool: async (name, args, signal) => {
        if (name === "hang") await new Promise((resolve) => signal.addEventListener("abort", resolve));
        if (name === "fail") throw new Error("boom");
        return { text: \`\${name} from pid \${process.pid}: \${JSON.stringify(args)}\` };
      },
    });`);
  return dir;
}

function deploy(dir, names) {
  writeFileSync(join(dir, "tools.json"), JSON.stringify(names));
  writeFileSync(join(dir, "package.json.new"), "{}");
  renameSync(join(dir, "package.json.new"), join(dir, "package.json"));
}

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a deploy restarts the tool worker and announces the new tool list", async (t) => {
  const dir = plugin(["send"]);
  let changed = 0;
  const workers = toolWorkers({ script: pathToFileURL(join(dir, "worker.mjs")), watch: pathToFileURL(join(dir, "package.json")), pollMs: 50, onToolsChanged: () => changed++ });
  t.after(async () => { await workers.stop(); rmSync(dir, { recursive: true, force: true }); });

  assert.deepEqual(await workers.listTools(), [{ name: "send" }]);
  const before = (await workers.callTool("send", { a: 1 })).text;
  assert.match(before, /^send from pid \d+: \{"a":1\}$/);

  deploy(dir, ["send", "spawn_agent"]);
  await until(() => changed === 1);
  assert.deepEqual(await workers.listTools(), [{ name: "send" }, { name: "spawn_agent" }]);
  const after = (await workers.callTool("spawn_agent", {})).text;
  assert.notEqual(after.match(/pid (\d+)/)[1], before.match(/pid (\d+)/)[1]);
});

test("a deploy with the same tools restarts the worker without a list_changed", async (t) => {
  const dir = plugin(["send"]);
  let changed = 0;
  const workers = toolWorkers({ script: pathToFileURL(join(dir, "worker.mjs")), watch: pathToFileURL(join(dir, "package.json")), pollMs: 50, onToolsChanged: () => changed++ });
  t.after(async () => { await workers.stop(); rmSync(dir, { recursive: true, force: true }); });

  const pid = (await workers.callTool("send", {})).text.match(/pid (\d+)/)[1];
  deploy(dir, ["send"]);
  let now = pid;
  for (let i = 0; i < 200 && now === pid; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    now = (await workers.callTool("send", {})).text.match(/pid (\d+)/)[1];
  }
  assert.notEqual(now, pid);
  assert.equal(changed, 0);
});

test("a call running during a deploy finishes on the old worker; errors and aborts come back", async (t) => {
  const dir = plugin(["hang", "fail"]);
  const workers = toolWorkers({ script: pathToFileURL(join(dir, "worker.mjs")), watch: pathToFileURL(join(dir, "package.json")), pollMs: 50, onToolsChanged: () => {} });
  t.after(async () => { await workers.stop(); rmSync(dir, { recursive: true, force: true }); });

  await assert.rejects(workers.callTool("fail", {}), /boom/);
  const controller = new AbortController();
  const hung = workers.callTool("hang", {}, controller.signal);
  deploy(dir, ["hang", "fail", "new"]);
  for (let i = 0; i < 100 && (await workers.listTools()).length !== 3; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  assert.match((await hung).text, /^hang from pid/);
});
