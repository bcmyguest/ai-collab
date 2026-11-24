// Snapshot every operator screen and diff it. A model runs this; it does not open a model.
//   node tools/screen-state.mjs --write base.json
//   node tools/screen-state.mjs --against base.json
// The second command prints which screens changed and the added or removed lines. Exit 1 when a
// compared screen differs, 0 when they match or when there is nothing to compare.
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { phoneFixture } from "./smoke-ui.mjs";

export const SCREENS = [
  ["home", "#home"],
  ["inbox", "#inbox"],
  ["chat", "#project=PROJECT&level=project"],
  ["tasks", "#project=PROJECT&level=tasks"],
  ["patterns", "#project=PROJECT&level=patterns"],
  ["session", "#project=PROJECT&level=session&harness=claude&session=SESSION"],
  ["compactions", "#project=PROJECT&level=compactions"],
];

const AGE = /\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s+ago\b/gi;

/** Stable lines for one screen: ages and clock times removed, blank lines dropped. */
export function normalizeScreen(text) {
  return String(text)
    .replace(AGE, "AGE")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "CLOCK")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Screens whose lines differ. Each entry names the screen and the lines only on one side. */
export function diffScreens(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = [];
  for (const screen of names) {
    const left = before[screen] || [];
    const right = after[screen] || [];
    if (left.join("\n") === right.join("\n")) continue;
    const rightSet = new Set(right);
    const leftSet = new Set(left);
    changes.push({
      screen,
      removed: left.filter(line => !rightSet.has(line)),
      added: right.filter(line => !leftSet.has(line)),
    });
  }
  return changes;
}

export function formatDiff(changes) {
  if (!changes.length) return "no screen changed";
  return changes.map(change => {
    const lines = [`${change.screen} changed`];
    for (const line of change.removed) lines.push(`- ${line}`);
    for (const line of change.added) lines.push(`+ ${line}`);
    return lines.join("\n");
  }).join("\n");
}

async function readScreen(page) {
  const text = await page.evaluate(() => {
    const root = document.querySelector("main") || document.body;
    const bits = [];
    for (const el of root.querySelectorAll("h1,h2,h3,button,a,[role=region],[data-task-column]")) {
      const name = (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      bits.push(`${el.tagName.toLowerCase()}:${name.slice(0, 160)}`);
    }
    return bits.join("\n");
  });
  return normalizeScreen(text);
}

export async function captureScreens(page, { url, project, session }) {
  const shots = {};
  for (const [name, hash] of SCREENS) {
    const path = hash.replace("PROJECT", project).replace("SESSION", encodeURIComponent(session));
    await page.goto(url + "/" + path, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(400);
    shots[name] = await readScreen(page);
  }
  return shots;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1]?.endsWith("screen-state.mjs")) {
  const chrome = process.env.CHROME_PATH || "/home/b/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
  const fixture = await phoneFixture({ homeSessions: true, kanban: true });
  const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const session = fixture.sessions?.[0]?.id || fixture.address;
    const shots = await captureScreens(page, { url: fixture.url, project: fixture.project, session });
    const write = arg("--write");
    if (write) writeFileSync(write, JSON.stringify(shots, null, 2) + "\n");
    const against = arg("--against");
    if (against) {
      const before = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(against, "utf8")));
      const changes = diffScreens(before, shots);
      console.log(formatDiff(changes));
      if (changes.length) process.exitCode = 1;
    } else {
      for (const [name, lines] of Object.entries(shots)) {
        console.log(`# ${name}`);
        console.log(lines.slice(0, 12).join("\n") || "(empty)");
        console.log("");
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
}
