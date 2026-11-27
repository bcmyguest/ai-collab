// The redesign's browser checks: the bell in project scope, gone-session rows, the tasks strip, the phone bottom sheet and History.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

async function open(t, width, hash) {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width > 600 ? 900 : 844 } });
  await page.goto(fixture.url + "/#project=" + fixture.project + "&" + hash);
  return { fixture, page };
}

test("the bell counts both projects' decisions in project scope and lists them", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project");
  const bell = page.locator("[data-decisions]");
  await page.locator('[data-decisions="2"]').waitFor();
  await bell.click();
  await page.getByText("Waiting on you · 2", { exact: true }).waitFor();
  await page.getByRole("menuitem", { name: "Open decision inbox" }).click();
  await page.getByRole("region", { name: "Decision inbox" }).waitFor();
});

test("a gone session stays in its thread, dimmed, and opens its history", browserTest, async (t) => {
  const { fixture, page } = await open(t, 1440, "level=project");
  const [, , gone, missing] = fixture.threads[0].sessions;
  const row = page.locator(`[data-session="${gone}"]`).first();
  await row.waitFor();
  assert.equal(await row.getAttribute("data-gone"), "true");
  await row.click();
  await page.waitForFunction(id => decodeURIComponent(location.hash).includes("session=" + id), gone);
  await page.locator(`[data-session="${missing}"]`).first().click();
  await page.getByText("This session has ended, and the recent history holds none of its messages.").waitFor();
  assert.equal(await page.getByText("No messages yet").count(), 0);
});

test("the tasks strip lists the open task with its count and opens it", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project");
  const strip = page.getByRole("region", { name: "Open tasks" });
  await strip.getByLabel("1 open task", { exact: true }).waitFor();
  await strip.getByRole("button", { name: /Mobile layout/ }).click();
  await page.waitForFunction(() => location.hash.includes("level=tasks") && location.hash.includes("task="));
});

test("on a phone the header opens tasks and the session panel as a bottom sheet", browserTest, async (t) => {
  const { fixture, page } = await open(t, 390, "level=project");
  await page.getByRole("button", { name: "Open tasks", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Thread panel" });
  await sheet.getByRole("tab", { name: "Tasks" }).waitFor();
  await sheet.getByText("Mobile layout").first().waitFor();
  const box = await sheet.boundingBox();
  assert.ok(box && box.y > 0 && box.y + box.height <= 844 + 1, "the sheet rises from the bottom edge");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  const lead = fixture.threads[0].sessions[0];
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&harness=claude&session=" + encodeURIComponent(lead));
  await page.getByRole("button", { name: "Switch thread" }).waitFor();
  await page.getByRole("button", { name: "Open panel", exact: true }).click();
  await sheet.getByRole("tab", { name: "Activity" }).waitFor();
  await sheet.getByRole("tab", { name: "Tasks" }).click();
  await sheet.getByText("Mobile layout").first().waitFor();
});

test("the compaction map is called History in the menu and the view", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
  await page.waitForFunction(() => location.hash.includes("level=compactions"));
  await page.getByRole("region", { name: "History" }).or(page.locator('[aria-label="History"]')).first().waitFor();
  assert.equal(await page.getByText(/compaction map/i).count(), 0);
});

test("a thread lists its lead, child session and both running subagents, and counts them when collapsed", browserTest, async (t) => {
  const { fixture, page } = await open(t, 1440, "level=project");
  const [lead, child] = fixture.threads[0].sessions;
  const tree = page.getByRole("list", { name: "Sessions in UI redesign" });
  await tree.locator(`[data-session="${lead}"]`).waitFor();
  await tree.locator(`[data-session="${child}"]`).waitFor();
  await tree.locator('[data-run="run-live"]').waitFor();
  await tree.locator('[data-run="run-tabs"]').waitFor();
  const row = page.locator('[data-thread="th_00000000000000a1"]');
  assert.equal(await row.getAttribute("data-working"), "4");
  await page.getByRole("button", { name: "Hide sessions in UI redesign" }).click();
  await tree.waitFor({ state: "detached" });
  await row.getByText("4 working", { exact: true }).waitFor();
});
