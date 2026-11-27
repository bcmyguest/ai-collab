// The redesign's browser checks: the bell in project scope, gone-session rows, the tasks strip, the phone bottom sheet and History.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

async function open(t, width, hash, threads = true) {
  const fixture = await phoneFixture({ threads, peers: "claude,codex,cursor,opencode" });
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

test("subagent rows show the parent's harness mark and the model, inherited when the Agent call names none", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project");
  const tree = page.getByRole("list", { name: "Sessions in UI redesign" });
  const live = tree.locator('[data-run="run-live"]');
  const tabs = tree.locator('[data-run="run-tabs"]');
  await live.waitFor();
  assert.equal(await live.locator('[data-harness="claude"]').count(), 1);
  assert.equal(await live.locator("[data-model]").innerText(), " · sonnet");
  assert.equal(await tabs.locator("[data-model]").innerText(), " · opus-5-5 · inherited");
});

// The contrast ratio of an element's text colour on its own background, both resolved through a canvas to sRGB.
function markContrast(el) {
  const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
  const lum = color => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const style = getComputedStyle(el);
  const probe = document.createElement("i");
  probe.style.color = "var(--claude)";
  document.body.append(probe);
  const claude = getComputedStyle(probe).color;
  probe.remove();
  const [a, b] = [lum(style.color), lum(style.backgroundColor)].sort((x, y) => y - x);
  return { tinted: style.color === claude, ratio: (a + 0.05) / (b + 0.05) };
}

test("chat message avatars take the harness tint with at least 3:1 contrast in both themes", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(name => localStorage.setItem("theme", name), theme);
    await page.reload();
    const mark = page.locator('main [data-slot="avatar-fallback"][data-harness="claude"]').first();
    await mark.waitFor();
    const { tinted, ratio } = await mark.evaluate(markContrast);
    assert.equal(tinted, true, theme + ": the avatar uses --claude");
    assert.ok(ratio >= 3, theme + ": contrast " + ratio.toFixed(2));
  }
});

test("threads with no live session sit under Settled, which starts collapsed once it grows long", browserTest, async (t) => {
  const { page } = await open(t, 1440, "level=project", 6);
  const active = page.locator('[data-group="active"]');
  const settled = page.locator('[data-group="settled"]');
  const toggle = settled.getByRole("button", { expanded: false });
  await toggle.waitFor();
  assert.match(await toggle.innerText(), /Settled\s*8/);
  await toggle.click();
  await settled.locator('[data-thread="th_00000000000000a3"]').waitFor();
  assert.equal(await active.locator('[data-thread="th_00000000000000a3"]').count(), 0);
  assert.equal(await page.locator('[data-group="working"] [data-thread="th_00000000000000a1"]').count(), 1);
});
