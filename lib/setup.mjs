/**
 * `ai-collab setup`: writes defaults.json with a bus token, installs the local message bus and every
 * detected harness plugin and the UI user service, then prints phone-access steps. Reruns skip finished steps.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { productionDistDir } from "./ui-build-output.mjs";
import { configDir } from "./config.mjs";
import { PLUGIN_COPY_MAX_BYTES, packPluginCopy } from "./plugin-copy.mjs";

export { PLUGIN_COPY_MAX_BYTES, packPluginCopy };
import { installCursorPlugin, packageRoot } from "./install-cursor.mjs";
import { installOpenCode } from "./install-opencode.mjs";

const BUS_PORT = 8794;
const UI_PORT = 8795;
// npx unpacks into a cache that npm may delete; setup moves itself here so plugins and the UI keep a stable path.
const APP_DIR = [".local", "share", "ai-collab", "app"];
// Claude and Codex copy their marketplace folder; a checkout with worktrees once made a 42 GB plugin cache.
const SHARE_DIR = [".local", "share", "ai-collab"];
const SKIP_COPY = new Set(["node_modules", ".git", path.join("web", ".next"), path.join("web", ".next-demo"), path.join("web", ".next-builds"), "site"]);
const OPTIONS = { port: { type: "string" }, "no-ui": { type: "boolean" }, agent: { type: "string", multiple: true } };
const HARNESSES = [
  { peer: "claude", bin: "claude" },
  { peer: "codex", bin: "codex" },
  // Cursor renamed its CLI to `agent`; the older `cursor-agent` still counts as installed.
  { peer: "cursor", bin: "agent", fallback: "cursor-agent" },
  { peer: "opencode", bin: "opencode" },
];

/** Whether one harness's CLI is installed: its binary, or else the fallback name older installs use. */
function installed(h, env, which) {
  return which(h.bin, env) || (h.fallback ? which(h.fallback, env) : "");
}

function defaultRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts, env: { ...process.env, ...opts.env } });
  return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || String(r.error?.message || "") };
}

function defaultWhich(bin, env) {
  for (const dir of String(env.PATH || "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, bin))) return path.join(dir, bin);
  }
  return "";
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// A bus token: tk_ plus 29 lowercase alphanumerics, the shape older ntfy tokens had.
function busToken() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(29);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `tk_${out}`;
}

function busUnit(root, port) {
  return `[Unit]
Description=AI Collab message bus

[Service]
ExecStart=${process.execPath} ${path.join(root, "scripts", "ai-collab-bus.mjs")}
Environment=AI_COLLAB_BUS_PORT=${port}
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
`;
}

// Installs and starts the bus user service; an existing unit is left alone.
function installBus({ root, home, run, which, env, port }) {
  const unit = path.join(home, ".config", "systemd", "user", "ai-collab-bus.service");
  if (fs.existsSync(unit)) return `kept ${unit}`;
  if (!which("systemctl", env)) return `no systemd: run \`node ${path.join(root, "scripts", "ai-collab-bus.mjs")}\` in the background`;
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, busUnit(root, port));
  run("systemctl", ["--user", "daemon-reload"]);
  const r = run("systemctl", ["--user", "enable", "--now", "ai-collab-bus"]);
  return r.code === 0 ? `running on http://127.0.0.1:${port}` : `systemctl enable failed: ${r.stderr.trim()}`;
}

function installPlugin(peer, { root, home, env, run }) {
  const url = new URL("../package.json", import.meta.url).href;
  if (peer === "claude" || peer === "codex") {
    let copy;
    try { copy = packPluginCopy(root, path.join(home, ...SHARE_DIR, `${peer}-plugin`)).dest; }
    catch (error) { return `plugin copy failed: ${error.message}`; }
    root = copy;
  }
  if (peer === "claude") {
    for (const args of [["plugin", "marketplace", "add", root], ["plugin", "install", "ai-collab@ai-collab"]]) {
      const r = run("claude", args);
      if (r.code !== 0 && !/already/i.test(r.stderr + r.stdout)) return `claude ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`;
    }
    return "";
  }
  if (peer === "codex") {
    for (const args of [["plugin", "marketplace", "add", root], ["plugin", "add", "ai-collab@ai-collab"]]) {
      const r = run("codex", args);
      if (r.code !== 0 && !/already/i.test(r.stderr + r.stdout)) return `codex ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`;
    }
    return "restart Codex and trust the hooks in /hooks";
  }
  if (peer === "cursor") {
    const r = installCursorPlugin({ home, importMetaUrl: url, copy: true });
    return r.ok ? "restart running Cursor sessions" : `failed: ${r.message}`;
  }
  const r = installOpenCode({ home, env, importMetaUrl: url });
  return r.ok === false ? `failed: ${r.message}` : "restart OpenCode";
}

function uiUnit(root) {
  const next = path.join(root, "node_modules", "next", "dist", "bin", "next");
  return `[Unit]
Description=AI Collab UI

[Service]
WorkingDirectory=${root}
Environment=NODE_ENV=production
# Environment=AI_COLLAB_UI_ORIGIN=https://<host>.<tailnet>.ts.net
ExecStart=${process.execPath} ${next} start ${path.join(root, "web")} -H 127.0.0.1 -p ${UI_PORT}
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=default.target
`;
}

