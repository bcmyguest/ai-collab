// The sidebar's thread row menu in the browser (docs/threads.md "Sidebar"): where each thread runs, the per-thread
// actions, the rename dialog, and Archive inactive behind a confirm with the count.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };
// Screenshots go where the operator asked when set, else nowhere.
const SHOTS = process.env.AI_COLLAB_SHOTS_DIR || "";

test("a thread row's menu renames, pins and archives it, and Archive inactive asks with the count", browserTest, async (t) => {
  // 25 old threads: the oldest few are past 24 h with every session gone, so Archive inactive finds them.
  const fixture = await phoneFixture({ threads: 25, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const ops = [];
  page.on("request", request => { if (request.url().endsWith("/api/thread") && request.method() === "POST") ops.push(JSON.parse(request.postData() || "{}")); });
    const posted = async (op) => {
    for (let i = 0; i < 50 && !ops.some(o => o.op === op); i++) await new Promise(resolve => setTimeout(resolve, 100));
    return ops.find(o => o.op === op);
  };
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
  const sidebar = page.getByRole("complementary", { name: "Projects and threads" });
  const [redesign] = fixture.threads;

  // Each row says where it runs: the worktree folder or main, then the branch.
  await sidebar.locator('[data-place="switchover-plan"]').waitFor();
  assert.equal(await sidebar.locator('[data-place="switchover-plan"]').first().textContent(), "switchover-plan · feat/ui-redesign-v2");
  // The fixture session is offline, so its thread sits in the Settled group, collapsed past five rows.
  await sidebar.getByRole("button", { name: /^Settled/ }).click();
  assert.equal(await sidebar.locator('[data-place="main"]').first().textContent(), "main · fix/composer-keep-focus");

  const trigger = sidebar.getByRole("button", { name: "Thread actions for UI redesign" });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Rename…", "Pin", "Settle", "Snooze", "Archive"]);
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: SHOTS + "/thread-menu.png", clip: { x: 0, y: 0, width: 560, height: 900 } });
  }
  await menu.getByRole("menuitem", { name: "Pin" }).click();
  assert.deepEqual(await posted("pin"), { project: fixture.project, op: "pin", thread: redesign.id, pinned: true });

  // Keyboard: open the menu, choose Rename, type a title and press Enter.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  const title = page.getByRole("dialog", { name: "Rename thread" }).getByRole("textbox", { name: "Title" });
  await title.fill("Sidebar redesign");
  await page.keyboard.press("Enter");
  assert.deepEqual(await posted("rename"), { project: fixture.project, op: "rename", thread: redesign.id, title: "Sidebar redesign" });
  await page.getByRole("dialog", { name: "Rename thread" }).waitFor({ state: "hidden" });

  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive" }).click();
  assert.deepEqual(await posted("status"), { project: fixture.project, op: "status", thread: redesign.id, status: "archived" });

  await sidebar.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Archive inactive/ }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.waitFor();
  const count = Number((await confirm.getByRole("heading").first().textContent() || (await confirm.textContent()) || "").match(/Archive (\d+) inactive/)?.[1]);
  assert.ok(count > 0, "the confirm shows how many threads it archives");
  if (SHOTS) await page.screenshot({ path: SHOTS + "/archive-inactive.png" });
  await confirm.getByRole("button", { name: "Archive " + count }).click();
  const archive = await posted("archive");
  assert.equal(archive.threads.length, count);
  assert.ok(!archive.threads.includes(redesign.id), "a thread with a live session stays");
});
