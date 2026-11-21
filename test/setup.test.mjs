import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup } from "../lib/setup.mjs";

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
