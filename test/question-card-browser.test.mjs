// An ask_question card in the project chat: options select by click and by keyboard, and Submit posts the answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";

const ID = "0a1b2c3d4e5f";
const ROLLOUT = "How should I roll out the payments worker upgrade?";
const CHECKS = "Which tests should run before I push?";

for (const width of [390, 1280]) {
  test(`question card selects by click and keyboard and submits at ${width}px`, {
    skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
    timeout: 30_000,
  }, async (t) => {
    const fixture = await phoneFixture({ peers: "claude" });
    t.after(() => fixture.close());
    const [topic] = fixture.broadcast;
    const session = fixture.address.split("#")[1];
    fixture.inject(topic, JSON.stringify({ v: 1, kind: "approval", from: "claude", session, harness: "claude", id: ID, tool: "ask_question",
      summary: ROLLOUT, expiresAt: 0, questions: [
        { question: ROLLOUT, header: "", multiSelect: false, options: [
          { label: "Blue-green", description: "Second stack, switch the load balancer." },
          { label: "Rolling", description: "Replace pods two at a time." },
          { label: "Canary", description: "Route 5% of traffic first." },
        ] },
        { question: CHECKS, header: "", multiSelect: true, options: [
          { label: "Unit", description: "node --test" },
          { label: "Browser", description: "Playwright against the built UI" },
        ] },
      ] }));
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.goto(fixture.url + "/#project=" + fixture.project + "&level=project");
    const card = page.locator(`[data-surface='approval-${ID}']`);
    const rollout = card.getByRole("radiogroup", { name: ROLLOUT });
    const checks = card.getByRole("group", { name: CHECKS });
    await rollout.waitFor();

    const tall = await rollout.getByRole("radio").evaluateAll(els => els.every(el => el.getBoundingClientRect().height >= 44));
    assert.equal(tall, true, "every option row is at least 44px tall");

    await rollout.getByRole("radio", { name: "Blue-green" }).click();
    assert.equal(await rollout.getByRole("radio", { name: "Blue-green" }).getAttribute("aria-checked"), "true");
    await page.keyboard.press("ArrowDown");
    assert.equal(await rollout.getByRole("radio", { name: "Rolling" }).getAttribute("aria-checked"), "true", "ArrowDown moves the choice");
    assert.equal(await rollout.getByRole("radio", { name: "Blue-green" }).getAttribute("aria-checked"), "false");

    await checks.getByRole("checkbox", { name: "Unit" }).click();
    await page.keyboard.press("Tab");
    assert.equal(await checks.getByRole("checkbox", { name: "Browser" }).evaluate(el => el === document.activeElement), true, "Tab reaches the next checkbox");
    await page.keyboard.press("Space");
    for (const name of ["Unit", "Browser"]) assert.equal(await checks.getByRole("checkbox", { name }).getAttribute("aria-checked"), "true", name);

    await card.getByRole("button", { name: "Submit", exact: true }).click();
    let sent;
    for (const end = Date.now() + 5000; !sent && Date.now() < end; await new Promise(done => setTimeout(done, 50))) {
      sent = fixture.published().find(([, message]) => message.startsWith(`reply ${ID} `));
    }
    assert.ok(sent, "Submit posts a reply");
    assert.deepEqual(JSON.parse(sent[1].slice(`reply ${ID} `.length)), { [ROLLOUT]: "Rolling", [CHECKS]: "Unit, Browser" });
  });
}
