// r3 D: DBOS stores a keyed message as "<key>::<destination>". The global-dedupe probe matched on the prefix
// "<key>::", so a key that extends another by ":" or "::…" (an empty session label gives "ntfy:<id>:") made
// the shorter key's first send report "duplicate" and the caller drop it. The probe must match keys exactly.
import assert from "node:assert/strict";
import test from "node:test";
import { openWorkflows } from "../lib/workflows.ts";
import { pgUrl } from "../lib/postgres.mjs";
import { dbosTestDb } from "./helpers/dbos-env.mjs";

const pgUp = await dbosTestDb();

test("the send dedupe probe matches keys exactly, not by prefix", { skip: pgUp ? false : "no Postgres on 127.0.0.1:5432", timeout: 60_000 }, async () => {
  const wf = await openWorkflows({ engine: "dbos", pgUrl: pgUrl(), applicationVersion: `aic-r3d-${Date.now()}` });
  wf.register("r3d.wait", async (ctx) => await ctx.recv("inbox"));
  const stamp = Date.now();
  const ids = ["a", "b", "c", "d"].map((x) => `r3d-${x}-${stamp}`);
  const runs = ids.map((id) => wf.startWorkflow("r3d.wait", id, {}));
  try {
    assert.equal(await wf.send(ids[0], "inbox", "label-empty", { dedupe: `r3d-ntfy:${stamp}:` }), true);
    assert.equal(await wf.send(ids[1], "inbox", "wake", { dedupe: `r3d-ntfy:${stamp}` }), true, "ntfy:<id> is a different key from ntfy:<id>:");
    assert.equal(await wf.send(ids[2], "inbox", "nested", { dedupe: `r3d-k-${stamp}::x` }), true);
    assert.equal(await wf.send(ids[3], "inbox", "plain", { dedupe: `r3d-k-${stamp}` }), true, "k is a different key from k::x");
    assert.equal(await wf.send(ids[3], "inbox", "plain", { dedupe: `r3d-k-${stamp}` }), false, "a repeat of the same key is still a duplicate");
    assert.deepEqual(await Promise.all(runs), ["label-empty", "wake", "nested", "plain"]);
  } finally {
    await wf.close();
  }
});
