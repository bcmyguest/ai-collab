// Loads the UI at phone width. Pass --decisions, --composer, --home-sessions, --inactive, --kanban, --project-nav, or --ui-sdk.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

export async function phoneFixture({ homeSessions = false, inactive = false, kanban = false, threads: withThreads = false, start, models, peers = "claude" } = {}) {
  const { createUi, installUi } = await import("../web/server/ui.ts");
  const { broadcastTopic, inboxTopic, loadProjects, sessionLabel } = await import("../lib/config.ts");
  const { addTask, taskStoreFile, writeStore } = await import("../lib/tasks.ts");
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
    if (kanban) {
      addTask(doc, { id: "archived", title: "Archived task", status: "done" });
      for (const status of ["open", "decided"]) {
        for (let index = 0; index < 24; index++) {
          const id = `${status}-${index}`;
          addTask(doc, { id, title: id, status, priority: "P2" });
        }
      }
    }
    writeStore(taskStoreFile(project, env), doc);
    return { root, project, url: fake.url, peers };
  });
  mkdirSync(join(env.XDG_CONFIG_HOME, "ai-collab"), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME, "ai-collab", "projects.json"), JSON.stringify(projectsConfig));
  const projects = loadProjects(env, { host: "operator" });
  fake.inject(broadcastTopic(names[0]), `Question from claude\n\nIMPORTANT, the agent waits for this answer: Use the new layout for #decision-first?\n\nReply in this topic: reply ${ids[0]} YOUR ANSWER`);
  fake.inject(broadcastTopic(names[1]), JSON.stringify({ v: 1, kind: "approval", from: "claude", harness: "claude",
    id: ids[1], tool: "Review", summary: "Publish the draft for #decision-second", expiresAt: Date.now() + 120_000 }));
  const { writeState } = await import("../lib/state.ts");
  const { claimInbox, parseEnvelope, replyToOperator, sendMessage } = await import("../lib/messaging.ts");
  const cfg = projects.find(item => item.project === names[0]);
  const sessionId = "composer-fixture";
  const label = sessionLabel(sessionId);
  const address = "claude#" + label;
  writeState(join(cfg.stateDir, cfg.project, "registry", address + ".json"), {
    id: address, sessionId, cwd: projectsConfig[0].root, harness: "claude", seenAt: Date.now(),
  });
  const sessions = [];
  const { processStart } = await import("../lib/process.ts");
  if (homeSessions) {
    for (const [index, name] of ["Trace reconnect", "", "Review notes"].entries()) {
      const sessionId = "jev-debugger-fixture-" + index;
      const id = "claude#" + sessionLabel(sessionId);
      const cwd = index === 2 ? join(projectsConfig[0].root, "repro") : projectsConfig[0].root;
      mkdirSync(cwd, { recursive: true });
      writeState(join(cfg.stateDir, cfg.project, "registry", id + ".json"), {
        id, sessionId, cwd, name, ...(index === 0 ? { identityName: "Debugger" } : {}), harness: "claude", seenAt: Date.now() - 120_000,
        pid: process.pid, pidStart: processStart(process.pid),
      });
      sessions.push({ id, title: name || id.slice(0, 15), metadata: index === 2 ? "jev-debugger · repro" : "jev-debugger" });
    }
  }
  if (inactive) {
    const liveSession = "live-fixture";
    const liveAddress = "claude#" + sessionLabel(liveSession);
    writeState(join(cfg.stateDir, cfg.project, "registry", liveAddress + ".json"), {
      id: liveAddress, sessionId: liveSession, cwd: projectsConfig[0].root, harness: "claude",
      seenAt: Date.now(), pid: process.pid, pidStart: processStart(process.pid),
    });
    const oldSession = "old-fixture";
    const oldAddress = "claude#" + sessionLabel(oldSession);
    writeState(join(cfg.stateDir, cfg.project, "registry", oldAddress + ".json"), {
      id: oldAddress, sessionId: oldSession, cwd: projectsConfig[0].root, harness: "claude",
      seenAt: Date.now() - 25 * 60 * 60_000,
    });
  }
  const threadList = withThreads ? await threadFixture({ cfg, root: projectsConfig[0].root, address, label: sessionLabel, inject: fake.inject, settled: typeof withThreads === "number" ? withThreads : 0 }) : [];
  const threadClient = withThreads ? item => memoryThreads(item.project === cfg.project ? threadList : []) : undefined;
  const ui = installUi(createUi({ projects, env, start, models, hasDraft: async () => false, threadClient,
    control: async () => ({ status: "requested" }) }));
  const next = createRequire(import.meta.url)("next");
  const app = next({ dir: fileURLToPath(new URL("../web", import.meta.url)), dev: false, hostname: "127.0.0.1" });
  await app.prepare();
  const server = createServer(app.getRequestHandler()).listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    project: cfg.project, address, sessions, threads: threadList,
    inject: (topic, message) => fake.inject(topic, message),
    messageDeliveries: (body, urgent = false) => fake.state.publishes.flatMap(post => {
      const message = parseEnvelope(post.message);
      return message?.kind === "msg" && message.body === body && Boolean(message.urgent) === urgent ? [[post.topic, message.toSession]] : [];
    }),
    // The session claims its queued messages, as its hook would.
    async claim() { return claimInbox({ ...cfg, peer: "claude", session: label }, { strict: true }); },
    // An operator message the session already claimed, as an older UI sent it.
    async claimed(body) {
      await sendMessage(cfg, address, body, { operatorThread: true });
      return claimInbox({ ...cfg, peer: "claude", session: label }, { strict: true });
    },
    async replyWithImage(bytes) {
      const agent = { ...cfg, peer: "claude", session: label };
      const [message] = await claimInbox(agent, { strict: true });
      assert.ok(message?.attachment?.local_path, "the agent got a cached image");
      assert.deepEqual(readFileSync(message.attachment.local_path), bytes);
      assert.equal(message.body, "");
      const path = join(dir, "agent.png");
      writeFileSync(path, bytes);
      await replyToOperator(agent, message.id, "Here’s the result.", { attachment: path });
    },
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

