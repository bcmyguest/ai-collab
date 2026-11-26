import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

async function open(t) {
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return { fixture, page };
}

test("a task action's result and error show on the Tasks view", browserTest, async (t) => {
  const { fixture, page } = await open(t);
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=tasks");
  const move = page.getByRole("combobox", { name: "Move Mobile layout" }).first();
  await move.waitFor();
  await page.route("**/api/move-task", route => route.fulfill({ status: 409, json: { error: "Move refused in fixture" } }), { times: 1 });
  await move.selectOption("done");
  await page.getByRole("status").filter({ hasText: "Move refused in fixture" }).waitFor({ state: "visible", timeout: 5000 });
  await page.getByRole("combobox", { name: "Move Mobile layout" }).first().selectOption("done");
  await page.getByRole("status").filter({ hasText: "Task moved" }).waitFor({ state: "visible", timeout: 5000 });
});

test("a held terminal draft offers Send anyway when the text has trailing space", browserTest, async (t) => {
  const { fixture, page } = await open(t);
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await page.route("**/api/send", route => route.fulfill({ json: { draftHeld: true } }), { times: 1 });
  await composer.fill("fix it ");
  await page.getByRole("button", { name: /^Send · / }).click();
  await page.getByRole("button", { name: "Send anyway" }).waitFor({ timeout: 5000 });
});

test("a send that fails after a conversation switch keeps the first conversation's draft", browserTest, async (t) => {
  const { fixture, page } = await open(t);
  const first = fixture.url + "/#project=" + fixture.project + "&level=project";
  await page.goto(first);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  const held = Promise.withResolvers();
  const reached = Promise.withResolvers();
  await page.route("**/api/send", async route => { reached.resolve(); await held.promise;
    await route.fulfill({ status: 502, json: { error: "Messaging service unavailable" } }); }, { times: 1 });
  await composer.fill("Draft that outlives a switch");
  await page.getByRole("button", { name: /^Send · / }).click();
  await reached.promise;
  await page.evaluate(() => { location.hash = "project=decision-second&level=project"; });
  await page.getByText("Project · decision-second", { exact: true }).waitFor();
  await page.waitForFunction(() => document.getElementById("composer")?.value === "");
  held.resolve();
  await page.waitForFunction(() => !document.getElementById("composer")?.disabled);
  await page.goto(first);
  await page.waitForFunction(() => document.getElementById("composer")?.value === "Draft that outlives a switch", undefined, { timeout: 5000 });
  assert.equal(await composer.inputValue(), "Draft that outlives a switch");
});
