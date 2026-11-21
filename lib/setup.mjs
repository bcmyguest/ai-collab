/**
 * `ai-collab setup`: starts ntfy in Docker, creates a token, writes defaults.json, installs every detected
 * harness plugin and the UI user service, then prints phone-access steps. Reruns skip finished steps.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "./config.mjs";
import { installCursorPlugin, packageRoot } from "./install-cursor.mjs";
import { installOpenCode } from "./install-opencode.mjs";

const NTFY_PORT = 8794;
const UI_PORT = 8795;
const NTFY_USER = "ai-collab";
const TOKEN_RE = /tk_[a-z0-9]{29}/;
const HARNESSES = [
  { peer: "claude", bin: "claude" },
  { peer: "codex", bin: "codex" },
  { peer: "cursor", bin: "cursor-agent" },
  { peer: "opencode", bin: "opencode" },
];

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

// Starts the compose ntfy, adds the user once, and returns a fresh token; throws with the failing command's output.
function startNtfy({ root, home, run, port }) {
  const compose = ["compose", "-f", path.join(root, "deploy", "compose.yaml")];
  const env = { AI_COLLAB_NTFY_PORT: String(port), AI_COLLAB_NTFY_DATA: path.join(home, ".local", "share", "ai-collab", "ntfy") };
  const step = (args, extraEnv = {}) => {
    const r = run("docker", [...compose, ...args], { env: { ...env, ...extraEnv } });
    if (r.code !== 0 && !/already exists/.test(r.stderr + r.stdout)) throw new Error(`docker ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
    return r;
  };
  step(["up", "-d", "--wait"]);
  step(["exec", "-T", "-e", "NTFY_PASSWORD", "ntfy", "ntfy", "user", "add", "--role=admin", NTFY_USER], { NTFY_PASSWORD: randomBytes(18).toString("base64url") });
  const r = step(["exec", "-T", "ntfy", "ntfy", "token", "add", "--label=ai-collab-setup", NTFY_USER]);
  const token = TOKEN_RE.exec(r.stdout + r.stderr)?.[0];
  if (!token) throw new Error("ntfy token add printed no token");
  return token;
}

function installPlugin(peer, { root, home, env, run }) {
  const url = new URL("../package.json", import.meta.url).href;
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
  if (!fs.existsSync(path.join(root, "web", ".next", "BUILD_ID"))) {
    const r = run(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "build", "web"], { cwd: root });
    if (r.code !== 0) return `build failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`;
  }
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, uiUnit(root));
  run("systemctl", ["--user", "daemon-reload"]);
  const r = run("systemctl", ["--user", "enable", "--now", "ai-collab-ui"]);
  return r.code === 0 ? `running on http://127.0.0.1:${UI_PORT}` : `systemctl enable failed: ${r.stderr.trim()}`;
}

/** Runs setup and returns an exit code; run and which are injectable for tests. */
export async function setup(argv = [], { env = process.env, home = env.HOME || os.homedir(), out = process.stdout, run = defaultRun, which = defaultWhich } = {}) {
  const root = packageRoot(import.meta.url);
  const say = (line) => out.write(`${line}\n`);
  const defaultsFile = path.join(configDir({ ...env, HOME: home }), "defaults.json");
  const found = HARNESSES.filter(h => which(h.bin, env));
  let defaults = readJson(defaultsFile);

  if (defaults?.url && defaults?.tokenFile) say(`ntfy: using ${defaults.url} from ${defaultsFile}`);
  else {
    if (!which("docker", env)) {
      say("ntfy: Docker not found. Install Docker, or write defaults.json for your own ntfy (see docs), then rerun.");
      return 1;
    }
    const port = Number(argv[argv.indexOf("--port") + 1]) || NTFY_PORT;
    let token;
    try { token = startNtfy({ root, home, run, port }); } catch (err) { say(`ntfy: ${err.message}`); return 1; }
    const tokenFile = path.join(path.dirname(defaultsFile), "ntfy-token");
    writePrivate(tokenFile, `${token}\n`);
    defaults = { url: `http://127.0.0.1:${port}`, tokenFile, peers: found.map(h => h.peer).join(",") };
    writePrivate(defaultsFile, `${JSON.stringify(defaults, null, 2)}\n`);
    say(`ntfy: running in Docker on ${defaults.url}; token in ${tokenFile}`);
  }
  say("projects: every git repo joins under its folder name; add an empty .ai-collab-off file to keep a repo out");

  if (!found.length) say("harnesses: none found on PATH (claude, codex, cursor-agent, opencode)");
  for (const h of found) {
    const note = installPlugin(h.peer, { root, home, env, run });
    say(`${h.peer}: ${note.startsWith("failed") || note.includes(" failed") ? note : `installed${note ? `; ${note}` : ""}`}`);
  }

  if (!argv.includes("--no-ui")) say(`ui: ${installUi({ root, home, run, which, env })}`);
  say(`
Phone access (setup changes nothing on your network):
  1. Install Tailscale on this machine and your phone, both signed in to one tailnet.
  2. tailscale serve --bg --https=443 http://127.0.0.1:${UI_PORT}
  3. Set AI_COLLAB_UI_ORIGIN to the printed https URL in ~/.config/systemd/user/ai-collab-ui.service,
     then: systemctl --user restart ai-collab-ui
  4. Open that URL on your phone and add it to the home screen.`);
  return 0;
}
