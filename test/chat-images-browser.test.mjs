import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { phoneFixture } from "../tools/smoke-ui.mjs";

test("phone chat previews, queues, delivers and displays images both ways", {
  skip: process.env.AI_COLLAB_BROWSER_TEST !== "1",
  timeout: 60_000,
}, async () => {
  const fixture = await phoneFixture();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(fixture.url + "/#project=" + fixture.project + "&level=session&session=" + fixture.address);
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.waitFor();
    const pixels = await sharp({ create: { width: 220, height: 100, channels: 3, background: "#2d7866" } }).png().toBuffer();
    const attach = page.getByRole("button", { name: "Attach image", exact: true });

    const selectFile = async (trigger, name, buffer, mimeType) => {
      const chooser = page.waitForEvent("filechooser");
      await trigger.click();
      await (await chooser).setFiles({ name, buffer, mimeType });
    };
    await selectFile(attach, "phone.png", pixels, "image/png");
    const remove = page.getByRole("button", { name: "Remove image", exact: true });
    await remove.waitFor();
    const replace = page.getByRole("button", { name: "Replace image", exact: true });
    await selectFile(replace, "notes.txt", Buffer.from("not an image"), "text/plain");
    await page.getByRole("alert").getByText("Choose a PNG, JPEG, GIF, or WebP image.").waitFor();
    assert.equal(await remove.count(), 1, "an invalid replacement keeps the original image");
    await remove.click();
    assert.equal(await message.evaluate(input => document.activeElement === input), true);

    await selectFile(attach, "phone.png", pixels, "image/png");
    const send = page.getByRole("button", { name: /^Send · Direct to / });
    await send.click();
    const queue = page.getByRole("region", { name: "Queued messages" });
    const pendingImage = queue.getByRole("link", { name: "phone.png" }).locator("img");
    await pendingImage.waitFor();
    assert.equal(await pendingImage.evaluate(image => image.decode().then(() => image.naturalWidth)), 220);

    await fixture.replyWithImage(pixels);
    const image = page.getByRole("link", { name: "agent.png" }).locator("img");
    await image.waitFor();
    assert.equal(await image.evaluate(node => node.decode().then(() => node.naturalWidth)), 220);
    await page.getByText("Here’s the result.", { exact: true }).waitFor();
    assert.equal(await queue.count(), 0);
    await page.reload();
    await page.getByRole("link", { name: "phone.png" }).waitFor();
    await page.getByRole("link", { name: "agent.png" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.AI_COLLAB_CHAT_SCREENSHOT) await page.screenshot({ path: process.env.AI_COLLAB_CHAT_SCREENSHOT });
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
