// A raw channel post (operator broadcast, phone reply) travels as "ntfy" on the wire; the screen must show it as the operator's, never as the retired transport name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

test("a raw channel post renders under the operator, not under ntfy", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async (t) => {
  const fixture = await phoneFixture({ peers: "claude" });
  t.after(() => fixture.close());
  fixture.inject(fixture.broadcast[0], "sunrise on the channel");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  await page.getByText("sunrise on the channel", { exact: true }).waitFor();
  const text = await page.locator("body").innerText();
  assert.ok(!text.includes("ntfy"), "the retired transport name never reaches the screen");
  assert.match(text, /\boperator\b/, "channel posts display as the operator's");
});
