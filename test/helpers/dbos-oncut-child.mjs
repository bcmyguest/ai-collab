// Repro child: phase=start starts a workflow whose long step is cut by SIGKILL; phase=relaunch recovers it and reports.
import fs from "node:fs";
const [phase, id, markFile] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-review-oncut.test.mjs.
if (!["start", "relaunch"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.mjs`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl() });
const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule
wf.register("oc.flow", async (ctx) => {
  fs.appendFileSync(String(ctx.input.markFile), `replaying:${ctx.replaying}\n`);
  return await ctx.step("s1", async () => {
    fs.appendFileSync(String(ctx.input.markFile), "ran\n");
    await new Promise((r) => setTimeout(r, phase === "start" ? 30_000 : 100));
    return "executed";
  }, { onCut: async () => ({ cut: true }) });
});
if (phase === "start") {
  swallow(wf.startWorkflow("oc.flow", id, { markFile }));
  await new Promise((r) => setTimeout(r, 3_000));
  process.kill(process.pid, "SIGKILL");
} else {
  await wf.pending();
  const out = await wf.result(id).catch((e) => `error: ${e.message}`);
  const st = await wf.status(id);
  console.log(JSON.stringify({ status: st?.status, out, marks: fs.readFileSync(markFile, "utf8").trim().split("\n") }));
}
await wf.close();
