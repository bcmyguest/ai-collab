#!/usr/bin/env node
/**
 * Records the README demo: a fake ntfy server, the built Next.js UI, real hook processes and sendMessage
 * drive scripts/demo/scenario.mjs in a 390×844 dark phone viewport; a CDP screenshot loop captures frames
 * and encode.mjs turns them into the GIF. Touches no real ntfy topic, config or session.
 * Usage: npm run demo [-- --out docs/demo.gif --keep]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HOOK = join(ROOT, "scripts/ai-collab-hook.mjs");
const HARNESS = join(ROOT, "scripts/demo/harness.mjs");
const CALCULATOR = join(ROOT, "scripts/demo/calculator.html");
const PROJECT = "calc-demo";
const FRAME_GAP_MS = 1000 / 20; // capture at most 20 frames per second
const EASE_WAIT_MS = 850;
const FAST = 3;

const { values: args } = parseArgs({ options: { out: { type: "string", default: join(ROOT, "docs/demo.gif") }, keep: { type: "boolean", default: false } } });

const PLAYWRIGHT_CACHE = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
// Isolate this process before any ai-collab module reads the environment: a throwaway HOME, the fake ntfy, no real project.
const work = mkdtempSync(join(tmpdir(), "calc-demo-"));
const home = join(work, "home");
mkdirSync(join(home, ".codex"), { recursive: true });
for (const key of Object.keys(process.env)) if (key.startsWith("AI_COLLAB_") || key.startsWith("CODEX_") || key.startsWith("CLAUDE")) delete process.env[key];
process.env.HOME = home;
process.env.CODEX_HOME = join(home, ".codex");

const { chromium } = await import("playwright-core");
const { startFakeNtfy } = await import(join(ROOT, "test/helpers/fake-ntfy.mjs"));
const { loadConfig, sessionLabel } = await import(join(ROOT, "lib/config.mjs"));
const { sendMessage } = await import(join(ROOT, "lib/inbox.mjs"));
const { createUi, installUi } = await import(join(ROOT, "web/server/ui.mjs"));
const { scenario } = await import("./scenario.mjs");
const { encode, LAYOUT, VIEWPORT } = await import("./encode.mjs");

const STAGE_CSS = `*{box-sizing:border-box;margin:0}body{width:${LAYOUT.width}px;height:${LAYOUT.height}px;overflow:hidden;font-family:Inter,"Segoe UI","DejaVu Sans",system-ui,sans-serif;color:#f8fafc;
background:radial-gradient(120% 70% at 15% 0%,#312e81 0%,transparent 60%),radial-gradient(90% 60% at 100% 100%,#0e7490 0%,transparent 55%),#0b1020}`;

function chromePath() {
  if (process.env.DEMO_CHROME) return process.env.DEMO_CHROME;
  try { const bundled = chromium.executablePath(); if (existsSync(bundled)) return bundled; } catch {}
  const cache = PLAYWRIGHT_CACHE;
  const found = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split("-")[1] - a.split("-")[1]) : [];
  for (const dir of found) for (const exe of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) if (existsSync(join(cache, dir, exe))) return join(cache, dir, exe);
  throw new Error("No Chromium found: set DEMO_CHROME or run `npx playwright-core install chromium`");
}

// A long-lived fake harness process for one session; run() spawns the real hook under it, say() posts chat.
function agent(env, host, sessionId) {
  const proc = spawn(process.execPath, [HARNESS, HOOK], { argv0: host, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  let n = 0;
  createInterface({ input: proc.stdout }).on("line", (line) => { const r = JSON.parse(line); waiting.get(r.n)?.(r); waiting.delete(r.n); });
  const label = sessionLabel(sessionId);
  const cfg = loadConfig({ ...env, AI_COLLAB_PEER: host, AI_COLLAB_SESSION: label });
  const request = (input, activityOnly) => ({ args: [...(activityOnly ? ["--activity"] : []), "--host", host], env: { ...env, AI_COLLAB_PEER: host }, input: { cwd: join(work, PROJECT), session_id: sessionId, ...input } });
  return {
    id: host + "#" + label,
    run: (input, activityOnly = false) => new Promise((resolve) => {
      n += 1; waiting.set(n, resolve);
      proc.stdin.write(JSON.stringify({ n, ...request(input, activityOnly) }) + "\n");
    }),
    say: (body, opts) => sendMessage(cfg, "all", body, opts),
    close: () => proc.kill(),
  };
}

async function startNext(instance) {
  installUi(instance);
  const next = createRequire(join(ROOT, "package.json"))("next");
  const app = next({ dir: join(ROOT, "web"), dev: false, hostname: "127.0.0.1", port: 0 });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = http.createServer((req, res) => handle(req, res)).listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: "http://127.0.0.1:" + server.address().port, close: () => { server.closeAllConnections(); server.close(); instance.close(); } };
}

// The finished calculator, driven to 12 × 7 = 84 and screenshotted, as the agent's attachment.
async function calculatorShot(browser, file) {
  const page = await browser.newPage({ viewport: { width: 340, height: 520 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await page.goto("file://" + CALCULATOR);
  for (const key of ["1", "2", "×", "7", "="]) await page.getByRole("button", { name: key, exact: true }).click();
  await page.getByLabel("Display").filter({ hasText: "84" }).waitFor();
  await page.screenshot({ path: file });
  await page.close();
}

// Camera, caption and speed marks against wall-clock time, plus a CDP screenshot loop (device pixels) to PNG files.
async function recorder(page, dir) {
  const frames = [], cameras = [], captions = [], speeds = [];
  const cdp = await page.context().newCDPSession(page);
  let running = true, count = 0;
  const loop = (async () => {
    while (running) {
      const t = Date.now();
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { x: 0, y: 0, ...VIEWPORT, scale: 2 } }).catch(() => ({}));
      if (!data) continue;
      const file = `f${String(count++).padStart(5, "0")}.png`;
      writeFileSync(join(dir, file), Buffer.from(data, "base64"));
      frames.push({ t, file });
      const rest = FRAME_GAP_MS - (Date.now() - t);
      if (rest > 0) await new Promise((r) => setTimeout(r, rest));
    }
  })();
  const wait = (ms) => page.waitForTimeout(ms);
  return {
    frames, cameras, captions, speeds, t0: Date.now(),
    caption(title, sub) { if (captions.at(-1)?.title !== title) captions.push({ t: Date.now(), title, sub, step: captions.length + 1 }); },
    // Plays a waiting stretch (hook processes, typing) at FAST× in the output.
    async fast(fn) { speeds.push({ t: Date.now(), speed: FAST }); try { return await fn(); } finally { speeds.push({ t: Date.now(), speed: 1 }); } },
    wait,
    // Eases toward the union of the locators' boxes at the given zoom, clamped to the viewport.
    // left: keep the boxes' left edge in view and let a wide row run off the right edge.
    async focus(locators, { zoom = 1.7, anchor = "center", left = false } = {}) {
      const boxes = (await Promise.all(locators.map((l) => l.boundingBox().catch(() => null)))).filter(Boolean);
      if (!boxes.length) return;
      const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
      const x1 = Math.max(...boxes.map((b) => b.x + b.width)), y1 = Math.max(...boxes.map((b) => b.y + b.height));
      const z = Math.max(1, Math.min(zoom, left ? Infinity : VIEWPORT.width / (x1 - x0 + 24), VIEWPORT.height / (y1 - y0 + 24)));
      const w = VIEWPORT.width / z, h = VIEWPORT.height / z;
      const x = left ? x0 - 12 : (x0 + x1) / 2 - w / 2;
      const y = anchor === "top" ? y0 - 16 : anchor === "bottom" ? y1 + 16 - h : (y0 + y1) / 2 - h / 2;
      const clamp = (v, max) => Math.min(Math.max(v, 0), max);
      cameras.push({ t: Date.now(), rect: { x: clamp(x, VIEWPORT.width - w), y: clamp(y, VIEWPORT.height - h), w, h } });
      await wait(EASE_WAIT_MS);
    },
    async wide() { cameras.push({ t: Date.now(), rect: null }); await wait(EASE_WAIT_MS); },
    async stop() { await wait(200); running = false; await loop; },
  };
}

// Caption stages, title and end cards rendered as PNGs at the output size.
async function renderCards(browser, dir, captions) {
  const page = await browser.newPage({ viewport: { width: LAYOUT.width, height: LAYOUT.height }, deviceScaleFactor: 1 });
  const s = LAYOUT.screen, b = LAYOUT.bezel;
  const phone = `<div style="position:absolute;left:${s.left - b}px;top:${s.top - b}px;width:${s.width + 2 * b}px;height:${s.height + 2 * b}px;border-radius:${s.radius + b}px;background:#05070d;border:1px solid #ffffff2a;box-shadow:0 30px 80px #000a,0 0 0 1px #00000080,0 0 60px #6366f133"></div>`;
  const shot = async (html, name) => { await page.setContent(`<style>${STAGE_CSS}</style>${html}`); await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: join(dir, name) }); return name; };
  for (const c of captions) {
    c.stage = await shot(`<div style="position:absolute;left:0;right:0;top:30px;text-align:center">
      <div style="display:inline-block;padding:3px 10px;border-radius:99px;background:#6366f133;color:#c7d2fe;font:600 12px/18px inherit;letter-spacing:.08em">${c.step} / ${captions.length}</div>
      <div style="margin-top:8px;font-weight:700;font-size:25px;letter-spacing:-.01em">${c.title}</div>
      <div style="margin-top:4px;font-size:15px;color:#a5b4fc">${c.sub}</div></div>${phone}`, `stage-${c.step}.png`);
  }
  const card = (head, sub, foot) => `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;padding:40px">
    <div style="width:76px;height:76px;border-radius:22px;background:linear-gradient(135deg,#6366f1,#06b6d4);display:grid;place-items:center;font-size:38px;box-shadow:0 12px 40px #6366f166">💬</div>
    <div style="font-weight:800;font-size:46px;letter-spacing:-.02em">${head}</div>
    <div style="font-size:22px;color:#c7d2fe;line-height:1.35">${sub}</div>
    <div style="margin-top:18px;font-size:15px;color:#94a3b8">${foot}</div></div>`;
  const title = await shot(card("AI Collab", "your agents,<br>from your phone", "Claude Code · Codex · Cursor"), "title.png");
  const end = await shot(card("AI Collab", "chat · activity · subagents<br>images · approvals", "self-hosted over your own ntfy server"), "end.png");
  await page.close();
  return { title, end };
}

if (!existsSync(join(ROOT, "web/.next/BUILD_ID"))) { console.error("Build the UI first: npm run build"); process.exit(1); }
const frameDir = join(work, "frames");
mkdirSync(frameDir, { recursive: true });
mkdirSync(join(work, PROJECT), { recursive: true });
const fake = await startFakeNtfy();
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), AI_COLLAB_URL: fake.url, AI_COLLAB_PROJECT: PROJECT, AI_COLLAB_PEERS: "claude,codex", AI_COLLAB_STATE_DIR: join(work, "state"), AI_COLLAB_POLL_INTERVAL_MS: "0" };
Object.assign(process.env, env);
const operator = loadConfig({ ...env, AI_COLLAB_PEER: "operator" });
const refuse = async () => { throw new Error("disabled in the demo"); };
const server = await startNext(createUi({ projects: [operator], env, control: refuse, start: refuse, setMode: refuse }));
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
const agents = { claude: agent(env, "claude", "calc-demo-claude"), codex: agent(env, "codex", "calc-demo-codex") };
let exit = 0;
try {
  const screenshot = join(work, "calculator.png");
  await calculatorShot(browser, screenshot);
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "dark" });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(server.url + "/#project=" + PROJECT);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.waitForLoadState("networkidle").catch(() => {});
  const rec = await recorder(page, frameDir);
  rec.t0 = Date.now();
  const { skipped } = await scenario({ page, rec, agents, fake, screenshot, project: PROJECT });
  await rec.stop();
  const cards = await renderCards(browser, frameDir, rec.captions);
  writeFileSync(join(frameDir, "timeline.json"), JSON.stringify({ t0: rec.t0, t1: Date.now(), frames: rec.frames, cameras: rec.cameras, captions: rec.captions, speeds: rec.speeds, ...cards, skipped }));
  console.log(`recorded ${rec.frames.length} frames in ${((rec.frames.at(-1).t - rec.t0) / 1000).toFixed(1)} s${skipped.length ? "; skipped: " + skipped.join(", ") : ""}`);
  mkdirSync(dirname(args.out), { recursive: true });
  const result = await encode(frameDir, args.out);
  console.log(`${args.out}: ${(result.bytes / 1048576).toFixed(2)} MB, ${result.seconds} s, ${result.frames} GIF frames at ${result.fps} fps`);
} catch (err) {
  console.error(err);
  exit = 1;
} finally {
  for (const a of Object.values(agents)) a.close();
  await browser.close();
  server.close();
  await fake.close();
  if (args.keep || exit) console.log("recording kept in " + work);
  else rmSync(work, { recursive: true, force: true });
  process.exit(exit);
}
