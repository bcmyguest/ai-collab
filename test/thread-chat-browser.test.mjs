// The thread chat view (docs/threads.md "Thread view"): a sidebar thread row opens the thread's posts, the composer
// posts there, and an open session that muted the thread still gets the operator's post once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { inboxTopic } from "../lib/config.ts";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

test("a thread row opens the thread chat; an open muted session gets the operator's post once", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const [thread] = fixture.threads;
  const [lead, child] = thread.sessions;
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=claude&session=" + encodeURIComponent(lead));

  // The thread row opens the thread level, titled by the thread.
  await page.locator(`button[data-thread="${thread.id}"]`).click();
  await page.waitForFunction(id => location.hash.includes("level=thread") && location.hash.includes("thread=" + id), thread.id);
  await page.getByRole("heading", { level: 1, name: "UI redesign" }).waitFor();

  // A post from the thread view lands in the feed.
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Thread view post");
  await page.getByRole("button", { name: "Send · Everyone listening in UI redesign" }).click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });
  await page.getByText("Thread view post").first().waitFor();

  // The child subagent is muted by default; with its chat open, the post still reaches it, once.
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=codex&session=" + encodeURIComponent(child));
  await composer.fill("Muted but open");
  await page.getByRole("button", { name: "Send · Everyone listening in UI redesign" }).click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });
  const toChild = fixture.messageDeliveries("Muted but open").filter(([to, session]) => to === inboxTopic(fixture.project, "codex") && session === child.split("#")[1]);
  assert.equal(toChild.length, 1);

  // The agent name under the thread title opens that agent's session chat, dropping any side panel.
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=codex&session=" + encodeURIComponent(child) + "&tab=raw");
  await page.getByRole("button", { name: /^Open .* chat$/ }).click();
  await page.waitForFunction(id => location.hash.includes("session=" + encodeURIComponent(id)) && !location.hash.includes("tab=raw"), child);

  // The session header's thread title leads back to the thread chat.
  await page.getByRole("heading", { level: 1 }).getByRole("button", { name: "UI redesign" }).click();
  await page.waitForFunction(() => location.hash.includes("level=thread"));
});
