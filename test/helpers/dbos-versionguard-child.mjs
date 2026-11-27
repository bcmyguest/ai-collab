// Repro child (reviewer finding 2): phase=orphan leaves a PENDING run under an old application version;
// phase=check boots under a new version with AI_COLLAB_DBOS_VERSION_GUARD set and reports what happened.
const [phase, id] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-review-versionguard.test.mjs.
if (!["orphan", "check"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.ts`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule
wf.register("vg.flow", async (ctx) => await ctx.recv("inbox"));
if (phase === "orphan") {
  swallow(wf.startWorkflow("vg.flow", id, {})); // blocks on recv; the SIGKILL below leaves it PENDING
  await new Promise((r) => setTimeout(r, 2_000));
  process.kill(process.pid, "SIGKILL");
} else {
  let error = null;
  try { await wf.pending(); } catch (e) { error = e.message; }
  const st = error ? null : await wf.status(id);
  console.log(JSON.stringify({ error, status: st?.status ?? null }));
  process.exit(0);
}