/** A thread store held in memory: the fixture's threads, read-only apart from what the UI asks. */
function memoryThreads(list) {
  const find = id => list.find(thread => thread.id === id) || list[0];
  const settings = new Map();
  return {
    list: async () => list, sync: async () => ({}), get: async id => find(id), create: async () => list[0], update: async id => find(id),
    moveSession: async id => find(id), attachPr: async id => find(id), detachPr: async id => find(id),
    // Thread channels (docs/threads.md): listening settings kept in memory, keyed "thread session".
    channel: async id => {
      const thread = find(id);
      const members = (thread.sessions || []).map(session => ({ session, member: true, listening: settings.get(thread.id + " " + session) ?? null }));
      const others = [...settings].filter(([key]) => key.startsWith(thread.id + " ") && !(thread.sessions || []).includes(key.split(" ")[1]))
        .map(([key, listening]) => ({ session: key.split(" ")[1], member: false, listening }));
      return { thread: { id: thread.id, project: thread.project, title: thread.title, leadSession: thread.leadSession || null }, sessions: [...members, ...others] };
    },
    setListening: async (id, session, on) => {
      if (on === null) settings.delete(id + " " + session);
      else settings.set(id + " " + session, on);
      return { thread: id, session, listening: on };
    },
    messages: async () => ({ events: [], more: false }),
    listeners: async () => [...settings].map(([key, listening]) => ({ thread: key.split(" ")[0], session: key.split(" ")[1], listening })),
  };
}

/**
 * Threads with every kind of session row: a live lead with a live child, running and finished subagents, a gone session whose
 * worktree was deleted, an address the registry no longer has, and a thread whose sessions are all gone.
 */
