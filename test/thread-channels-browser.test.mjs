// Thread channels in the browser (docs/threads.md "Thread channels"): the composer posts to the open thread, and the
// sidebar bell toggles a session's listening from the keyboard.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { inboxTopic, threadTopic } from "../lib/config.ts";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };
// Screenshots go where the operator asked when set, else nowhere.
const SHOTS = process.env.AI_COLLAB_SHOTS_DIR || "";

test("the composer in an open thread posts to its listeners, and the bell turns a subagent's listening on", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const [thread] = fixture.threads;
  const [lead, child, gone] = thread.sessions;
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=claude&session=" + encodeURIComponent(lead));
  const send = page.getByRole("button", { name: "Send · Everyone listening in UI redesign" });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Ship the sidebar today");
  await send.waitFor();

  // The child is a subagent: muted by default; the lead is a cooperative member, listening.
  const childBell = page.getByRole("button", { name: "Listen to thread posts: Check contrast" });
  const leadBell = page.locator(`[data-listen="${lead}"]`);
  assert.equal(await childBell.getAttribute("aria-pressed"), "false");
  assert.equal(await leadBell.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(`[data-listen="${gone}"]`).count(), 0, "a gone session has no bell");
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.locator("form").filter({ has: composer }).first().screenshot({ path: SHOTS + "/composer.png" });
  }

  await send.click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });
  const topic = threadTopic(fixture.project, thread.id);
  const sessionOf = address => address.split("#")[1];
  assert.deepEqual(fixture.messageDeliveries("Ship the sidebar today").sort(), [
    [topic, undefined], [inboxTopic(fixture.project, "claude"), sessionOf(lead)], [inboxTopic(fixture.project, "cursor"), sessionOf(gone)],
  ].sort());

  // Keyboard: focus the child's bell and press Space; the setting round-trips through the snapshot.
  await childBell.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction(id => document.querySelector(`[data-listen="${id}"]`)?.getAttribute("aria-pressed") === "true", child);
  if (SHOTS) await page.locator(`ul[aria-label="Sessions in UI redesign"]`).screenshot({ path: SHOTS + "/toggle.png" });
  await composer.fill("Child hears this");
  await send.click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });
  assert.ok(fixture.messageDeliveries("Child hears this").some(([to, session]) => to === inboxTopic(fixture.project, "codex") && session === sessionOf(child)));

  // An @mention of a muted subagent reaches it directly, listening or not.
  await childBell.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(id => document.querySelector(`[data-listen="${id}"]`)?.getAttribute("aria-pressed") === "false", child);
  await composer.fill("@codex check contrast");
  await page.getByRole("button", { name: /^Send · Everyone listening in UI redesign · Direct to / }).click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });
  assert.ok(fixture.messageDeliveries("@codex check contrast").some(([to, session]) => to === inboxTopic(fixture.project, "codex") && session === sessionOf(child)));
});
