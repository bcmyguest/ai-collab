import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

test("the phone composer clears while a tagged team is still starting", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async (t) => {
  const launch = Promise.withResolvers();
  const started = Promise.withResolvers();
  const fixture = await phoneFixture({
    peers: "claude,cursor",
    models: async () => ({ cursor: ["grok-4.7-high", "deepseek-v41-flash-1017-high"] }),
    start: async () => { started.resolve(); return launch.promise; },
  });
  t.after(async () => {
    launch.resolve({ status: "failed", detail: "PM startup failed in fixture" });
    await fixture.close();
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: /^Send · / });
  await page.route("**/api/send", route => route.fulfill({
    status: 502, json: { error: "Messaging service unavailable" },
  }), { times: 1 });
  await composer.fill("Draft before a publish failure");
  await send.click();
  await page.getByText("Messaging service unavailable", { exact: true }).waitFor();
  assert.equal(await composer.isEnabled(), true);
  assert.equal(await composer.inputValue(), "Draft before a publish failure");
  assert.deepEqual(fixture.messageDeliveries("Draft before a publish failure"), []);

  await composer.fill("@product go");
  await send.click();
  await started.promise;
  assert.deepEqual(fixture.messageDeliveries("@product go"), [fixture.broadcast]);
  await page.waitForFunction(() => document.getElementById("composer")?.value === "" &&
    !document.getElementById("composer").disabled, undefined, { timeout: 3000 });

  await composer.fill("Follow-up");
  await send.click();
  await page.getByText("Follow-up", { exact: true }).waitFor();
  await composer.fill("Keep this draft");
  launch.resolve({ status: "failed", detail: "PM startup failed in fixture" });
  await page.getByText(/Pattern run .*PM startup failed in fixture/).waitFor();
  assert.equal(await composer.inputValue(), "Keep this draft");
});