async function threadFixture({ cfg, root, address, label, inject, settled = 0 }) {
  const { writeState } = await import("../lib/state.ts");
  const { processStart } = await import("../lib/process.ts");
  const { activityTopic } = await import("../lib/config.ts");
  const { buildActivity } = await import("../lib/activity.ts");
  const registry = join(cfg.stateDir, cfg.project, "registry");
  const tree = name => { const path = join(root, ".claude", "worktrees", name); mkdirSync(path, { recursive: true }); return path; };
  const record = (peer, sessionId, fields) => {
    const id = peer + "#" + label(sessionId);
    writeState(join(registry, id + ".json"), { id, sessionId, harness: peer, seenAt: Date.now(), ...fields });
    return id;
  };
  const live = { pid: process.pid, pidStart: processStart(process.pid) };
  const lead = record("claude", "redesign-lead", { cwd: tree("switchover-plan"), model: "opus-5-5", identityName: "Redesign lead", ...live });
  const child = record("codex", "redesign-child", { cwd: tree("switchover-plan"), model: "gpt-5.5-codex", name: "Check contrast", parent: lead, ...live });
  const gone = record("cursor", "redesign-gone", { cwd: join(root, ".claude", "worktrees", "deleted-spike"), model: "composer-2", name: "Old layout spike", seenAt: Date.now() - 3 * 3600_000 });
  const missing = "opencode#" + label("redesign-missing");
  const agent = { ...cfg, peer: "claude", session: lead.split("#")[1] };
  const now = Date.now();
  const events = [];
  for (const [index, task] of ["Survey sidebar tokens", "Check harness contrast", "Draft the bell popover"].entries()) {
    events.push({ type: "tool_result", tool: "Grep", callId: "g" + index, input: { pattern: "radius" }, output: "hit", agent: { id: "done-" + index, type: index === 1 ? "Plan" : "Explore" } });
    events.push({ type: "tool_result", tool: "Agent", callId: "a" + index, output: JSON.stringify({ status: "completed", agentId: "done-" + index, description: task }) });
  }
  events.push({ type: "tool_result", tool: "Agent", callId: "live", input: { subagent_type: "general-purpose", model: "sonnet", description: "Screenshot every view" }, output: JSON.stringify({ status: "async_launched", agentId: "run-live", description: "Screenshot every view" }) });
  events.push({ type: "tool_call", tool: "Bash", callId: "b1", input: { command: "node tools/shots.mjs" }, agent: { id: "run-live", type: "general-purpose" } });
  events.push({ type: "tool_result", tool: "Agent", callId: "live2", output: JSON.stringify({ status: "async_launched", agentId: "run-tabs", description: "Audit the tab order" }) });
  events.push({ type: "tool_call", tool: "Read", callId: "r1", input: { file_path: "web/app/chat-console.jsx" }, agent: { id: "run-tabs", type: "Explore" } });
  events.forEach((event, index) => inject(activityTopic(cfg.project), buildActivity(agent, "claude", event, new Date(now - (events.length - index) * 1000).toISOString()).message));
  const thread = (id, title, sessions, extra = {}) => ({ id, project: cfg.project, title, sessions, leadSession: sessions[0], status: "active", createdAt: now - 7200_000, updatedAt: now - 60_000, ...extra });
  return [
    thread("th_00000000000000a1", "UI redesign", [lead, child, gone, missing], { branch: "feat/ui-redesign-v2", worktree: tree("switchover-plan"), updatedAt: now - 5000, prs: [{ number: 812, state: "open" }] }),
    thread("th_00000000000000a2", "Composer keeps focus", [address], { branch: "fix/composer-keep-focus", worktree: root }),
    thread("th_00000000000000a3", "Old layout spike", [gone, missing], { updatedAt: now - 3 * 3600_000 }),
    // threads: N adds N old threads whose only session is gone, as a long-lived store accumulates.
    ...Array.from({ length: settled }, (_, index) => thread("th_" + String(index).padStart(16, "b"), "Old thread " + (index + 1), [missing], { updatedAt: now - (4 + index) * 3600_000 })),
  ];
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
  // The fixture session takes its project's name.
  const direct = "Direct to " + project;
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
  await row.getByRole("button", { name: "Retry delivery", exact: true }).waitFor();
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
  const header = page.locator("main > header");
  const heading = header.getByRole("heading", { name: "Debugger", exact: true });
  await heading.waitFor();
  const state = header.getByText("Idle", { exact: true });
  await state.waitFor();
  const [nameBox, stateBox, themeBox] = await Promise.all([heading.boundingBox(), state.boundingBox(),
    header.getByRole("button", { name: "Theme" }).boundingBox()]);
  assert.ok(Math.max(nameBox.y + nameBox.height, stateBox.y + stateBox.height) <= themeBox.y);
  await header.getByText("jev-debugger · session · " + title, { exact: true }).waitFor();

  for (const session of fixture.sessions.slice(1)) {
    await page.goto(fixture.url + "/#" + new URLSearchParams({ project: fixture.project, level: "session", harness: "claude", session: session.id }));
    await header.getByRole("heading", { name: session.title, exact: true }).waitFor();
    await state.waitFor();
  }
}

async function checkInactive(page, fixture) {
  const show = page.getByRole("button", { name: "Show 2 inactive", exact: true });
  const hide = page.getByRole("button", { name: "Hide 2 inactive", exact: true });
  const dead = page.getByRole("button", { name: /^Dead · 1/ });
  await show.waitFor();
  await page.getByRole("heading", { name: "Idle · 1", exact: true }).waitFor();
  assert.equal(await dead.count(), 0);
  await page.screenshot({ path: process.env.SMOKE_SCREENSHOT || "/tmp/ai-collab-inactive-390.png" });
  await show.click();
  await dead.waitFor();
  assert.equal(await dead.getAttribute("aria-expanded"), "false");
  await page.reload();
  await hide.waitFor();
  await page.goto(fixture.url + "/#" + new URLSearchParams({ project: fixture.project, level: "session" }));
  await hide.waitFor();
  await page.goto(fixture.url + "/#project=" + fixture.project);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  const sidebar = page.getByRole("navigation", { name: "Projects" });
  await sidebar.getByRole("button", { name: "Hide 2 inactive", exact: true }).click();
  await sidebar.getByRole("button", { name: "Show 2 inactive", exact: true }).waitFor();
}

