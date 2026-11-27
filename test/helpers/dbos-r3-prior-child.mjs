// Repro child (r3 B): phase=broken boots with an always-failing prior-steps query and starts a run;
// phase=healthy boots normally under the same version and recovers it. Each prints a JSON report.
const [phase, id] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-r3-prior-steps.test.mjs.
if (!["broken", "healthy"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.ts`);
const broken = phase === "broken" ? { priorStepsQuery: async () => { throw new Error("blip"); }, priorStepsRetry: { attempts: 2, delayMs: 10 } } : {};
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION, ...broken });
let ran = 0;
wf.register("r3b.flow", async (ctx) => { await ctx.step("s", async () => { ran += 1; return 1; }); return "done"; });
if (phase === "broken") {
  const started = await wf.startWorkflowOnce("r3b.flow", id, {});
  await new Promise((r) => setTimeout(r, 1500));
  const status = (await wf.status(id))?.status ?? null;
  await wf.close();
  console.log(JSON.stringify({ started, ran, status }));
} else {
  await wf.recover();
  const out = await wf.result(id);
  await wf.close();
  console.log(JSON.stringify({ ran, out }));
}
