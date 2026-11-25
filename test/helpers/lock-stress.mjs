// Multi-process lock stress: runs workers against one lock file and totals their overlaps, deaths and leftovers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER = fileURLToPath(new URL("./lock-worker.mjs", import.meta.url));

function runWorker(impl, file, iters, crashEvery) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, pathToFileURL(impl).href, file, String(iters), String(crashEvery)]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** Runs workers for implA (nA of them) and implB (nB), then reports overlaps, deaths and leftover files. */
export async function runStress({ implA, nA, implB, nB, iters, crashEvery }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockstress-"));
  const file = path.join(dir, "x.json");
  const impls = [...Array(nA).fill(implA), ...Array(nB).fill(implB)];
  const totals = { violations: 0, busy: 0, done: 0, crashed: 0, deaths: 0, firstError: "" };
  const runs = await Promise.all(impls.map((impl) => runWorker(impl, file, iters, crashEvery)));
  for (const run of runs) {
    if (run.code !== 0) {
      totals.deaths++;
      totals.firstError ||= run.err.trim();
      continue;
    }
    for (const line of run.out.trim().split("\n")) {
      const j = JSON.parse(line);
      totals.violations += j.violations;
      totals.busy += j.busy;
      totals.done += j.done;
      if (j.crashed) totals.crashed++;
    }
  }
  return { ...totals, dir, file };
}
