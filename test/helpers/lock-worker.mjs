// Stress worker for store locks. Usage: node lock-worker.mjs <implUrl> <file> <iters> <crashEvery>
import fs from "node:fs";

// node --test imports every file under test/; only a spawned worker passes arguments.
if (process.argv.length > 2) await runWorker(process.argv.slice(2));

async function runWorker([impl, file, iters, crashEvery]) {
  const { withLockSync } = await import(impl);
  const marker = `${file}.inside`;
  let violations = 0, busy = 0, done = 0;
  for (let i = 0; i < Number(iters); i++) {
    const r = withLockSync(file, () => {
      let fd;
      try { fd = fs.openSync(marker, "wx"); } catch { violations++; return; }
      const crash = Number(crashEvery) > 0 && Math.random() < 1 / Number(crashEvery);
      if (crash) { fs.closeSync(fd); fs.unlinkSync(marker); process.stdout.write(JSON.stringify({ violations, busy, done, crashed: true }) + "\n"); process.exit(0); }
      for (let k = 0; k < 2000; k++) Math.sqrt(k);
      fs.closeSync(fd); fs.unlinkSync(marker);
      done++;
    }, { waitMs: 20000, staleMs: 40000 });
    if (!r.locked) busy++;
  }
  process.stdout.write(JSON.stringify({ violations, busy, done }) + "\n");
}
