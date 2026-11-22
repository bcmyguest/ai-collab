// Loads the UI in headless Chrome after a deploy; exits 1 on a page error or a crash screen.
import { chromium } from "/home/b/ai-collab/node_modules/playwright-core/index.mjs";
const b = await chromium.launch({ executablePath: "/home/b/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome" });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 300)); });
p.on("pageerror", e => errs.push("pageerror: " + String(e).slice(0, 300)));
p.on("response", r => { if (r.status() >= 400) errs.push(r.status() + " " + r.url()); });
await p.goto(process.argv[2] || "http://127.0.0.1:8795/", { waitUntil: "domcontentloaded", timeout: 20000 });
await p.waitForTimeout(6000);

console.log(errs.slice(0, 15).join("\n") || "no errors");
console.log("text:", (await p.innerText("body")).slice(0, 300).replace(/\n+/g, " | "));
await b.close();
const body = errs.join("\n");
if (/pageerror|couldn.t load/.test(body) || errs.some(e => e.startsWith("pageerror"))) process.exit(1);
