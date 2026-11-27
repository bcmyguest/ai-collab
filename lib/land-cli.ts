// `ai-collab land request|finish <branch>` on any agent checkout; `ai-collab deploy` on the host: main, or any tree with --from.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { broadcastTopic, stateDir } from "./config.mjs";
import { checkoutBranch, deployLink, dbosVersion, dirty, inFlight, installUnits, pointLink, readLink, resolveSource, unitsInstalled } from "./deploy-tree.mjs";
import { AUTO_DEPLOY_TIMEOUT_MS, HOST_CHECKOUT, SERVICES, deployHost, execRun, finishBranch, mergeNode, npmCommand, readLastDeploy, requestLand, restartServices, writeLastDeploy } from "./land.mjs";
import { operatorConfigs } from "./mode.ts";
import { publish } from "./messaging.ts";
import { withLock } from "./state.ts";
import { openTasks } from "./tasks.mjs";
import { passJs } from "./surfaces/types.ts";
import type { Cfg } from "./messaging.ts";

type Writer = { write: (chunk: string) => void };
type Run = typeof execRun;
type Publish = (line: string, env: NodeJS.ProcessEnv) => Promise<void>;
type DeployResult = { status: string; line?: string; to?: string; tree?: string; ref?: string; sha?: string };
type LandCfg = { project?: string; peer?: string; session?: string };
type InFlight = (env: NodeJS.ProcessEnv) => Promise<string[]>;

const LAND_USAGE = `Usage: ai-collab land request <branch>
Pushes <branch> (never main) and opens its PR into main, or reuses the open one. Prints the PR URL.
Usage: ai-collab land finish <branch> [--proof <file>] [--landing pr|packet|branch] [--task <id>]
The default is a draft PR with the proof in its body when origin is GitHub and gh is signed in, else a
review packet on the project's task board; never pushes main.
`;
const DEPLOY_USAGE = `Usage: ai-collab deploy [--if-moved] [--force]
       ai-collab deploy --main [--force]
       ai-collab deploy --from <worktree-path|branch> [--allow-dirty] [--force]
       ai-collab deploy --install-units
Runs on the PM host (Linux, systemd user units). Plain deploy uses ${HOST_CHECKOUT}: refuses a dirty checkout or one
not on main, pulls --ff-only, and when HEAD moved runs npm ci --include=dev and npm run build. Every deploy then
points the deploy link at the tree, restarts ai-collab-ui once, verifies it, publishes one result line to the operator
channel, and restarts ai-collab-bus and ai-collab-runner in a transient unit.
--if-moved   do nothing unless origin/main differs from the last deployed main (the auto-deploy schedule uses it)
--from       deploy a worktree (a path starting with /, ./ or ../) or a branch, checked out detached under
             ~/.cache/ai-collab-deploy/<branch>; plain deploys and --if-moved hold until --main
--main       return the services to ${HOST_CHECKOUT} on main
--allow-dirty  deploy a --from tree with tracked changes
--force      restart despite in-flight runner turns or a DBOS app-version change
--install-units  one-time: write deploy-tree.conf drop-ins so the units run through the deploy link, then daemon-reload
Prints: deployed <old>..<new> | deployed <ref> <sha> | skipped: <reason> | failed: <reason>
`;
const DEPLOY_OPTIONS = {
  from: { type: "string" }, main: { type: "boolean" }, "if-moved": { type: "boolean" }, force: { type: "boolean" },
  "allow-dirty": { type: "boolean" }, "install-units": { type: "boolean" }, help: { type: "boolean" },
} as const;
// The UI restarts in-process before its verify; the bus and runner restart last, in a transient unit.
const LATE_SERVICES = SERVICES.filter((service: string) => service !== "ai-collab-ui");
const SHORT = 12;

const lastLine = (text = "") => text.trim().split("\n").pop() ?? "";
const skipped = (reason: string): DeployResult => ({ status: "skipped", line: `skipped: ${reason}` });
const failed = (reason: string): DeployResult => ({ status: "failed", line: `failed: ${reason}` });

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

