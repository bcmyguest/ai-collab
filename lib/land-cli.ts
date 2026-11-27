// `ai-collab land request|finish <branch>` on any agent checkout; `ai-collab deploy [--if-moved]` on the host checkout.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { broadcastTopic, stateDir } from "./config.mjs";
import { AUTO_DEPLOY_TIMEOUT_MS, HOST_CHECKOUT, deployHost, execRun, finishBranch, readLastDeploy, requestLand, restartServices, writeLastDeploy } from "./land.mjs";
import { operatorConfigs } from "./mode.mjs";
import { publish } from "./messaging.ts";
import { withLock } from "./state.mjs";
import { openTasks } from "./tasks.mjs";
import { passJs } from "./surfaces/types.ts";
import type { Cfg } from "./messaging.ts";

type Writer = { write: (chunk: string) => void };
type Run = typeof execRun;
type Publish = (line: string, env: NodeJS.ProcessEnv) => Promise<void>;
type DeployResult = { status: string; line?: string; to?: string };
type LandCfg = { project?: string; peer?: string; session?: string };

const LAND_USAGE = `Usage: ai-collab land request <branch>
Pushes <branch> (never main) and opens its PR into main, or reuses the open one. Prints the PR URL.
Usage: ai-collab land finish <branch> [--proof <file>] [--landing pr|packet|branch] [--task <id>]
The default is a draft PR with the proof in its body when origin is GitHub and gh is signed in, else a
review packet on the project's task board; never pushes main.
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
async function publishToOperators(line: string, env: NodeJS.ProcessEnv): Promise<void> {
  // operatorConfigs keeps only enabled configs.
  const configs: Cfg[] = passJs(operatorConfigs(env));
  await Promise.all(configs.map((cfg) =>
    publish(cfg, broadcastTopic(cfg.project), line, { title: "ai-collab: deploy" })));
}

// Reads `land finish` flags; null on an unknown flag or a missing value.
function finishFlags(rest: string[]): { proof?: string; landing?: string; task?: string } | null {
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i];
    const value = rest[++i];
    if (value === undefined || !["--proof", "--landing", "--task"].includes(name)) return null;
    flags[name.slice(2)] = value;
  }
  return flags;
}

export async function land(args: string[], { out, err, run = execRun, cwd = process.cwd(), env = process.env, cfg = {} }: {
  env?: NodeJS.ProcessEnv; out: Writer; err: Writer; run?: Run; cwd?: string; cfg?: LandCfg;
}): Promise<number> {
  if (args.length === 0 || args[0] === "help" || args.includes("--help")) {
    out.write(LAND_USAGE);
    return 0;
  }
  const [action, branch, ...rest] = args;
  if (action === "request") {
    if (!branch || rest.length) {
      err.write(LAND_USAGE);
      return 1;
    }
    try {
      const { url } = await requestLand(branch, { run, cwd });
      out.write(`${url}\n`);
      return 0;
    } catch (error) {
      err.write(`ai-collab: land: ${(error as Error).message}\n`);
      return 1;
    }
  }
  const flags = action === "finish" && branch ? finishFlags(rest) : null;
  if (!flags) {
    err.write(LAND_USAGE);
    return 1;
  }
  const { proof: proofFile, landing, task } = flags;
  if (!proofFile && landing !== "branch") {
    err.write("ai-collab: land: finish needs --proof <file> unless --landing branch\n");
    return 1;
  }
  try {
    const proof = proofFile ? readFileSync(proofFile, "utf8") : "";
    const by = cfg.peer && cfg.session ? `${cfg.peer}#${cfg.session}` : cfg.peer || "cli";
    // The store opens only when the packet path uses it; without a project that path refuses.
    const noBoard = () => { throw new Error("the packet landing needs a project task board: set AI_COLLAB_PROJECT or pass --landing pr|branch"); };
    const tasks = cfg.project ? openTasks(cfg.project, env) : { add: noBoard, submitReview: noBoard };
    const result = await finishBranch(branch, passJs({ run, cwd, proof, tasks, by, ...(landing ? { landing } : {}), ...(task ? { task } : {}) }));
    if (result.landing === "pr") out.write(`pr: ${result.url}${result.created ? "" : " (existing)"}\n`);
    else if (result.landing === "packet") out.write(`packet: task ${result.task}\n`);
    else out.write(`branch: pushed ${result.branch}\n`);
    return 0;
  } catch (error) {
    err.write(`ai-collab: land: ${(error as Error).message}\n`);
    return 1;
  }
}

export async function deploy(args: string[], {
  env = process.env, out, err, run = execRun, hostCheckout = HOST_CHECKOUT, npm, nodePath = process.execPath,
  publish: send = publishToOperators,
}: {
  env?: NodeJS.ProcessEnv; out: Writer; err: Writer; run?: Run; hostCheckout?: string; npm?: string[]; nodePath?: string; publish?: Publish;
}): Promise<number> {
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
  const locked = await withLock(join(stateDir(env), "deploy"), async (): Promise<DeployResult> => deployHost(passJs({ run, hostCheckout, env, ifMoved: args.includes("--if-moved"), nodePath, npm, deployed })),
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
  if (!repeat) await send(result.line ?? "", env).catch((error: Error) => err.write(`ai-collab: deploy: publish failed: ${error.message}\n`));
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
