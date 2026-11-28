// OpenCode in OpenShell: one `opencode serve` per project sandbox, reached through `openshell forward service`.
// Measured 2026-11-28 (openshell 0.1.9, opencode 2.2.6): the sandboxed server answers /api through the forward, and
// reaches a host provider on 127.0.0.1:<port> as host.openshell.internal:<port> once the policy names that port.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { builderPolicy, NTFY_HOST, OPENCODE_DIR } from "../../lib/builder/policy.ts";
import { opencodeRequest } from "../../lib/opencode-api.ts";
import type { OpencodeEndpoint } from "../../lib/opencode-api.ts";
import {
  destroyOwnedSandboxes, ensureSandbox, execArgv, HOME_IN, opencodeSandboxName, runTool, SANDBOX, sandboxLabels, uploadFile, uploadSecret, uploadTree, WORK,
} from "../../lib/sandbox.ts";
import { findExecutable } from "../../lib/sessions/scope.ts";
import { syncSandboxBack, uploadClone } from "./cursor.mjs";

import type { SessionContext } from "../types.d.ts";

// oxlint-disable-next-line typescript/no-explicit-any -- session records, runner options and adapter handles are JSON
type Json = any;
type Inner = Json;
type Box = {
  name: string; project: string; owner: string; endpoint: OpencodeEndpoint | null; inner: Inner;
  serve: ChildProcess | null; forward: ChildProcess | null; uploaded: Set<string>; policyDir: string; ready: Promise<void>;
};

// The port `opencode serve` listens on inside the sandbox; only the forward reaches it.
export const SERVE_PORT = 4096;
export const OPENCODE_IN = `${OPENCODE_DIR}/opencode`;
const SERVE_DIR = `${HOME_IN}/.opencode-serve`;
const PASSWORD_IN = `${SERVE_DIR}/password`;
const PID_IN = `${SERVE_DIR}/pid`;
// Host addresses a provider baseURL may name; inside the sandbox they become host.openshell.internal.
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)$/;
// openshell 0.1.9 prints `✓ Forwarding 127.0.0.1:41593 -> 127.0.0.1:4096 in sandbox <name> via gRPC` (measured 2026-11-28).
const FORWARD_LINE = /Forwarding\s+(\S+):(\d+)\s+->/;
// Host config keys the sandbox server gets; the rest names host paths (plugins, MCP commands, skills) the sandbox lacks.
const CONFIG_KEYS = ["provider", "permission", "permissions", "model", "small_model", "disabled_providers", "enabled_providers"];
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
const STDERR_TAIL_MAX = 4000;
const LABEL = "opencode";
const TRAILER = "Assisted-by: OpenCode:opencode";
// Stops a server an earlier runner left in the sandbox, so the new one can take the port.
const STOP_OLD = `p=${PID_IN}; if [ -f "$p" ]; then k=$(cat "$p"); kill "$k" 2>/dev/null; i=0; while kill -0 "$k" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done; rm -f "$p"; fi; true`;
// The password stays in a sandbox file: it never reaches argv, --env or a log.
const SERVE = `echo $$ > ${PID_IN}; export OPENCODE_SERVER_PASSWORD="$(cat ${PASSWORD_IN})"; exec ${OPENCODE_IN} serve --hostname 127.0.0.1 --port ${SERVE_PORT}`;
const SERVE_ENV = {
  HOME: HOME_IN, XDG_CONFIG_HOME: `${HOME_IN}/.config`, XDG_DATA_HOME: `${HOME_IN}/.local/share`, XDG_STATE_HOME: `${HOME_IN}/.local/state`, AI_COLLAB_OWNED: "opencode",
};

/** JSON with // and /* comments and trailing commas, as opencode.json allows; strings are left alone. */
export function parseJsonc(text: string): Json {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The host's OpenCode config ($XDG_CONFIG_HOME/opencode/opencode.json or .jsonc), or {} when absent or unreadable. */
export function hostOpencodeConfig(env: NodeJS.ProcessEnv, home = env.HOME || homedir()): Json {
  const dir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try { return parseJsonc(readFileSync(join(dir, file), "utf8")); } catch { /* next */ }
  }
  return {};
}

/**
 * The sandbox server's config from the host's: providers, permissions and models only, autoupdate off. A provider
 * baseURL on a host loopback address is rewritten to host.openshell.internal; `ports` lists those ports for the policy.
 */