type Flags = { from?: string; main?: boolean; "if-moved"?: boolean; force?: boolean; "allow-dirty"?: boolean; "install-units"?: boolean; help?: boolean };

function parseDeploy(args: string[]): Flags | null {
  let flags: Flags;
  try {
    const parsed = parseArgs({ args, options: DEPLOY_OPTIONS, strict: true, allowPositionals: true });
    if (parsed.positionals.length && !(parsed.positionals.length === 1 && parsed.positionals[0] === "help")) return null;
    flags = { ...parsed.values, ...(parsed.positionals[0] === "help" ? { help: true } : {}) };
  } catch {
    return null;
  }
  const modes = [flags.from !== undefined, Boolean(flags.main), Boolean(flags["install-units"])].filter(Boolean).length;
  if (modes > 1 || (flags["if-moved"] && (flags.from !== undefined || flags.main))) return null;
  if (flags["install-units"] && (flags.force || flags["allow-dirty"] || flags["if-moved"])) return null;
  if (flags["allow-dirty"] && flags.from === undefined) return null;
  return flags;
}

export async function deploy(args: string[], {
  env = process.env, out, err, run = execRun, hostCheckout = HOST_CHECKOUT, npm, nodePath = process.execPath,
  publish: send = publishToOperators, cwd = process.cwd(), inflight = inFlight,
}: {
  env?: NodeJS.ProcessEnv; out: Writer; err: Writer; run?: Run; hostCheckout?: string; npm?: string[]; nodePath?: string;
  publish?: Publish; cwd?: string; inflight?: InFlight;
}): Promise<number> {
  const flags = parseDeploy(args);
  if (flags?.help) {
    out.write(DEPLOY_USAGE);
    return 0;
  }
  if (!flags) {
    err.write(DEPLOY_USAGE);
    return 1;
  }
  if (flags["install-units"]) {
    try {
      for (const path of await installUnits({ env, hostCheckout, run, services: SERVICES })) out.write(`wrote ${path}\n`);
      out.write(`run once: systemctl --user restart ${SERVICES.join(" ")}\n`);
      return 0;
    } catch (error) {
      err.write(`ai-collab: deploy: ${(error as Error).message}\n`);
      return 1;
    }
  }
  if (flags.from !== undefined && !unitsInstalled(env, SERVICES)) {
    err.write(`ai-collab: deploy: the units do not run through ${deployLink(env)}; run ai-collab deploy --install-units once\n`);
    return 1;
  }
  // One deploy at a time: a second run (the timer while a deploy is slow) reports and leaves.
  // The lock records its owner pid, so a lock left by a crash is taken over; staleMs covers a full deploy.
  const locked = await withLock(join(stateDir(env), "deploy"), async (): Promise<DeployResult> => {
    try {
      return await deployTree(flags, { env, run, hostCheckout, npm, nodePath, cwd, inflight });
    } catch (error) {
      return failed((error as Error).message.split("\n")[0]);
    }
  }, { waitMs: 0, staleMs: AUTO_DEPLOY_TIMEOUT_MS });
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
  // deployed is the main commit last shipped; a skip, a failure or another tree carries it over.
  const shipped = result.status === "deployed" && result.ref === "main" ? result.to : last?.deployed;
  // ref, tree and sha follow the link: set by the deploy that pointed it, else carried over.
  const live = result.tree ? { ref: result.ref, tree: result.tree, sha: result.sha } : { ref: last?.ref, tree: last?.tree, sha: last?.sha };
  writeLastDeploy(env, {
    at: new Date().toISOString(), status: result.status, line: result.line, ...(shipped ? { deployed: shipped } : {}),
    ...(live.ref ? live : {}),
  });
  if (result.status === "failed") return 1;
  if (result.status !== "deployed") return 0;
  // Last: the restart stops the runner, so everything else is recorded first.
  const restart = await restartServices({ run, services: LATE_SERVICES });
  if (restart.status !== 0) {
    err.write(`ai-collab: deploy: restart failed: ${lastLine(restart.stderr) || `exit ${restart.status}`}\n`);
    return 1;
  }
  return 0;
}

