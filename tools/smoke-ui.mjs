// Loads the UI at phone width. Pass --decisions, --composer, or --home-sessions to exercise fixture projects.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

async function phoneFixture(homeSessions) {
  const { createUi, installUi } = await import("../web/server/ui.mjs");
  const { broadcastTopic, inboxTopic, loadProjects, sessionLabel } = await import("../lib/config.mjs");
  const { addTask, taskStoreFile, writeStore } = await import("../lib/tasks.mjs");
  const { startFakeNtfy } = await import("../test/helpers/fake-ntfy.mjs");
  const fake = await startFakeNtfy();
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-decisions-"));
  const names = [homeSessions ? "jev-debugger" : "decision-first", "decision-second"];
  const ids = ["123456789abc", "abcdef123456"];
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: join(dir, ".config"),
    XDG_DATA_HOME: join(dir, "data"), AI_COLLAB_STATE_DIR: join(dir, "state") };
  const projectsConfig = names.map(project => {
    const root = join(dir, project);
    mkdirSync(root);
    const doc = { v: 1, tasks: [] };
    addTask(doc, { id: project, title: project === names[0] ? "Mobile layout" : "Publish draft", priority: "P1" });
    writeStore(taskStoreFile(project, env), doc);
    return { root, project, url: fake.url, peers: "claude" };
  });
  mkdirSync(join(env.XDG_CONFIG_HOME, "ai-collab"), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify(projectsConfig));
  const projects = loadProjects(env, { host: "operator" });
  fake.inject(broadcastTopic(names[0]), `Question from claude\n\nIMPORTANT, the agent waits for this answer: Use the new layout for #decision-first?\n\nReply in this topic: reply ${ids[0]} YOUR ANSWER`);
  fake.inject(broadcastTopic(names[1]), JSON.stringify({ v: 1, kind: "approval", from: "claude", harness: "claude",
    id: ids[1], tool: "Review", summary: "Publish the draft for #decision-second", expiresAt: Date.now() + 120_000 }));
  const { writeState } = await import("../lib/state.mjs");
  const { parseEnvelope } = await import("../lib/inbox.mjs");
  const cfg = projects.find(item => item.project === names[0]);
  const sessionId = "composer-fixture";
  const label = sessionLabel(sessionId);
  const address = "claude#" + label;
  writeState(join(cfg.stateDir, cfg.project, "registry", address + ".json"), {
    id: address, sessionId, cwd: projectsConfig[0].root, harness: "claude", seenAt: Date.now(),
  });
  const sessions = [];
  if (homeSessions) {
    const { processStart } = await import("../lib/process.mjs");
    for (const [index, name] of ["Trace reconnect", "", ""].entries()) {
      const sessionId = "jev-debugger-fixture-" + index;
      const id = "claude#" + sessionLabel(sessionId);
      const cwd = index === 2 ? join(projectsConfig[0].root, "repro") : projectsConfig[0].root;
      mkdirSync(cwd, { recursive: true });
      writeState(join(cfg.stateDir, cfg.project, "registry", id + ".json"), {
        id, sessionId, cwd, name, harness: "claude", seenAt: Date.now() - 120_000,
        pid: process.pid, pidStart: processStart(process.pid),
      });
      sessions.push({ id, title: name || id.slice(0, 15), metadata: index === 2 ? "jev-debugger · repro" : "jev-debugger" });
    }
  }
  const ui = installUi(createUi({ projects, env, hasDraft: async () => false,
    control: async () => ({ status: "requested" }) }));
  const next = createRequire(import.meta.url)("next");
  const app = next({ dir: fileURLToPath(new URL("../web", import.meta.url)), dev: false, hostname: "127.0.0.1" });
  await app.prepare();
  const server = createServer(app.getRequestHandler()).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    project: cfg.project, address, sessions,
    messageDeliveries: (body, urgent = false) => fake.state.publishes.flatMap(post => {
      const message = parseEnvelope(post.message);
      return message?.kind === "msg" && message.body === body && Boolean(message.urgent) === urgent ? [[post.topic, message.toSession]] : [];
    }),
    broadcast: [broadcastTopic(cfg.project), undefined],
    direct: [inboxTopic(cfg.project, "claude"), label],
    published: () => fake.state.publishes.filter(item => item.message.startsWith("reply ")).map(item => [item.topic, item.message]),
    expected: [[broadcastTopic(names[0]), `reply ${ids[0]} Yes`], [broadcastTopic(names[1]), `reply ${ids[1]} allow`]],
    async close() {
      server.closeAllConnections();
      server.close();
      ui.close();
      await app.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function checkDecisions(page, fixture) {
  const home = page.getByRole("region", { name: "Operator decisions" });
  await home.getByText("Operator decisions · 2", { exact: true }).waitFor();
  await page.reload();
  await home.getByText("Operator decisions · 2", { exact: true }).waitFor();
  await home.getByRole("link", { name: "Mobile layout" }).waitFor();
  await home.getByRole("link", { name: "Publish draft" }).waitFor();
  assert.equal(await home.evaluate(node => node.getBoundingClientRect().top < innerHeight && node.scrollWidth <= node.clientWidth), true);
  await home.getByRole("button", { name: "Open decision inbox" }).click();
  const inbox = page.getByRole("region", { name: "Decision inbox" });
  await page.reload();
  await inbox.getByText("Waiting on you · 2", { exact: true }).waitFor();
  await inbox.getByRole("textbox", { name: "Answer", exact: true }).fill("Yes");
  await inbox.getByRole("button", { name: "Submit", exact: true }).click();
  await inbox.getByText("Waiting on you · 1", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await home.getByText("Operator decisions · 1", { exact: true }).waitFor();
  await home.getByRole("button", { name: "Open decision inbox" }).click();
  await inbox.getByRole("button", { name: "Allow", exact: true }).click();
  await inbox.getByText("No unresolved decisions.").waitFor();
  assert.deepEqual(fixture.published(), fixture.expected);
  await page.goto(fixture.url + "/#project=decision-first");
  await page.getByText(/Answered: Yes/).first().waitFor();
}

async function checkComposer(page, fixture) {
  const project = fixture.project;
  await page.goto(fixture.url + "/#project=" + project);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  const everyone = "Everyone in " + project;
  const direct = "Direct to " + fixture.address.slice(0, "claude#".length + 8);
  async function send(body, destination, expected) {
    await page.setViewportSize({ width: 390, height: 844 });
    await draft.fill(body);
    // Chromium headless has no soft keyboard. Use the resized layout viewport it would leave.
    await page.setViewportSize({ width: 390, height: 500 });
    const label = page.getByText(destination, { exact: true });
    await label.waitFor();
    assert.equal(await label.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
    }), true);
    const sent = page.waitForResponse(response => response.url().endsWith("/api/send") && response.status() === 201);
    await page.getByRole("button", { name: "Send · " + destination, exact: true }).click();
    await sent;
    assert.deepEqual(fixture.messageDeliveries(body), expected);
  }
  await send("Project broadcast", everyone, [fixture.broadcast]);
  await send("Targeted mention @" + fixture.address + " please review", everyone + " · " + direct,
    [fixture.broadcast, fixture.direct]);
  await page.goto(fixture.url + "/#" + new URLSearchParams({ project, level: "session", harness: "claude", session: fixture.address }));
  await page.getByText(direct, { exact: true }).waitFor();
  await send("Direct session message", direct, [fixture.direct]);
  const queued = page.getByRole("region", { name: "Queued messages" });
  const row = queued.getByRole("listitem").filter({ hasText: "Direct session message" });
  const steer = row.getByRole("button", { name: "Steer", exact: true });
  await steer.waitFor();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "");
  const urgentBody = "Urgent direct session message";
  await draft.fill(urgentBody);
  const sendNow = page.getByRole("button", { name: "Send now", exact: true });
  assert.equal(await sendNow.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
  }), true);
  const sent = page.waitForResponse(response => response.url().endsWith("/api/send") && response.status() === 201);
  await sendNow.click();
  await sent;
  assert.deepEqual(fixture.messageDeliveries(urgentBody, true), [fixture.direct]);
}

