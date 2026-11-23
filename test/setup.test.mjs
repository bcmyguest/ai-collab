import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_COPY_MAX_BYTES, packPluginCopy, setup } from "../lib/setup.mjs";

const TOKEN = `tk_${"a1".repeat(14)}b`;

function harness(bins) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ai-collab-setup-"));
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(" "));
    if (args.includes("token")) return { code: 0, stdout: `token ${TOKEN} created for user ai-collab, never expires\n`, stderr: "" };
    if (args.includes("user")) assert.ok(opts.env.NTFY_PASSWORD.length >= 20);
    return { code: 0, stdout: "", stderr: "" };
  };
  const which = (bin) => (bins.includes(bin) ? `/bin/${bin}` : "");
  let text = "";
  const out = { write: (s) => { text += s; } };
  return { home, calls, opts: { env: { HOME: home, PATH: "/bin" }, home, out, run, which }, text: () => text };
}

test("setup starts ntfy, stores a private token, writes defaults.json, and installs plugins per harness", async () => {
  const h = harness(["docker", "claude", "codex"]);
  assert.equal(await setup(["--no-ui"], h.opts), 0);
  assert.match(h.calls[0], /^docker compose -f .*deploy\/compose\.yaml up -d --wait$/);
  assert.match(h.calls[1], /ntfy user add --role=admin ai-collab$/);
  const tokenFile = path.join(h.home, ".config", "ai-collab", "ntfy-token");
  assert.equal(readFileSync(tokenFile, "utf8"), `${TOKEN}\n`);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const defaults = JSON.parse(readFileSync(path.join(h.home, ".config", "ai-collab", "defaults.json"), "utf8"));
  assert.deepEqual(defaults, { url: "http://127.0.0.1:8794", tokenFile, peers: "claude,codex" });
  assert.ok(h.calls.includes("claude plugin install ai-collab@ai-collab"));
  assert.ok(h.calls.includes("codex plugin add ai-collab@ai-collab"));
  assert.doesNotMatch(h.text(), new RegExp(TOKEN));
  assert.match(h.text(), /tailscale serve/);
});

test("a rerun reuses defaults.json and starts no container", async () => {
  const h = harness(["docker"]);
  await setup(["--no-ui"], h.opts);
  h.calls.length = 0;
  assert.equal(await setup(["--no-ui"], h.opts), 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.text(), /using http:\/\/127\.0\.0\.1:8794/);
});

test("without Docker or defaults.json setup stops with a fix", async () => {
  const h = harness([]);
  assert.equal(await setup(["--no-ui"], h.opts), 1);
  assert.match(h.text(), /Docker not found/);
});

test("--agent picks the harnesses; claude without its CLI is skipped with a note; unknown names fail", async () => {
  const h = harness(["docker", "codex"]);
  assert.equal(await setup(["--no-ui", "--agent", "claude,opencode"], h.opts), 0);
  assert.ok(!h.calls.some(c => c.startsWith("codex ")), "codex not picked");
  assert.match(h.text(), /claude: claude not found on PATH/);
  assert.match(h.text(), /opencode: installed/);
  const bad = harness(["docker"]);
  assert.equal(await setup(["--agent", "vim"], bad.opts), 2);
  assert.match(bad.text(), /unknown --agent vim/);
});

test("run from the npx cache, setup copies itself to a stable folder and reruns from there", async () => {
  const h = harness(["docker"]);
  const cache = path.join(h.home, ".npm", "_npx", "abc", "node_modules", "ai-collab");
  mkdirSync(path.join(cache, "scripts"), { recursive: true });
  mkdirSync(path.join(cache, "node_modules", "next"), { recursive: true });
  writeFileSync(path.join(cache, "package.json"), "{}");
  assert.equal(await setup(["--agent", "cursor"], { ...h.opts, root: cache }), 0);
  const app = path.join(h.home, ".local", "share", "ai-collab", "app");
  assert.ok(existsSync(path.join(app, "package.json")));
  assert.ok(!existsSync(path.join(app, "node_modules")), "dependencies are installed fresh, not copied");
  assert.deepEqual(h.calls.map(c => c.replace(process.execPath, "node")), ["npm install --omit=dev --no-audit --no-fund", `node ${path.join(app, "scripts", "ai-collab.mjs")} setup --agent cursor`]);
});

test("setup adds a clean plugin copy as the Claude and Codex marketplace, never the checkout itself", async () => {
  const h = harness(["docker", "claude", "codex"]);
  assert.equal(await setup(["--no-ui"], h.opts), 0);
  const share = path.join(h.home, ".local", "share", "ai-collab");
  assert.ok(h.calls.includes(`claude plugin marketplace add ${path.join(share, "claude-plugin")}`));
  assert.ok(h.calls.includes(`codex plugin marketplace add ${path.join(share, "codex-plugin")}`));
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  assert.ok(!h.calls.some(c => c.endsWith(`marketplace add ${root}`)), "the checkout, with its worktrees, is never the marketplace");
});

test("packPluginCopy copies only the package files list: no node_modules, worktrees or build output", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const dest = path.join(mkdtempSync(path.join(os.tmpdir(), "ai-collab-pack-")), "claude-plugin");
  const { bytes } = packPluginCopy(root, dest);
  for (const file of [".claude-plugin/plugin.json", ".mcp.json", "package.json", "scripts/ai-collab-code-mcp.mjs", "hooks/hooks.json"]) {
    assert.ok(existsSync(path.join(dest, file)), file);
  }
  for (const gone of ["node_modules", ".claude", ".git", "web/.next", "test"]) assert.ok(!existsSync(path.join(dest, gone)), gone);
  assert.ok(bytes < PLUGIN_COPY_MAX_BYTES);
});
