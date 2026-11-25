// Stuck-release scenario: a dead owner's lock, then a holder that releases but stays alive, then a late caller.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns the most holders seen at once, whether each caller locked, and leftover files. */
export async function runStuck(impl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockstuck-"));
  const file = path.join(dir, "x.json");
  fs.mkdirSync(`${file}.lock`);
  fs.writeFileSync(`${file}.lock/owner.json`, JSON.stringify({ pid: 999999, host: os.hostname(), token: "dead" }));
  const child = `
    const { withLockSync } = await import(${JSON.stringify(pathToFileURL(impl).href)});
    const fs = await import("node:fs");
    const [name, hold, linger, waitMs] = process.argv.slice(1);
    const log = ${JSON.stringify(file)} + ".log";
    const r = withLockSync(${JSON.stringify(file)}, () => {
      fs.appendFileSync(log, name + " in " + Date.now() + "\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold));
      fs.appendFileSync(log, name + " out " + Date.now() + "\\n");
    }, { waitMs: Number(waitMs) });
    console.log(name, r.locked);
    if (Number(linger)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(linger));`;
  const run = (name, hold, linger, waitMs) => new Promise((resolve) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", child, name, String(hold), String(linger), String(waitMs)]);
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("close", () => resolve(out.trim()));
  });
  const jobs = [];
  jobs.push(run("B", 0, 0, 2000));
  await sleep(200);
  jobs.push(run("C", 500, 3000, 2000));
  await sleep(1000);
  jobs.push(run("E", 100, 0, 2000));
  const results = await Promise.all(jobs);
  const events = fs.readFileSync(`${file}.log`, "utf8").trim().split("\n").map((l) => l.split(" "));
  let inside = 0;
  let maxHolders = 0;
  for (const [, kind] of events.sort((a, b) => a[2] - b[2])) {
    inside += kind === "in" ? 1 : -1;
    maxHolders = Math.max(maxHolders, inside);
  }
  return { results, maxHolders, leftover: fs.readdirSync(dir).filter((name) => name !== "x.json.log").sort() };
}
