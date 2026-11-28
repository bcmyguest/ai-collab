// Pull to refresh on a phone (docs/phone-ui.md): a drag down from the top reconnects the stream, also while the composer
// keeps focus after a send, but not while the focused composer holds a draft.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

test("pull to refresh reconnects with the composer focused, and waits while it holds a draft", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: 3, peers: "claude,codex" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  let streams = 0;
  page.on("request", (request) => { if (request.url().includes("/api/events")) streams++; });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const composer = page.locator("#composer");
  await composer.waitFor();
  const cdp = await context.newCDPSession(page);
  const box = await page.locator('[role="log"]').first().boundingBox();
  async function pull() {
    const before = streams;
    const x = box.x + box.width / 2, y = box.y + 40;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + i * 12 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    for (let i = 0; i < 20 && streams === before; i++) await page.waitForTimeout(100);
    return streams - before;
  }

  await composer.focus();
  assert.ok(await pull() > 0, "an empty focused composer, as after a send, leaves pull to refresh on");
  await composer.fill("half a thought");
  await composer.focus();
  assert.equal(await pull(), 0, "a draft in the focused composer blocks it");
});
