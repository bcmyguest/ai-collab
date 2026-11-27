// Child for the DBOS kill-and-recover test. phase=start runs a two-step workflow and SIGKILLs itself mid-step-2;
// phase=relaunch waits for the recovered workflow and prints what ran. Usage: node dbos-recover-child.mjs <phase> <id> <markerFile>
import fs from "node:fs";
import { openWorkflows } from "../../lib/workflows.ts";
import { pgUrl } from "../../lib/postgres.ts";

const [phase, id, markFile] = process.argv.slice(2);
// node --test globs every file under test/; this module only runs as a spawned child of workflows-dbos-recovery.test.mjs.
if (!["start", "relaunch"].includes(phase)) process.exit(0);

const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: process.env.AIC_DBOS_APP_VERSION });
// The marker path travels in the workflow input: a recovered run marks its own file, not the recovering process's.
wf.register("recover.two", async (ctx) => {
  const mark = (s) => fs.appendFileSync(String(ctx.input.markFile), s + "\n");
  await ctx.step("s1", async () => { mark("s1"); return 1; });
  await ctx.step("s2", async () => {
    await new Promise((r) => setTimeout(r, 20_000));
    mark("s2");
    return 2;
  });
  mark("end");
  return "ok";
});

const swallow = (p) => p.catch(() => {}); // keeps a top-level promise chain off the lint rule

if (phase === "start") {
  swallow(wf.startWorkflow("recover.two", id, { markFile })); // the SIGKILL below abandons it mid-step-2
  await new Promise((r) => setTimeout(r, 4_000)); // mid-step-2
  process.kill(process.pid, "SIGKILL");
} else {
  const result = await wf.result(id);
  console.log(JSON.stringify({ result, markers: fs.readFileSync(markFile, "utf8").trim().split("\n") }));
  await wf.close();
}