async function checkOperatorWorkflow(page) {
  const home = page.getByRole("region", { name: "Operator decisions" });
  await home.getByRole("button", { name: "Open decision inbox" }).click();
  const inbox = page.getByRole("region", { name: "Decision inbox" });
  await inbox.getByRole("heading", { name: /^Waiting on you · \d+$/ }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  const project = await page.getByRole("navigation", { name: "Threads" }).getByRole("button").first().textContent();
  await checkProjectNav(page, { project });
}

// The menu reaches each project view at phone and desktop width; New thread keeps a 44px tap target on a phone.
async function checkProjectNav(page, { project }) {
  const sidebar = page.getByRole("complementary", { name: "Projects and threads" });
  const threads = page.getByRole("button", { name: "Threads", exact: true });
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    const phone = viewport.width < 768;
    await page.goto(new URL("/#home", page.url()).href);
    if (phone) await threads.click();
    await sidebar.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: project, exact: true }).click();
    if (phone) await threads.click();
    const create = sidebar.getByRole("button", { name: "New thread in " + project });
    await create.waitFor();
    if (phone) assert.ok((await create.boundingBox()).height >= 44);
    for (const [item, heading] of [["Tasks", "Tasks"], ["Teams", "Teams"], ["Project chat", "Chat"]]) {
      if (phone && !(await sidebar.isVisible())) await threads.click();
      await sidebar.getByRole("button", { name: "Menu", exact: true }).click();
      // A click during the menu's open animation scrolls it out of view and closes it.
      await page.getByRole("menu").evaluate(menu => Promise.all(menu.getAnimations({ subtree: true }).map(animation => animation.finished)));
      await page.getByRole("menuitem", { name: item }).click();
      await page.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
      assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("project"), project);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
}

async function checkUiSdk(page, fixture) {
  await page.goto(fixture.url + "/#project=" + fixture.project);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: "Project actions for " + fixture.project }).click();
  await page.getByRole("menuitem", { name: "Request an outcome" }).click();
  const form = page.getByRole("dialog", { name: "Request an outcome" });
  const outcomeField = form.getByRole("textbox", { name: "Requested outcome" });
  const checkField = form.getByRole("textbox", { name: "Acceptance check" });
  await outcomeField.waitFor();
  await page.waitForFunction(() => window.aiCollabTestBridge, null, { timeout: 5000 });
  const labels = await page.evaluate(() => window.aiCollabTestBridge.snapshot()
    .filter(component => component.component === "input" && component.actions.includes("setValue"))
    .map(component => component.label));
  assert.deepEqual(labels.sort(), ["Acceptance check", "Requested outcome"]);
  const outcome = "Improve signup";
  const check = "Sign up using a phone";
  assert.equal(await outcomeField.getAttribute("required"), "");
  assert.equal(await outcomeField.getAttribute("maxlength"), "500");
  const change = await page.evaluate(value => window.aiCollabTestBridge.act({
    steps: [{ ref: "Requested outcome", action: "setValue", args: [value] }],
  }), outcome);
  assert.equal(change.ok, true, change.error?.message);
  assert.equal(await outcomeField.inputValue(), outcome);
  await checkField.fill(check);
  const submitted = page.waitForResponse(response => response.url().endsWith("/api/request-outcome") && response.status() === 201);
  await form.getByRole("button", { name: "Send to PM" }).click();
  const saved = (await (await submitted).json()).outcome;
  assert.deepEqual([saved.outcome, saved.check], [outcome, check]);
  await form.waitFor({ state: "hidden" });
}

