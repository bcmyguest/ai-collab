import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

test("phone Home identifies the deployed commit with no reviewed changes", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 30_000,
}, async t => {
  const [commit, subject] = execFileSync("git", ["log", "-1", "--format=%H%n%s"], { encoding: "utf8" }).trimEnd().split("\n", 2);
  const fixture = await phoneFixture();
  t.after(() => fixture.close());
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(fixture.url);
  const deployment = page.getByRole("region", { name: "Deployment", exact: true });
  await deployment.getByText(commit.slice(0, 8), { exact: true }).waitFor();
  assert.equal(await deployment.getByTitle(commit, { exact: true }).count(), 1);
  assert.equal(await deployment.getByText(subject, { exact: true }).count(), 1);
  assert.equal(await deployment.getByRole("button", { name: "Mark all seen" }).count(), 0);
  if (process.env.AI_COLLAB_DEPLOYMENT_SCREENSHOT) await deployment.screenshot({ path: process.env.AI_COLLAB_DEPLOYMENT_SCREENSHOT });
});
