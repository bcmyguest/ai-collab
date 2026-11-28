// Starting agents in a thread (docs/threads.md "Thread view"): the composer's thread picker, the Add agent button,
// and the sidebar's Project chat entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };

test("Add agent starts in the open thread; New thread sends no thread; Project chat opens the project chat", browserTest, async (t) => {
  const fixture = await phoneFixture({ threads: true, peers: "claude,codex,cursor,opencode" });
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // The start request is what the UI decides; the server's thread start has its own tests.
  const starts = [];
  await page.route("**/api/start", route => {
    starts.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ status: "started", detail: "started" }) });
  });
  const [thread] = fixture.threads;
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=thread&thread=" + thread.id);
  await page.getByRole("heading", { level: 1, name: "UI redesign" }).waitFor();

  await page.getByRole("button", { name: "Add agent to UI redesign" }).click();
  await page.getByRole("heading", { name: "New agent in UI redesign" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Thread: UI redesign" }).count(), 1);
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  await prompt.fill("Check the contrast");
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForFunction(() => document.querySelector('[data-new-session-status="started"]'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0].thread, thread.id);
  for (const key of ["place", "worktree", "openshell", "base", "branch", "worktreePath", "codeMode"]) assert.equal(starts[0][key], undefined, key);

  // Back to New thread in the picker: no thread on the start.
  await page.getByRole("button", { name: "Thread: UI redesign" }).click();
  await page.getByRole("option", { name: "New thread" }).click();
  await page.getByRole("heading", { name: "New thread", exact: true }).waitFor();
  await prompt.fill("Fresh work");
  await page.getByRole("button", { name: "Start session" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-new-session-status="started"]').length > 0);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].thread, undefined);

  // The sidebar's Project chat opens the project chat.
  await page.goto(fixture.url + "/#project=" + fixture.project + "&level=thread&thread=" + thread.id);
  await page.getByRole("button", { name: "Project chat", exact: true }).click();
  await page.waitForFunction(() => location.hash.includes("level=project"));
});
