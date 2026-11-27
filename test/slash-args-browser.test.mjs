import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { CLAUDE_PERMISSION_VALUES } from "../web/lib/permission-modes.js";
import { phoneFixture } from "../tools/smoke-ui.mjs";

test("the composer suggests /permission values and inserts the one picked with the keyboard", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async (t) => {
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(fixture.url + "/#" + new URLSearchParams({ project: fixture.project, level: "session", harness: "claude", session: fixture.address }));
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.click();
  await composer.pressSequentially("/permission ");
  const list = page.getByRole("listbox", { name: "Values for /permission" });
  await list.waitFor();
  assert.deepEqual(await list.getByRole("option").evaluateAll(nodes => nodes.map(node => node.querySelector(".font-mono").textContent)), CLAUDE_PERMISSION_VALUES);
  await composer.press("ArrowDown");
  assert.equal(await list.getByRole("option", { selected: true }).locator(".font-mono").textContent(), CLAUDE_PERMISSION_VALUES[1]);
  await composer.press("Enter");
  assert.equal(await composer.inputValue(), "/permission " + CLAUDE_PERMISSION_VALUES[1]);
  await list.waitFor({ state: "detached" });

  await composer.fill("");
  await composer.pressSequentially("/permission pl");
  await list.getByRole("option").first().waitFor();
  assert.equal(await list.getByRole("option").count(), 1);
  await composer.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.equal(await composer.inputValue(), "/permission pl");
});
