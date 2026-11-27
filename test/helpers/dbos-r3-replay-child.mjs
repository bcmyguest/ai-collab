// Repro child (r3 C): `replaying` must track DBOS's recorded rows. phase=start runs two flows to a cut and dies
// by SIGKILL; phase=relaunch recovers them and the marks show `replaying` at each point.
// recv: blocking recvs (2 rows each: DBOS.recv plus its DBOS.sleep deadline), then a late handoff that starts
// another workflow from the workflow body. sleep0: a zero sleep, which DBOS records as no row.
import fs from "node:fs";
const [phase, stamp, markFile] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-r3-replay.test.mjs.
if (!["start", "relaunch"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.ts`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
const mark = (s) => fs.appendFileSync(markFile, `${phase}: ${s}\n`);
const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule
const cutStep = (ctx, flow) => ctx.step("c", async () => { mark(`${flow} c ran`); await new Promise((r) => setTimeout(r, phase === "start" ? 30_000 : 10)); return 3; },
  { onCut: () => { mark(`${flow} c onCut replaying=${ctx.replaying}`); return "cut"; } });
wf.register("r3c.child", async (_ctx, input) => input.late ?? null);
wf.register("r3c.recv", async (ctx) => {
  await ctx.step("a", async () => 1);
  const one = await ctx.recv("t");
  const two = await ctx.recv("t");
  await ctx.step("b", async () => 2);
  mark(`recv after b replaying=${ctx.replaying} got=${one}+${two}`);
  const late = await ctx.recv("t", { all: true, timeoutSeconds: 0 });
  await wf.startWorkflowOnce("r3c.child", `${ctx.id}-child`, { late });
  mark(`recv before c replaying=${ctx.replaying}`);
  await cutStep(ctx, "recv");
  mark(`recv after c replaying=${ctx.replaying}`);
  return "done";
});
wf.register("r3c.sleep0", async (ctx) => {
  await ctx.step("a", async () => 1);
  await ctx.sleep(0);
  mark(`sleep0 before c replaying=${ctx.replaying}`);
  await cutStep(ctx, "sleep0");
  return "done";
});
const recvId = `r3c-recv-${stamp}`;
const sleepId = `r3c-sleep0-${stamp}`;
if (phase === "start") {
  swallow(wf.startWorkflow("r3c.recv", recvId, {}));
  swallow(wf.startWorkflow("r3c.sleep0", sleepId, {}));
  await new Promise((r) => setTimeout(r, 1500));
  await wf.send(recvId, "t", "hello");
  await new Promise((r) => setTimeout(r, 1000));
  await wf.send(recvId, "t", "two");
  await new Promise((r) => setTimeout(r, 2500));
  process.kill(process.pid, "SIGKILL");
} else {
  await wf.pending();
  const out = { recv: await wf.result(recvId).catch((e) => `error ${e.message}`), sleep0: await wf.result(sleepId).catch((e) => `error ${e.message}`) };
  console.log(JSON.stringify(out));
  await wf.close();
}