// Builds the UI if needed and installs a systemd user unit; an existing unit is left alone.
function installUi({ root, home, run, which, env }) {
  const unit = path.join(home, ".config", "systemd", "user", "ai-collab-ui.service");
  if (fs.existsSync(unit)) return `kept ${unit}`;
  if (!which("systemctl", env)) return `no systemd: run \`npm run ui\` in ${root}`;
  if (!fs.existsSync(path.join(root, "web", productionDistDir(path.join(root, "web")), "BUILD_ID"))) {
    const r = run(process.execPath, [path.join(root, "deploy", "build-ui.mjs")], { cwd: root });
    if (r.code !== 0) return `build failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`;
  }
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, uiUnit(root));
  run("systemctl", ["--user", "daemon-reload"]);
  const r = run("systemctl", ["--user", "enable", "--now", "ai-collab-ui"]);
  return r.code === 0 ? `running on http://127.0.0.1:${UI_PORT}` : `systemctl enable failed: ${r.stderr.trim()}`;
}

// Copies the package out of the npx cache, installs its dependencies, and reruns setup from the copy.
function relocate(root, home, argv, { run, say }) {
  const dest = path.join(home, ...APP_DIR);
  say(`install: copying ai-collab to ${dest}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(root, dest, { recursive: true, filter: (from) => !SKIP_COPY.has(path.relative(root, from)) });
  // A published package carries no package-lock.json; a git checkout does.
  const verb = fs.existsSync(path.join(dest, "package-lock.json")) ? "ci" : "install";
  const npm = run("npm", [verb, "--omit=dev", "--no-audit", "--no-fund"], { cwd: dest });
  if (npm.code !== 0) { say(`install: npm ci failed: ${(npm.stderr || npm.stdout).trim().split("\n").slice(-3).join(" ")}`); return 1; }
  return run(process.execPath, [path.join(dest, "scripts", "ai-collab.mjs"), "setup", ...argv], { stdio: "inherit" }).code;
}

/** The harnesses to install: --agent names (comma or repeated), else every one on PATH; throws on an unknown name. */
function chosenHarnesses(agents, env, which) {
  if (!agents?.length) return HARNESSES.filter(h => installed(h, env, which));
  const names = agents.flatMap(a => a.split(",")).map(a => a.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter(n => !HARNESSES.some(h => h.peer === n));
  if (unknown.length) throw new Error(`unknown --agent ${unknown.join(", ")}; pick from ${HARNESSES.map(h => h.peer).join(", ")}`);
  return HARNESSES.filter(h => names.includes(h.peer));
}

/** Runs setup and returns an exit code; run, which and root are injectable for tests. */
export async function setup(argv = [], { env = process.env, home = env.HOME || os.homedir(), out = process.stdout, run = defaultRun, which = defaultWhich, root = packageRoot(import.meta.url) } = {}) {
  const say = (line) => out.write(`${line}\n`);
  let flags;
  try { flags = parseArgs({ args: argv, options: OPTIONS, strict: true }).values; } catch (err) { say(`setup: ${err.message}`); return 2; }
  if (root.split(path.sep).includes("_npx")) return relocate(root, home, argv, { run, say });
  let found;
  try { found = chosenHarnesses(flags.agent, env, which); } catch (err) { say(`setup: ${err.message}`); return 2; }
  const defaultsFile = path.join(configDir({ ...env, HOME: home }), "defaults.json");
  let defaults = readJson(defaultsFile);

  if (defaults?.url && defaults?.tokenFile) say(`bus: using ${defaults.url} from ${defaultsFile}`);
  else {
    const port = Number(flags.port) || BUS_PORT;
    const token = busToken();
    const tokenFile = path.join(path.dirname(defaultsFile), "bus-token");
    writePrivate(tokenFile, `${token}\n`);
    defaults = { url: `http://127.0.0.1:${port}`, tokenFile, peers: found.map(h => h.peer).join(",") };
    writePrivate(defaultsFile, `${JSON.stringify(defaults, null, 2)}\n`);
    say(`bus: ${installBus({ root, home, run, which, env, port })}; token in ${tokenFile}`);
  }
  say("projects: every git repo joins under its folder name; add an empty .ai-collab-off file to keep a repo out");

  if (!found.length) say("harnesses: none found on PATH (claude, codex, agent, opencode); pick with --agent claude,cursor");
  for (const h of found) {
    // Claude Code and Codex install through their CLI; Cursor and OpenCode plugins are plain files.
    if ((h.peer === "claude" || h.peer === "codex") && !installed(h, env, which)) { say(`${h.peer}: ${h.bin} not found on PATH; install it, then rerun`); continue; }
    const note = installPlugin(h.peer, { root, home, env, run });
    say(`${h.peer}: ${note.startsWith("failed") || note.includes(" failed") ? note : `installed${note ? `; ${note}` : ""}`}`);
  }

  if (!flags["no-ui"]) say(`ui: ${installUi({ root, home, run, which, env })}`);
  say(`
Phone access (setup changes nothing on your network):
  1. Install Tailscale on this machine and your phone, both signed in to one tailnet.
  2. tailscale serve --bg --https=443 http://127.0.0.1:${UI_PORT}
  3. Set AI_COLLAB_UI_ORIGIN to the printed https URL in ~/.config/systemd/user/ai-collab-ui.service,
     then: systemctl --user restart ai-collab-ui
  4. Open that URL on your phone and add it to the home screen.`);
  return 0;
}