async function checkKanban(page, fixture) {
  await page.goto(fixture.url + "/#project=decision-first&level=tasks");
  const rail = page.getByLabel("Status columns");
  const column = status => rail.locator(`[data-task-column="${status}"]`);
  const open = column("open");
  const ready = column("decided");
  const card = open.getByRole("button", { name: /Mobile layout/ });
  await card.click();
  await page.getByRole("button", { name: "Message about Mobile layout" }).waitFor();
  await page.getByRole("button", { name: "Back to board" }).click();

  const handle = open.getByRole("listitem").filter({ has: card }).getByText("⠿");
  const source = await handle.boundingBox();
  const destination = await ready.boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + 6, destination.y + 35, { steps: 8 });
  await page.mouse.up();
  await ready.getByRole("button", { name: /Mobile layout/ }).waitFor();
  await page.reload();
  await ready.getByRole("button", { name: /Mobile layout/ }).waitFor();

  const bounds = await rail.boundingBox();
  const client = await page.context().newCDPSession(page);
  for (const [index, offset] of [320, 285, 235, 175, 110, 55].entries()) {
    await client.send("Input.dispatchTouchEvent", {
      type: index === 0 ? "touchStart" : "touchMove",
      touchPoints: [{ x: bounds.x + offset, y: bounds.y + 35 }],
    });
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => document.querySelector('[aria-label="Status columns"]').scrollLeft > 100);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);

  const done = column("done");
  const toggle = done.getByRole("button", { name: /done · 1/i });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await done.getByText("Archived task").count(), 0);
  await toggle.click();
  await done.getByText("Archived task").waitFor();
  await toggle.click();
  assert.equal(await done.getByText("Archived task").count(), 0);

  await page.setViewportSize({ width: 1800, height: 844 });
  const board = page.getByRole("region", { name: "Task board" });
  assert.ok((await board.boundingBox()).width > 1152);
  const boardBounds = await board.boundingBox();
  const navigation = await page.getByRole("navigation", { name: "Project views" }).boundingBox();
  assert.equal(boardBounds.y + boardBounds.height, navigation.y);
  const openCards = open.locator("ul");
  const readyCards = ready.locator("ul");
  const headingTop = (await open.getByRole("heading").boundingBox()).y;
  await openCards.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('[data-task-column="open"] ul').scrollTop > 0);
  assert.equal(await readyCards.evaluate(node => node.scrollTop), 0);
  assert.equal((await open.getByRole("heading").boundingBox()).y, headingTop);
  assert.equal(await board.evaluate(node => node.scrollTop), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await board.getByRole("button", { name: "Graph", exact: true }).click();
  const canvas = board.getByRole("region", { name: "Graph canvas" });
  const graph = canvas.getByRole("img", { name: "Task dependency graph" });
  assert.ok((await graph.boundingBox()).width <= (await canvas.boundingBox()).width);
  await canvas.hover();
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(() => document.querySelector('[aria-label="Graph canvas"]').scrollTop > 0);
  assert.equal(await board.evaluate(node => node.scrollTop), 0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
const deployedChrome = "/home/b/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync(deployedChrome) ? deployedChrome : undefined) });
let fixture;
try {
  const operatorWorkflow = process.argv.includes("--operator-workflow");
  const composer = process.argv.includes("--composer");
  const decisions = process.argv.includes("--decisions");
  const homeSessions = process.argv.includes("--home-sessions");
  const inactive = process.argv.includes("--inactive");
  const kanban = process.argv.includes("--kanban");
  const projectNav = process.argv.includes("--project-nav");
  const uiSdk = process.argv.includes("--ui-sdk");
  const mobile = composer || homeSessions || inactive || kanban || projectNav || uiSdk;
  if (mobile || decisions) fixture = await phoneFixture({ homeSessions, inactive, kanban });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", error => errors.push("pageerror: " + error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(response.status() + " " + response.url()); });
  const url = composer
    ? fixture.url + "/#" + new URLSearchParams({ project: fixture.project })
    : fixture?.url || process.argv.slice(2).find(arg => !arg.startsWith("--")) || "http://127.0.0.1:8795/";
  const startupDeadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      assert.ok(response?.ok(), "UI page load returned HTTP " + response?.status());
      break;
    } catch (error) {
      if (!operatorWorkflow || Date.now() >= startupDeadline || !/net::ERR_CONNECTION_REFUSED/.test(error.message)) throw error;
      await delay(250);
    }
  }
  if (composer) await checkComposer(page, fixture);
  else if (decisions) await checkDecisions(page, fixture);
  else if (kanban) await checkKanban(page, fixture);
  else if (projectNav) await checkProjectNav(page, fixture);
  else if (homeSessions) await checkHomeSessions(page, fixture);
  else if (inactive) await checkInactive(page, fixture);
  else if (uiSdk) await checkUiSdk(page, fixture);
  else if (operatorWorkflow) await checkOperatorWorkflow(page);
  else await page.waitForTimeout(6000);
  console.log(errors.slice(0, 15).join("\n") || "no errors");
  console.log("text:", (await page.innerText("body")).slice(0, 300).replace(/\n+/g, " | "));
  if (((operatorWorkflow || kanban || projectNav || uiSdk) && errors.length) || /pageerror|couldn.t load/.test(errors.join("\n"))) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await fixture?.close();
}
}