export function sandboxConfig(host: Json) {
  const config: Json = { $schema: "https://opencode.ai/config.json", autoupdate: false };
  for (const key of CONFIG_KEYS) if (host?.[key] !== undefined) config[key] = structuredClone(host[key]);
  const ports = new Set<number>();
  for (const provider of Object.values<Json>(config.provider ?? {})) {
    const raw = provider?.options?.baseURL;
    if (typeof raw !== "string") continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (!LOOPBACK_HOST.test(url.hostname)) continue;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    url.hostname = NTFY_HOST;
    provider.options.baseURL = raw.endsWith("/") ? url.href : url.href.replace(/\/$/, "");
    ports.add(port);
  }
  return { config, ports: [...ports].sort((a, b) => a - b) };
}

/** The network policy: OpenCode's hosts and the bus (builderPolicy), plus each host provider port, for the uploaded binary. */
export function opencodePolicy(ports: number[]): Json {
  const policy = builderPolicy({ harness: "opencode", binaries: [OPENCODE_IN] });
  if (ports.length) {
    policy.network_policies.host_providers = {
      name: "host-providers",
      endpoints: ports.map((port) => ({ host: NTFY_HOST, port, protocol: "rest", access: "full" })),
      binaries: [{ path: OPENCODE_IN }],
    };
  }
  return policy;
}

/** The local port in the line `openshell forward service` prints once it listens, or 0. */
export function forwardPort(text: string): number {
  const m = FORWARD_LINE.exec(text);
  return m ? Number(m[2]) : 0;
}

// cursor.mjs is untyped JS; its inferred log parameter takes no argument.
const landWork: Json = syncSandboxBack;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerOf = (project: string) => `opencode-${project}`;

/**
 * OpenCode sessions in OpenShell. makeAdapter builds the HTTP adapter for one sandboxed server's endpoint.
 * One sandbox per project, shared by its sessions and deleted when the last one closes; each session's worktree is
 * uploaded as a git clone and landed on the host worktree on close, as Cursor's are.
 */
