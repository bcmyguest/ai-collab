// The thread chat feed (docs/threads.md "Thread view"): agents answer the operator directly, so their replies show in
// the thread's feed, and the operator's channel post shows once, not once per recipient.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { inboxTopic } from "../lib/config.ts";
import { encodeEnvelope } from "../lib/agui.ts";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

test("the thread feed shows an agent's direct reply and the operator's post once", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const [thread] = fixture.threads;
  const [lead] = thread.sessions;
  const [peer, session] = lead.split("#");
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=thread&thread=" + thread.id);
  await page.getByRole("heading", { level: 1, name: "UI redesign" }).waitFor();

  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Status on the sidebar?");
  await page.getByRole("button", { name: "Send · Everyone listening in UI redesign" }).click();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "", undefined, { timeout: 5000 });

  // The lead answers the operator directly, as reply_to_operator does.
  await fixture.inject(inboxTopic(fixture.project, peer), encodeEnvelope("msg", {
    from: peer, session, to: "operator", operatorThread: true, ts: new Date().toISOString(), body: "Sidebar ships tonight",
  }));
  await page.getByText("Sidebar ships tonight").first().waitFor({ timeout: 10_000 });
  const feed = page.locator("[data-message-id]");
  assert.equal(await feed.filter({ hasText: "Status on the sidebar?" }).count(), 1, "the post shows once");
  assert.equal(await feed.filter({ hasText: "Sidebar ships tonight" }).count(), 1);
});
