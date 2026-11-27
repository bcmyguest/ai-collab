import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {copyFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {once} from "node:events";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {compileTrace} from "../lib/pattern-compiler.ts";
import {BUILT_IN_PATTERNS} from "../lib/patterns.mjs";

const definition = BUILT_IN_PATTERNS.product;
const expected = ["in vision", "built", "reported", "task closed"];
const runId = "productspike";
const binary = process.env.CELLD_BIN;
const executable = binary?.includes("/") ? resolve(binary) : binary || "celld";
const fixture = mkdtempSync(join(tmpdir(), "ai-collab-celld-"));
const outcomes = [];
const launched = [];
const stepResults = new Map();
const eventIds = new Set();
let reviewEnterAttempts = 0;
let cutDuringEnter = false;
let duplicateEvents = 0;
let waitingResponse;
let celld;
let currentLog = "";
let startupError;

function json(response, value) {
  response.writeHead(200, {"content-type": "application/json"});
  response.end(JSON.stringify(value));
}

const gateway = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const part of request) body += part;
    const {runId: actualRun, stepId, operation, message, left} = JSON.parse(body);
    assert.equal(actualRun, runId);
    const key = `${runId}/${stepId}`;
    if (operation === "enter" && left.reply.active === "review") reviewEnterAttempts++;
    if (stepResults.has(key)) return json(response, stepResults.get(key));
    let result;
    if (operation === "entry") {
      launched.push(definition.roles[0].id);
      result = {status: "running", active: definition.roles[0].id};
    } else if (operation === "enter") {
      launched.push(left.reply.active);
      result = {reply: left.reply};
      if (left.reply.active === "review" && !cutDuringEnter) {
        stepResults.set(key, result);
        cutDuringEnter = true;
        waitingResponse = response;
        return;
      }
    } else if (eventIds.has(message.request)) {
      duplicateEvents++;
      const {status, active} = compileTrace(definition, outcomes);
      result = {reply: {status, active}, launch: false};
    } else {
      eventIds.add(message.request);
      const trace = compileTrace(definition, [...outcomes, message.event]);
      assert.notEqual(trace.status, "refused", trace.reason);
      outcomes.push(message.event);
      result = {
        reply: {status: trace.status, active: trace.active, steps: trace.steps},
        launch: trace.steps.at(-1)?.step === "enter",
      };
    }
    stepResults.set(key, result);
    json(response, result);
  } catch (error) {
    response.writeHead(500);
    response.end(error.stack);
    console.error(error);
  }
});
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
const gatewayURL = `http://127.0.0.1:${gateway.address().port}/`;

const allocate = createServer();
allocate.listen(0, "127.0.0.1");
await once(allocate, "listening");
const port = allocate.address().port;
await new Promise(resolve => allocate.close(resolve));
const root = `http://127.0.0.1:${port}`;

async function query(path, payload) {
  const response = await fetch(root + path, {
    signal: AbortSignal.timeout(2_000),
    ...(payload === undefined ? {} : {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(payload),
    }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  if (response.status !== 204) return response.json();
}

async function awaitCondition(fn, label) {
  const deadline = Date.now()+25_000;
  let error;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      error = err;
    }
    await delay(100);
  }
  throw new Error(`timed out: ${label}`, {cause: error});
}

async function start() {
  startupError = null;
  celld = spawn(executable, ["dev", fixture, "--host", "127.0.0.1", "--port", String(port), "--no-watch", "--logs"], {
    env: {PATH: process.env.PATH, NO_COLOR: "1", HOME: fixture, XDG_CONFIG_HOME: fixture},
    stdio: ["ignore", "pipe", "pipe"],
  });
  celld.once("error", (error) => {
    startupError = new Error(`Could not start ${executable}. Install celld or set CELLD_BIN.`, {cause: error});
  });
  currentLog = "";
  for (const stream of [celld.stdout, celld.stderr]) stream.on("data", data => currentLog += data);
  await awaitCondition(async () => {
    await query("/");
    return true;
  }, "celld listening");
}

async function stop(signal) {
  if (!celld?.pid || celld.exitCode !== null || celld.signalCode !== null) return;
  const exited = once(celld, "exit");
  celld.kill(signal);
  await exited;
}

const status = () => query(`/status?id=${runId}`);
const send = (request, event) => query(`/event?id=${runId}`, {request, event});
try {
  for (const file of ["wrangler.json", "worker.mjs"]) {
    copyFileSync(new URL(`./fixtures/celld/${file}`, import.meta.url), join(fixture, file));
  }
  copyFileSync(new URL("../lib/pattern-workflow.ts", import.meta.url), join(fixture, "pattern-workflow.mjs"));
  writeFileSync(join(fixture, ".dev.vars"), `GATEWAY=${gatewayURL}\n`);
  await start();
  assert.deepEqual(await query("/create", {runId}), {id: runId});
  await awaitCondition(async () => (await status()).status === "waiting", "entry event wait");
  await send("e1", "in vision");
  await awaitCondition(() => launched.includes("engineer"), "engineer launch");
  await awaitCondition(async () => (await status()).status === "waiting", "engineer event wait");
  await send("e2", "built");
  await awaitCondition(() => cutDuringEnter, "review launch accepted while step reply is withheld");

  await stop("SIGKILL");
  waitingResponse.destroy();
  await start();
  await awaitCondition(() => reviewEnterAttempts === 2, "celld retries uncommitted enter after restart");
  await awaitCondition(async () => (await status()).status === "waiting", "review event wait after restart");
  await send("e2", "built");
  await awaitCondition(() => duplicateEvents === 1, "duplicate event ignored by gateway");
  await send("e3", "reported");
  await send("e4", "task closed");
  const final = await awaitCondition(async () => {
    const result = await status();
    return result.status === "complete" && result;
  }, "completed workflow");
  assert.deepEqual(outcomes, expected);
  assert.deepEqual(launched, ["pm", "engineer", "review", "pm"]);
  assert.deepEqual(final.output, compileTrace(definition, expected));
  console.log(JSON.stringify({result: final.status, roleLaunches: launched, reviewEnterAttempts, duplicateEvents, traceSteps: final.output.steps.length}));
} catch (error) {
  console.error(currentLog);
  throw error;
} finally {
  await stop("SIGTERM");
  gateway.closeAllConnections();
  gateway.close();
  rmSync(fixture, {recursive: true, force: true});
}