/** Builds the chosen tree, then points the link at it, restarts the UI once and verifies it. */
async function deployTree(flags: Flags, { env, run, hostCheckout, npm, nodePath, cwd, inflight }: {
  env: NodeJS.ProcessEnv; run: Run; hostCheckout: string; npm?: string[]; nodePath: string; cwd: string; inflight: InFlight;
}): Promise<DeployResult> {
  const linked = readLink(env);
  const held = linked !== null && linked !== hostCheckout;
  const last = readLastDeploy(env);
  if (held && flags.from === undefined && !flags.main) {
    if (flags["if-moved"]) return { status: "unchanged" };
    return skipped(`${last?.ref ?? linked} is deployed; run ai-collab deploy --main to return`);
  }
  // Read before any checkout: the version the running services use.
  const runningDbos = dbosVersion(held ? linked : hostCheckout);
  const preflight = async (tree: string): Promise<string | null> => {
    if (flags.force) return null;
    const reasons = [];
    const turns = await inflight(env);
    if (turns.length) reasons.push(`${turns.length} runner turn(s) in flight (${turns.join(", ")})`);
    const target = dbosVersion(tree);
    if (runningDbos && target && runningDbos !== target) reasons.push(`DBOS app version changes ${runningDbos} -> ${target}`);
    return reasons.length ? `${reasons.join("; ")}; --force restarts anyway` : null;
  };

  let built: DeployResult & { tree: string; ref: string; sha: string };
  if (flags.from === undefined) {
    const result: DeployResult = await deployHost(passJs({
      run, hostCheckout, env, ifMoved: Boolean(flags["if-moved"]), nodePath, npm, deployed: last?.deployed,
      build: ["run", "build"], returning: Boolean(flags.main) && held, check: () => preflight(hostCheckout),
    }));
    if (result.status !== "deployed") return result;
    built = { ...result, tree: hostCheckout, ref: "main", sha: result.to ?? "" };
  } else {
    const source = await resolveSource(flags.from, { run, hostCheckout, env, cwd });
    const { tree, ref } = source;
    let sha: string;
    if (source.kind === "branch") sha = await checkoutBranch({ run, hostCheckout, tree, branch: ref });
    else sha = (await run("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" })).stdout.trim();
    if (!flags["allow-dirty"] && await dirty(run, tree)) return skipped(`${tree} has local changes; --allow-dirty deploys them`);
    const before = await preflight(tree);
    if (before) return skipped(before);
    const [npmFile, ...npmArgs] = npm ?? npmCommand(mergeNode(nodePath, tree, env), env.PATH);
    const npmRun = (argv: string[]) => run(npmFile, [...npmArgs, ...argv], { cwd: tree, env, encoding: "utf8" });
    const ci = await npmRun(["ci", "--include=dev"]);
    if (ci.status !== 0) return failed(`npm ci --include=dev exited ${ci.status}`);
    const build = await npmRun(["run", "build"]);
    if (build.status !== 0) return failed(`UI build exited ${build.status}`);
    built = { status: "deployed", line: `deployed ${ref} ${sha.slice(0, SHORT)}`, tree, ref, sha };
  }
  // Turns may have started during the build.
  const late = await preflight(built.tree);
  if (late) return skipped(late);
  pointLink(env, built.tree);
  const restart = await run("systemctl", ["--user", "restart", "ai-collab-ui.service"], { encoding: "utf8" });
  if (restart.status !== 0) return { ...built, ...failed(`UI restart exited ${restart.status}`) };
  const verify = await run(nodePath, [join(built.tree, "deploy", "verify-ui.mjs")], { cwd: built.tree, env, encoding: "utf8" });
  if (verify.status !== 0) return { ...built, ...failed(`UI verify exited ${verify.status}`) };
  return built;
}