export function createSandboxedOpenCode({ env = process.env, makeAdapter, readyTimeoutMs = READY_TIMEOUT_MS }: {
  env?: NodeJS.ProcessEnv; makeAdapter: (endpoint: () => OpencodeEndpoint | null) => Inner; readyTimeoutMs?: number;
}) {
  const openshell = env.AI_COLLAB_OPENSHELL_BIN || "openshell";
  const boxes = new Map<string, Box>(); // sandbox name -> its running server
  const claims = new Map<string, Set<string>>(); // sandbox name -> the sessions (and restored records) that hold it

  const opencodeBin = () => {
    const found = env.AI_COLLAB_OPENCODE_BIN || findExecutable("opencode", env.PATH ?? process.env.PATH ?? "");
    if (!found) throw new Error("opencode is not installed on the runner host; set AI_COLLAB_OPENCODE_BIN");
    try { return realpathSync(found); } catch { return found; }
  };
  const exec = (name: string, command: string[]) => runTool(openshell, execArgv({ openshell, sandbox: name, command }).slice(1), { env });

  function claim(name: string, id: string) {
    const set = claims.get(name) ?? new Set();
    set.add(id);
    claims.set(name, set);
  }

  function stopBox(box: Box) {
    for (const child of [box.forward, box.serve]) if (child && child.exitCode === null) child.kill("SIGTERM");
    box.forward = box.serve = null;
    if (boxes.get(box.name) === box) boxes.delete(box.name);
    if (box.policyDir) rmSync(box.policyDir, { recursive: true, force: true });
    box.policyDir = "";
    return Promise.resolve(box.inner?.shutdown()).catch(() => {});
  }

  // Uploads the binary, config, login and a fresh password, then starts the server and its forward and waits for /api/info.
  async function startBox(box: Box, home: string, log: (line: string) => void) {
    const host = hostOpencodeConfig(env, home);
    const { config, ports } = sandboxConfig(host);
    box.policyDir = mkdtempSync(join(tmpdir(), "ai-collab-opencode-policy-"));
    const policy = join(box.policyDir, "policy.yaml");
    writeFileSync(policy, `${JSON.stringify(opencodePolicy(ports), null, 2)}\n`, { mode: 0o600 });
    await ensureSandbox({ openshell, env, name: box.name, policy, labels: sandboxLabels({ project: box.project, kind: "session", owner: box.owner }) });
    // The binary is about 250 MB, so a sandbox that already has it keeps it.
    if ((await exec(box.name, ["test", "-x", OPENCODE_IN])).code !== 0) {
      const bin = opencodeBin();
      await uploadFile({ openshell, env, sandbox: box.name, local: bin, remoteDir: OPENCODE_DIR });
      if (basename(bin) !== "opencode") {
        const moved = await exec(box.name, ["mv", `${OPENCODE_DIR}/${basename(bin)}`, OPENCODE_IN]);
        if (moved.code !== 0) throw new Error(`could not install opencode in ${box.name}: ${moved.stderr.trim()}`);
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "ai-collab-opencode-stage-"));
    const password = randomBytes(24).toString("hex");
    try {
      mkdirSync(join(dir, "opencode"));
      writeFileSync(join(dir, "opencode", "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await uploadTree({ openshell, env, sandbox: box.name, local: join(dir, "opencode"), remote: `${HOME_IN}/.config`, gitIgnore: false });
      writeFileSync(join(dir, "password"), password, { mode: 0o600 });
      await uploadSecret({ openshell, env, sandbox: box.name, file: join(dir, "password"), remoteDir: SERVE_DIR, tmpPrefix: "ai-collab-opencode-secret-" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const auth = join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json");
    if (existsSync(auth)) {
      await uploadSecret({ openshell, env, sandbox: box.name, file: auth, remoteDir: `${HOME_IN}/.local/share/opencode`, tmpPrefix: "ai-collab-opencode-secret-" })
        .catch((error: Error) => log(`opencode: could not copy the login into ${box.name}: ${error.message.split("\n")[0]}`));
    }
    await exec(box.name, ["sh", "-c", STOP_OLD]);

    let tail = "";
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX); };
    const serve = spawn(openshell, execArgv({ openshell, sandbox: box.name, workdir: SANDBOX, env: SERVE_ENV, command: ["sh", "-c", SERVE] }).slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    box.serve = serve;
    serve.stdout?.on("data", keep);
    serve.stderr?.on("data", keep);
    const served = new Promise<never>((_, reject) => {
      serve.on("error", reject);
      serve.on("exit", (code, signal) => {
        if (boxes.get(box.name) === box) { boxes.delete(box.name); log(`opencode: the server in ${box.name} exited (${signal ?? `code ${code}`})`); }
        reject(new Error(`opencode serve in ${box.name} exited (${signal ?? `code ${code}`}): ${tail.trim().slice(-500)}`));
      });
    });
    served.catch(() => {});

    const forward = spawn(openshell, ["forward", "service", box.name, "--target-port", String(SERVE_PORT), "--local", "127.0.0.1:0"], { env, stdio: ["ignore", "pipe", "pipe"] });
    box.forward = forward;
    let fwdText = "";
    const port = await Promise.race([served, new Promise<number>((resolve, reject) => {
      const read = (chunk: Buffer) => {
        fwdText += chunk.toString("utf8");
        const found = forwardPort(fwdText);
        if (found) resolve(found);
      };
      forward.stdout?.on("data", read);
      forward.stderr?.on("data", read);
      forward.on("error", reject);
      forward.on("exit", (code) => reject(new Error(`openshell forward service exited (code ${code}): ${fwdText.trim().slice(-500)}`)));
    })]);
    box.endpoint = { url: `http://127.0.0.1:${port}`, auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };

    const deadline = Date.now() + readyTimeoutMs;
    let last = "";
    for (;;) {
      const r = await Promise.race([served, opencodeRequest("GET", "/api/info", { env, endpoint: box.endpoint, timeoutMs: 5000 })]);
      if (r.ok) break;
      last = r.error;
      if (Date.now() > deadline) throw new Error(`the OpenCode server in ${box.name} did not answer within ${readyTimeoutMs} ms: ${last}`);
      await Promise.race([served, sleep(READY_POLL_MS)]);
    }
    box.inner = makeAdapter(() => box.endpoint);
  }

  // The running server for a project's sandbox, started once and shared.
  async function boxFor(project: string, home: string, log: (line: string) => void): Promise<Box> {
    const name = opencodeSandboxName(project);
    const known = boxes.get(name);
    if (known) { await known.ready; return known; }
    const box: Box = { name, project, owner: ownerOf(project), endpoint: null, inner: null, serve: null, forward: null, uploaded: new Set(), policyDir: "", ready: Promise.resolve() };
    boxes.set(name, box);
    box.ready = startBox(box, home, log);
    try {
      await box.ready;
    } catch (error) {
      await stopBox(box);
      throw error;
    }
    return box;
  }

  // Uploads a session's worktree as a clone under /sandbox/work; a resume keeps the one already there.
  async function stageWork(box: Box, cwd: string, keepExisting: boolean) {
    const workdir = `${WORK}/${basename(cwd)}`;
    if (box.uploaded.has(cwd)) return workdir;
    const present = keepExisting && (await exec(box.name, ["test", "-d", workdir])).code === 0;
    if (!present) {
      if (existsSync(join(cwd, ".git"))) await uploadClone({ openshell, env, sandbox: box.name, cwd, remote: WORK });
      else await uploadTree({ openshell, env, sandbox: box.name, local: cwd, remote: WORK });
    }
    box.uploaded.add(cwd);
    return workdir;
  }

  // Lands the session's work on its host worktree, drops its claim, and deletes the sandbox with the last claim.
  async function releaseClaim(name: string, id: string, project: string, cwd: string, log: (line: string) => void) {
    const set = claims.get(name);
    if (!set?.has(id)) return true;
    let ok = true;
    if (cwd) ok = await landWork({ openshell, env, sandbox: name, cwd, log, label: LABEL, trailer: TRAILER });
    boxes.get(name)?.uploaded.delete(cwd);
    set.delete(id);
    if (set.size) return ok;
    claims.delete(name);
    const box = boxes.get(name);
    if (box) await stopBox(box);
    const out = await destroyOwnedSandboxes({ openshell, env, project, kind: "session", owner: ownerOf(project), log });
    if (!out.ok) log(`opencode: could not delete sandbox ${name}: ${out.detail}`);
    return ok && out.ok;
  }

  // The inner handle with a close that lands the work and releases the sandbox, and a syncBack for land finish.
  function wrap(handle: Json, box: Box, id: string, cwd: string, ctx: SessionContext) {
    let closed = false;
    return {
      ...handle,
      async syncBack() {
        const status = await exec(box.name, ["git", "-C", `${WORK}/${basename(cwd)}`, "status", "--porcelain"]);
        if (status.code !== 0) throw new Error(`git status in the sandbox failed: ${status.stderr.trim() || `exit ${status.code}`}`);
        if (status.stdout.trim()) throw new Error("commit your work in the sandbox first");
        if (!(await landWork({ openshell, env, sandbox: box.name, cwd, log: ctx.log, label: LABEL, trailer: TRAILER }))) {
          throw new Error("could not copy the sandbox commits to the host worktree");
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
        await releaseClaim(box.name, id, box.project, cwd, ctx.log);
      },
    };
  }

  function refuseTeam(patternRun: Json) {
    if (patternRun) throw new Error("OpenCode cannot join an OpenShell team run yet");
  }

  return {
    async open(options: Json, ctx: SessionContext) {
      refuseTeam(options.patternRun);
      const name = opencodeSandboxName(options.project);
      const id = randomUUID();
      claim(name, id);
      let box: Box | undefined;
      try {
        box = await boxFor(options.project, options.env?.HOME || env.HOME || homedir(), ctx.log);
        const workdir = await stageWork(box, options.cwd, false);
        // The server runs in the sandbox, so the session is created in the sandbox's copy of the worktree.
        return wrap(await box.inner.open({ ...options, cwd: workdir }, ctx), box, id, options.cwd, ctx);
      } catch (error) {
        await releaseClaim(name, id, options.project, box ? options.cwd : "", ctx.log);
        throw error;
      }
    },
    async resume(record: Json, ctx: SessionContext, runEnv: Json = {}) {
      refuseTeam(record.patternRun);
      const name = opencodeSandboxName(record.project);
      // A restored record already holds its claim under its address; resuming takes that claim over.
      // A failed resume keeps the claim: the sandbox holds the session's work until release lands it.
      const id = record.address || randomUUID();
      claim(name, id);
      const box = await boxFor(record.project, runEnv.HOME || env.HOME || homedir(), ctx.log);
      await stageWork(box, record.cwd, true);
      return wrap(await box.inner.resume(record, ctx), box, id, record.cwd, ctx);
    },
    /** A record restored after a runner restart holds its sandbox until it resumes or is released. */
    restore(record: Json) {
      if (record?.place !== "openshell" || record.status === "ended" || !record.address) return;
      claim(opencodeSandboxName(record.project), record.address);
    },
    /** Ends a restored record that never resumed: lands its work and deletes the sandbox when no other session holds it. */
    async release(record: Json) {
      if (record?.place !== "openshell" || !record.address) return true;
      return releaseClaim(opencodeSandboxName(record.project), record.address, record.project, record.cwd, () => {});
    },
    // Stops every server and forward; the sandboxes stay, so their sessions resume after a restart.
    async shutdown() {
      await Promise.allSettled([...boxes.values()].map((box) => stopBox(box)));
    },
  };
}
