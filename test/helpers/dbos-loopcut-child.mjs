// Repro child (reviewer F4): a step name repeated in a loop; the second iteration is cut by SIGKILL.
// Recovery must run onCut for the cut occurrence (not re-run fn) and must not report `replaying` after the recorded prefix.
import fs from "node:fs";
const [phase, id, markFile] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of dbos-review-loopcut.test.mjs.
if (!["start", "relaunch"].includes(phase)) process.exit(0);
const SRC = process.env.SRC;
const { openWorkflows } = await import(`${SRC}/lib/workflows.ts`);
const { pgUrl } = await import(`${SRC}/lib/postgres.mjs`);
const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
const mark = (s) => fs.appendFileSync(markFile, s + "\n");
wf.register("lc.flow", async (ctx) => {
  const out = [];
  await ctx.sleep(50); // one recorded DBOS.sleep row: the replaying counter must count it
  for (let i = 1; i <= 2; i++) {
    out.push(await ctx.step("push", async () => {
      mark(`push${i} ran`);
      if (i === 2) await new Promise((r) => setTimeout(r, phase === "start" ? 30_000 : 100));
      return `sent${i}`;
    }, { onCut: async () => { mark(`push${i} onCut replaying:${ctx.replaying}`); return `cut${i}`; } }));
  }
  return out;
});
if (phase === "start") {
  wf.startWorkflow("lc.flow", id, {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 3_000));
  process.kill(process.pid, "SIGKILL");
} else {
  await wf.pending();
  const out = await wf.result(id).catch((e) => `error: ${e.message}`);
  console.log(JSON.stringify({ out, marks: fs.readFileSync(markFile, "utf8").trim().split("\n") }));
  await wf.close();
}
