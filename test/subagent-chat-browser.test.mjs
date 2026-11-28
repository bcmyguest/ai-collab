// Subagents in the main chat (docs/phone-ui.md "Subagents"): a native run's Go-to opens its transcript as the chat with a
// Back control, a spawn_agent row's Go-to opens the child's session chat, and closing the new-agent composer returns.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 90_000 };
// Set to a folder to save a screenshot of each flow per viewport.
const SHOTS = process.env.AI_COLLAB_SHOTS || "";
const SIZES = [["desktop", 1440, 900], ["phone", 390, 844]];

async function shot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name + ".png") });
}

const hashParams = page => page.evaluate(() => Object.fromEntries(new URLSearchParams(location.hash.slice(1))));

for (const [size, width, height] of SIZES) {
  test(`${size}: a run's Go-to shows its transcript as the chat; Back, browser back and a deep link work`, browserTest, async (t) => {
    const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    const [lead] = fixture.threads[0].sessions;
    const sessionHash = "project=" + fixture.project + "&level=session&harness=claude&session=" + encodeURIComponent(lead);
    await page.goto(fixture.url + "/#" + sessionHash);
    const main = page.locator("main");
    const run = main.locator('article[data-type="subagent"]').filter({ hasText: "Audit the tab order" });
    await run.getByRole("button", { name: /^Go to subagent/ }).click();

    await page.waitForFunction(() => location.hash.includes("subagent=run-tabs"));
    assert.ok([undefined, "activity"].includes((await hashParams(page)).tab), "no side panel opens");
    const bar = main.locator('[data-subagent-chat="run-tabs"]');
    await bar.getByRole("heading", { name: /Subagent · Explore · Audit the tab order/ }).waitFor();
    // The chat pane holds the run's own rows, not the parent's.
    await main.getByRole("button", { name: /^Ran Read · web\/app\/chat-console\.jsx/ }).waitFor();
    assert.equal(await main.locator('article[data-type="subagent"]').count(), 0);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll");
    await shot(page, "native-run-" + size);

    await bar.getByRole("button", { name: /^Back to .* chat$/ }).click();
    await page.waitForFunction(() => !location.hash.includes("subagent="));
    await run.waitFor();

    // Browser back returns to the transcript, and forward to the parent chat again.
    await page.goBack();
    await bar.waitFor();
    await page.goForward();
    await bar.waitFor({ state: "detached" });

    // A deep link opens the transcript directly.
    await page.goto(fixture.url + "/#" + sessionHash + "&subagent=run-live");
    await main.locator('[data-subagent-chat="run-live"]').getByRole("heading", { name: /Subagent · general-purpose · Screenshot every view/ }).waitFor();
    await main.getByText("node tools/shots.mjs").first().waitFor();
  });

  test(`${size}: a spawn_agent row's Go-to opens the child session chat`, browserTest, async (t) => {
    const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    const [lead, child] = fixture.threads[0].sessions;
    await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=claude&session=" + encodeURIComponent(lead));
    const go = page.locator("main").getByRole("button", { name: "Go to spawned agent " + child });
    await go.waitFor();
    await go.scrollIntoViewIfNeeded();
    await shot(page, "spawn-row-" + size);
    await go.click();
    await page.waitForFunction(id => location.hash.includes("session=" + encodeURIComponent(id)), child);
    const params = await hashParams(page);
    assert.deepEqual([params.level, params.harness, params.session], ["session", "codex", child]);
    // The child's header leads back to its parent.
    await page.getByRole("button", { name: "Back to parent " + lead }).waitFor();
    await shot(page, "spawn-child-" + size);
  });

  test(`${size}: in a thread, a sidebar run opens its transcript, and closing New agent returns to the thread chat`, browserTest, async (t) => {
    const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    const [thread] = fixture.threads;
    const threadHash = "project=" + fixture.project + "&level=thread&thread=" + thread.id;
    await page.goto(fixture.url + "/#" + threadHash);
    await page.getByRole("heading", { level: 1, name: "UI redesign" }).waitFor();

    // Add agent opens the composer in the project level; its X returns to the thread chat.
    await page.getByRole("button", { name: "Add agent to UI redesign" }).click();
    await page.waitForFunction(() => location.hash.includes("level=project"));
    await page.getByRole("button", { name: "Close new session" }).click();
    await page.waitForFunction(id => location.hash.includes("level=thread") && location.hash.includes("thread=" + id), thread.id);
    await page.getByRole("heading", { level: 1, name: "UI redesign" }).waitFor();

    if (size === "phone") await page.getByRole("button", { name: "Threads", exact: true }).click();
    await page.locator('aside button[data-run="run-tabs"]').click();
    await page.waitForFunction(() => location.hash.includes("subagent=run-tabs"));
    const bar = page.locator('main [data-subagent-chat="run-tabs"]');
    await bar.getByRole("heading", { name: /Subagent · Explore/ }).waitFor();
    await shot(page, "thread-run-" + size);
    await bar.getByRole("button", { name: /^Back to .* chat$/ }).click();
    await page.waitForFunction(() => !location.hash.includes("subagent="));
  });
}

test("closing New thread opened in the project chat stays in the project chat", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const projectHash = "project=" + fixture.project + "&level=project";
  await page.goto(fixture.url + "/#" + projectHash);
  await page.getByRole("button", { name: "New thread in " + fixture.project }).or(page.getByRole("button", { name: "New thread", exact: true })).first().click();
  await page.getByRole("button", { name: "Close new session" }).click();
  await page.getByRole("button", { name: "Close new session" }).waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => location.hash.slice(1)), projectHash);
});
