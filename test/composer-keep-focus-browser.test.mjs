import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const active = (page) => page.evaluate(() => document.activeElement?.id ?? null);

test("the composer keeps focus through a send, by Enter and by the Send button", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async (t) => {
  const fixture = await phoneFixture({ peers: "claude" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  // Holding the send open shows whether focus survives the posting state, not just its end.
  let release;
  await page.route("**/api/send", async (route) => {
    await new Promise((resolve) => { release = resolve; });
    await route.continue();
  });

  await composer.click();
  await composer.fill("Sent with Enter");
  await composer.press("Enter");
  await page.waitForFunction(() => document.getElementById("composer")?.value === "");
  assert.equal(await active(page), "composer", "focus held while the send is in flight");
  release();
  await page.getByText("Sent with Enter", { exact: true }).waitFor();
  assert.equal(await active(page), "composer", "focus held after the send");
  await page.unroute("**/api/send");

  await composer.fill("Sent with the button");
  await page.getByRole("button", { name: /^Send · / }).click();
  await page.getByText("Sent with the button", { exact: true }).waitFor();
  assert.equal(await active(page), "composer", "focus returns after a button send");
});
