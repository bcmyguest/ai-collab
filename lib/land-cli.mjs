// `ai-collab land request <branch>` on any agent checkout; `ai-collab deploy [--if-moved]` on the host checkout.
import { join } from "node:path";
import { broadcastTopic, stateDir } from "./config.mjs";
import { AUTO_DEPLOY_TIMEOUT_MS, deployHost, execRun, readLastDeploy, requestLand, restartServices, writeLastDeploy } from "./land.mjs";
import { HOST_CHECKOUT } from "./merge-cli.mjs";
import { operatorConfigs } from "./mode.mjs";
import { publish } from "./messaging.ts";
import { withLock } from "./state.mjs";

const LAND_USAGE = `Usage: ai-collab land request <branch>
Pushes <branch> (never main) and opens its PR into main, or reuses the open one. Prints the PR URL.
`;
const DEPLOY_USAGE = `Usage: ai-collab deploy [--if-moved]
Runs on the PM host using ${HOST_CHECKOUT}. Refuses a dirty checkout or one not on main, pulls --ff-only,
and when HEAD moved runs npm ci --include=dev and the UI deploy step, publishes one result line to the
operator channel, then restarts ai-collab-bus, ai-collab-ui and ai-collab-runner in a transient unit.
--if-moved does nothing unless origin/main differs from HEAD (the auto-deploy schedule uses it).
Prints: deployed <old>..<new> | skipped: <reason> | failed: <reason>
`;

const lastLine = (text = "") => text.trim().split("\n").pop() ?? "";

// The operator channel: one line per operator config on its broadcast topic.
async function publishToOperators(line, env) {
  await Promise.all(operatorConfigs(env).map((cfg) =>
    publish(cfg, broadcastTopic(cfg.project), line, { title: "ai-collab: deploy" })));
}

export async function land(args, { env = process.env, out, err, run = execRun, cwd = process.cwd() }) {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) {
    out.write(LAND_USAGE);
    return 0;
  }
  const [action, branch, ...rest] = args;
  if (action !== "request" || !branch || rest.length) {
    err.write(LAND_USAGE);
    return 1;
  }
  try {
    const { url } = await requestLand(branch, { run, cwd });
    out.write(`${url}\n`);
    return 0;
  } catch (error) {
    err.write(`ai-collab: land: ${error.message}\n`);
    return 1;
  }
}

export async function deploy(args, {
  env = process.env, out, err, run = execRun, hostCheckout = HOST_CHECKOUT, npm, nodePath = process.execPath,
  publish: send = publishToOperators,
}) {
  if (args.includes("--help") || args[0] === "help") {
    out.write(DEPLOY_USAGE);
    return 0;
  }
  if (args.some((arg) => arg !== "--if-moved")) {
    err.write(DEPLOY_USAGE);
    return 1;
  }
  // One deploy at a time: a second run (the timer while a deploy is slow) reports and leaves.
  // The lock records its owner pid, so a lock left by a crash is taken over; staleMs covers a full deploy.
  const deployed = readLastDeploy(env)?.deployed;
  const locked = await withLock(join(stateDir(env), "deploy"), () => deployHost({ run, hostCheckout, env, ifMoved: args.includes("--if-moved"), nodePath, npm, deployed }),
    { waitMs: 0, staleMs: AUTO_DEPLOY_TIMEOUT_MS });
  if (!locked.locked) {
    out.write("skipped: another deploy is running\n");
    return 0;
  }
  const result = locked.value;
  if (result.status === "unchanged") return 0;
  out.write(`${result.line}\n`);
  // A repeated skip (same reason as the last recorded result) stays off the operator channel.
  const last = readLastDeploy(env);
  const repeat = result.status === "skipped" && last?.status === "skipped" && last.line === result.line;
  if (!repeat) await send(result.line, env).catch((error) => err.write(`ai-collab: deploy: publish failed: ${error.message}\n`));
  // The shipped commit carries over skips and failures, so the next deploy compares against it.
  const shipped = result.status === "deployed" ? result.to : last?.deployed;
  writeLastDeploy(env, { at: new Date().toISOString(), status: result.status, line: result.line, ...(shipped ? { deployed: shipped } : {}) });
  if (result.status === "failed") return 1;
  if (result.status !== "deployed") return 0;
  // Last: the restart stops the UI and runner, so everything else is recorded first.
  const restart = await restartServices({ run });
  if (restart.status !== 0) {
    err.write(`ai-collab: deploy: restart failed: ${lastLine(restart.stderr) || `exit ${restart.status}`}\n`);
    return 1;
  }
  return 0;
}
