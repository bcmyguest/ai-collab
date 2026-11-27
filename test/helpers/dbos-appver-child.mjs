// Repro child: phase=start starts a pending workflow then SIGKILLs; phase=relaunch registers one more workflow and reports recovery.
import fs from "node:fs";
const [phase, id, markFile, extra] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-review-appver.test.mjs.
if (!["start", "relaunch"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.ts`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule
wf.register("av.slow", async (ctx) => {
  fs.appendFileSync(String(ctx.input.markFile), "entered\n");
  await ctx.step("s", async () => { await new Promise((r) => setTimeout(r, phase === "start" ? 30_000 : 100)); return 1; });
  return "ok";
});
if (extra === "1") wf.register("av.extra", async () => "x");
if (phase === "start") {
  swallow(wf.startWorkflow("av.slow", id, { markFile })); // the SIGKILL below abandons it mid-step
  await new Promise((r) => setTimeout(r, 3_000));
  process.kill(process.pid, "SIGKILL");
} else {
  await wf.pending();
  await new Promise((r) => setTimeout(r, 4_000));
  const st = await wf.status(id);
  console.log(JSON.stringify({ status: st?.status, marks: fs.readFileSync(markFile, "utf8").trim().split("\n") }));
  await wf.close();
  process.exit(0);
}
