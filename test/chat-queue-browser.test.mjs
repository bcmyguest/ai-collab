import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";


test("phone chat routes mentions and urgent messages, preserves drafts, and edits or cancels queued sends", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 60_000,
}, async (t) => {
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const projectUrl = fixture.url + "/#" + new URLSearchParams({ project: fixture.project });
  const sessionUrl = fixture.url + "/#" + new URLSearchParams({
    project: fixture.project, level: "session", harness: "claude", session: fixture.address,
  });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await page.goto(projectUrl);
  await composer.fill("Project draft");

  await page.goto(sessionUrl);
  // The fixture session takes its project's name.
  const direct = "Direct to " + fixture.project;
  await page.getByText(direct, { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "");
  await composer.fill("Review the first revision");
  const sent = page.waitForResponse(response => response.url().endsWith("/api/send") && response.status() === 201);
  await page.getByRole("button", { name: "Send · " + direct, exact: true }).click();
  await sent;

  const queue = page.getByRole("region", { name: "Queued messages" });
  const original = queue.getByRole("listitem").filter({ hasText: "Review the first revision" });
  await original.waitFor();
  assert.equal(await page.getByText("No messages yet.", { exact: true }).count(), 0);
  await original.getByRole("button", { name: "Edit", exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message" }).fill("Review the final revision");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  const edited = queue.getByRole("listitem").filter({ hasText: "Review the final revision" });
  await edited.waitFor();
  await edited.getByRole("button", { name: "Cancel", exact: true }).click();
  await queue.waitFor({ state: "hidden" });

  const urgent = "Please review now";
  await composer.fill(urgent);
  const urgentSent = page.waitForResponse(response => response.url().endsWith("/api/send") && response.status() === 201);
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await urgentSent;
  assert.deepEqual(fixture.messageDeliveries(urgent, true), [fixture.direct]);

  await page.goto(projectUrl);
  await composer.waitFor();
  assert.equal(await composer.inputValue(), "Project draft");
  const mention = `Review @${fixture.address}`;
  await composer.fill(mention);
  const mentioned = page.waitForResponse(response => response.url().endsWith("/api/send") && response.status() === 201);
  await page.getByRole("button", { name: "Send · Everyone in " + fixture.project + " · " + direct, exact: true }).click();
  await mentioned;
  assert.deepEqual(fixture.messageDeliveries(mention), [fixture.broadcast, fixture.direct]);
  assert.deepEqual(fixture.messageDeliveries("Review the first revision"), [fixture.direct]);
});
