// Lock holder for the store model test. Usage: node lock-holder.mjs <implUrl> <file> <waitMs> <staleMs> <id> <releaseFile>
import fs from "node:fs";

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const HOLD_LIMIT_MS = 30000;

// node --test imports every file under test/; only a spawned holder passes arguments.
if (process.argv.length > 2) await runHolder(process.argv.slice(2));

async function runHolder([impl, file, waitMs, staleMs, id, releaseFile]) {
  const { withLockSync } = await import(impl);
  const marker = `${file}.inside`;
  const say = (line) => fs.writeSync(1, `${line}\n`);
  const result = withLockSync(file, () => {
    let created = false;
    let violation = 0;
    try {
      fs.writeFileSync(marker, id, { flag: "wx" });
      created = true;
    } catch {
      violation = 1;
    }
    say(`IN ${violation}`);
    const deadline = Date.now() + HOLD_LIMIT_MS;
    while (!fs.existsSync(releaseFile) && Date.now() < deadline) Atomics.wait(SLEEP_CELL, 0, 0, 5);
    if (created) fs.rmSync(marker, { force: true });
  }, { waitMs: Number(waitMs), staleMs: Number(staleMs) });
  if (!result.locked) say("BUSY");
}
