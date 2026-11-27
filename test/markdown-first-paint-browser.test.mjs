// A new agent message with markdown shows its list and bold markup in the first DOM state that holds its text, in project and session chat.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { phoneFixture } from "../tools/smoke-ui.mjs";
import { buildActivity } from "../lib/activity.ts";
import { activityTopic } from "../lib/config.ts";

const browserTest = { skip: process.env.AI_COLLAB_BROWSER_TEST !== "1", timeout: 60_000 };
const BODY = "Heads up:\n\n- zebra-one\n- **zebra-two**";

// Records every distinct markup of the elements holding "zebra-one" from now on.
function watch() {
  window.__seen = [];
  const log = () => {
    const hits = [...document.querySelectorAll("main *")].filter(el => el.textContent.includes("zebra-one") && ![...el.children].some(child => child.textContent.includes("zebra-one")));
    const html = hits.map(el => el.outerHTML).join("|");
    if (html && window.__seen.at(-1) !== html) window.__seen.push(html);
  };
  new MutationObserver(log).observe(document.body, { subtree: true, childList: true, characterData: true });
}

for (const level of ["project", "session"]) {
  test(`a markdown agent message is formatted on its first paint in the ${level} chat`, browserTest, async (t) => {
    const fixture = await phoneFixture({ peers: "claude" });
    t.after(() => fixture.close());
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const session = level === "session" ? "&level=session&harness=claude&session=" + encodeURIComponent(fixture.address) : "&level=project";
    await page.goto(fixture.url + "/#project=" + fixture.project + session);
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.evaluate(watch);
    const label = fixture.address.split("#")[1];
    const act = event => fixture.inject(activityTopic(fixture.project), buildActivity({ project: fixture.project, peer: "claude", session: label }, "claude", event).message);
    // A running turn's text, then the same reply over the bus, then the stop that folds the turn.
    act({ type: "prompt", input: "reply please" });
    act({ type: "text", output: BODY });
    fixture.inject(fixture.broadcast[0], JSON.stringify({ v: 1, kind: "msg", from: "claude", session: label, harness: "claude", to: "all", body: BODY }));
    act({ type: "stop", input: "turn ended" });
    await page.locator("main li", { hasText: "zebra-one" }).first().waitFor();
    await page.waitForTimeout(1000);
    const seen = await page.evaluate(() => window.__seen);
    assert.ok(seen.length > 0, "the message rendered");
    for (const html of seen) assert.match(html, /^<li>zebra-one<\/li>(\|<li>zebra-one<\/li>)*$/, "every state shows the list item: " + html.slice(0, 160));
  });
}
