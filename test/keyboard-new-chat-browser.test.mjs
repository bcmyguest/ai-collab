// From page load, Tab reaches New thread in a fixed number of stops, every stop shows a focus ring, and Enter opens the new-session prompt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const LAYOUTS = [
  { width: 1280, stops: ["ai-collab", "decision-first", "New thread in decision-first"] },
  { width: 390, stops: ["Threads", "New thread in decision-first"] },
];

// The focused element's name and whether an outline or a spread box-shadow in the opaque accent colour rings it.
function focused() {
  const probe = document.createElement("i");
  probe.style.color = "var(--primary)";
  document.body.append(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const el = document.activeElement;
  const style = getComputedStyle(el);
  const outline = style.outlineStyle === "solid" && parseFloat(style.outlineWidth) >= 2 && style.outlineColor === accent;
  const shadows = [...style.boxShadow.matchAll(/([a-z]+\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g)];
  const ring = shadows.some(([, color, , , , spread]) => Number(spread) >= 2 && color === accent);
  return { name: el.getAttribute("aria-label") || el.textContent.trim(), ring: outline || ring, tabIndex: el.tabIndex };
}

async function until(check, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(done => setTimeout(done, 50))) {
    if (await check()) return;
  }
  throw new Error("timed out");
}

for (const { width, stops } of LAYOUTS) {
  test(`Tab ${stops.length} times reaches New thread at ${width}px and Enter opens the prompt`, {
    skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
    timeout: 30_000,
  }, async (t) => {
    const fixture = await phoneFixture({ peers: "claude" });
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    for (const stop of stops) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(focused);
      assert.equal(state.name, stop);
      assert.equal(state.tabIndex, 0, `${stop} has no positive tabindex`);
      // Button rings animate in with transition-all, so poll for the end state.
      await assert.doesNotReject(() => until(async () => (await page.evaluate(focused)).ring), `${stop} shows a focus ring`);
    }
    await page.keyboard.press("Enter");
    const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
    await prompt.waitFor();
    assert.equal(await prompt.evaluate(el => el === document.activeElement), true, "the prompt takes focus");
  });
}

test("the sidebar Menu is a menu button: arrow keys move through items and Escape returns focus", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async (t) => {
  const fixture = await phoneFixture({ peers: "claude" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const trigger = page.getByRole("button", { name: "Menu", exact: true });
  await trigger.focus();
  assert.equal(await trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Enter");
  await page.getByRole("menu").waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  const first = await page.evaluate(() => document.activeElement.getAttribute("role") + ":" + document.activeElement.textContent.trim());
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement.getAttribute("role") + ":" + document.activeElement.textContent.trim());
  assert.match(second, /^menuitem/);
  assert.notEqual(second, first);
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true, "Escape returns focus to Menu");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
});