async function checkHomeSessions(page, fixture) {
  const idle = page.getByRole("region", { name: "Idle", exact: true });
  await idle.getByRole("listitem").first().waitFor();
  assert.equal(await idle.getByRole("listitem").count(), 3);
  for (const { id, title, metadata } of fixture.sessions) {
    const card = idle.locator(`[data-session="${id}"]`);
    const open = card.getByRole("button", { name: "Open " + title, exact: true });
    const overflow = card.getByRole("button", { name: "Actions for " + id, exact: true });
    for (const line of [open.getByText(title, { exact: true }), open.getByText(metadata, { exact: true })]) {
      assert.equal(await line.evaluate(node => node.clientWidth > 0 && node.scrollWidth <= node.clientWidth), true);
    }
    assert.equal(await card.getByText(id, { exact: true }).count(), 0);
    const a = await open.boundingBox();
    const b = await overflow.boundingBox();
    assert.ok(a.width >= 44 && a.height >= 44 && b.width >= 44 && b.height >= 44);
    assert.ok(a.x + a.width <= b.x && b.x + b.width <= 390);
  }
  const { id, title } = fixture.sessions[0];
  const card = idle.locator(`[data-session="${id}"]`);
  const home = page.url();
  await card.getByRole("button", { name: "Actions for " + id }).tap();
  await page.getByRole("menuitem", { name: "Show session details" }).tap();
  await card.getByText(id, { exact: true }).waitFor();
  assert.equal(page.url(), home);
  await card.getByRole("button", { name: "Open " + title }).tap();
  await page.waitForURL(url => new URLSearchParams(url.hash.slice(1)).get("session") === id);
}

const deployedChrome = "/home/b/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync(deployedChrome) ? deployedChrome : undefined) });
let fixture;
try {
  const composer = process.argv.includes("--composer");
  const decisions = process.argv.includes("--decisions");
  const homeSessions = process.argv.includes("--home-sessions");
  if (composer || decisions || homeSessions) fixture = await phoneFixture(homeSessions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...(composer || homeSessions ? { isMobile: true, hasTouch: true } : {}) });
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => errors.push("pageerror: " + error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });
  await page.goto(fixture?.url || process.argv[2] || "http://127.0.0.1:8795/", { waitUntil: "domcontentloaded", timeout: 20000 });
  if (composer) await checkComposer(page, fixture);
  else if (decisions) await checkDecisions(page, fixture);
  else if (homeSessions) await checkHomeSessions(page, fixture);
  else await page.waitForTimeout(6000);
  console.log(errors.slice(0, 15).join("\n") || "no errors");
  console.log("text:", (await page.innerText("body")).slice(0, 300).replace(/\n+/g, " | "));
  if (/pageerror|couldn.t load/.test(errors.join("\n"))) process.exitCode = 1;
} finally {
  await browser.close();
  await fixture?.close();
}
