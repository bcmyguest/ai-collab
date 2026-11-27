import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { activityTopic } from "../lib/config.ts";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const FINAL = "You picked D · Threads for the reply fix, run: sh land-reply.sh";

test("a reply to a session's final text links it by id and shows a quote card", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 60_000,
}, async (t) => {
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  const [peer, session] = fixture.address.split("#");
  const activity = (fields) => fixture.inject(activityTopic(fixture.project),
    JSON.stringify({ v: 1, kind: "activity", from: peer, session, harness: "claude", ...fields }));
  await activity({ type: "prompt", input: "pick a layout" });
  const said = await activity({ type: "text", output: FINAL });
  await activity({ type: "stop" });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const sent = [];
  page.on("request", request => { if (request.url().endsWith("/api/send")) sent.push(request.postDataJSON()); });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&session=" + fixture.address);
  await page.getByText(FINAL, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reply to " + fixture.address }).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.press("End");
  await composer.pressSequentially("ran");
  await page.getByRole("button", { name: /^Send · / }).click();
  await page.getByRole("region", { name: "Queued messages" }).waitFor();
  assert.equal(sent.at(-1).replyTo, said.id, "the reply names the final text's bus event");
  await fixture.claim();
  await page.reload();
  const quote = page.locator(`[data-quote="${said.id}"]`);
  await quote.waitFor({ timeout: 10_000 });
  assert.match(await quote.innerText(), /You picked D · Threads/);
  assert.equal(await page.getByText(/Replying to/).count(), 0, "no raw quote prefix in the bubble");
  if (process.env.AI_COLLAB_REPLY_SCREENSHOT) await page.screenshot({ path: process.env.AI_COLLAB_REPLY_SCREENSHOT });
});

test("a reply sent earlier as quoted text shows the same quote card", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 60_000,
}, async (t) => {
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  await fixture.claimed("Replying to " + fixture.address + ": “" + FINAL + "”\n\n@" + fixture.address + " ran");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&session=" + fixture.address);
  const quote = page.locator("[data-quote]");
  await quote.waitFor({ timeout: 10_000 });
  assert.match(await quote.innerText(), /You picked D · Threads/);
  assert.equal(await page.getByText(/Replying to/).count(), 0, "no raw quote prefix in the bubble");
  if (process.env.AI_COLLAB_LEGACY_SCREENSHOT) await page.screenshot({ path: process.env.AI_COLLAB_LEGACY_SCREENSHOT });
});
