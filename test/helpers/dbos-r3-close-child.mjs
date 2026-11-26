// Repro child (r3 review R1): phase=close starts runs that wait on the context signal, then closes the engine
// gracefully (a runner restart); phase=relaunch recovers them. Each prints a JSON report.
const [phase, stamp] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-r3-close.test.mjs.
if (!["close", "relaunch"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.mjs`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
const untilAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule
let bodies = 0;
// A pause between steps (the delivery poll), and a signal-aware step with an onCut (a harness turn).
wf.register("r3r.pause", async (ctx) => {
  await ctx.step("a", async () => 1);
  await ctx.pause(phase === "close" ? 60_000 : 10);
  return "resumed";
});
wf.register("r3r.step", async (ctx) => await ctx.step("turn", async () => {
  bodies += 1;
  if (phase === "close") await untilAbort(ctx.signal);
  return "ran";
}, { onCut: () => "cut" }));
const ids = { pause: `r3r-pause-${stamp}`, step: `r3r-step-${stamp}` };
if (phase === "close") {
  for (const [name, id] of Object.entries(ids)) swallow(wf.startWorkflow(`r3r.${name}`, id, {}));
  await new Promise((r) => setTimeout(r, 1500));
  await wf.close();
  console.log(JSON.stringify({ bodies }));
} else {
  await wf.recover();
  const out = {};
  for (const [name, id] of Object.entries(ids)) out[name] = await wf.result(id).catch((e) => `error ${e.message}`);
  await wf.close();
  console.log(JSON.stringify({ bodies, out }));
}
