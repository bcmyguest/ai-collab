import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalMessage } from "../lib/approvals.ts";
import { broadcastTopic, loadConfig } from "../lib/config.ts";
import { publish } from "../lib/transport.mjs";
import { createUi } from "../web/server/ui.mjs";
import { peerEnv } from "./helpers/env.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { sse } from "./helpers/ui-stream.mjs";

const base = "http://127.0.0.1:8795";
const ID = "0123456789ab";

test("UI sends an A2UI surface per approval and maps the surface's answer onto the approval reply", async (t) => {
  const fake = await startFakeNtfy();
  t.after(() => fake.close());
  const cfg = loadConfig(peerEnv(fake, { peer: "alice" }));
  const request = { tool: "Bash", summary: "rm -rf build" };
  const message = approvalMessage(cfg, "claude", request, { id: ID, expiresAt: Date.now() + 60_000 });
  await publish(cfg, broadcastTopic(cfg.project), message);
  const ui = createUi({ cfg });
  const ctrl = new AbortController();
  t.after(() => { ctrl.abort(); ui.close(); });
  const stream = sse(ui.events(new Request(`${base}/api/events?project=demo`, { signal: ctrl.signal })));

  const post = body => ui.handle(new Request(`${base}/api/a2ui`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), "a2ui");
  const userAction = context => ({ name: "decide", surfaceId: "approval-" + ID, sourceComponentId: "allow", timestamp: "2026-11-21T10:00:00Z", context });
  const timer = setTimeout(() => ctrl.abort(), 5000);
  t.after(() => clearTimeout(timer));

  // One loop over the stream: the open surface first, then the surface re-sent once the reply is on the topic.
  let answered = false;
  let sent = false;
  for await (const frame of stream) {
    if (frame.event !== "surface" || frame.data.id !== "approval-" + ID) continue;
    if (!answered) {
      const buttons = frame.data.operations.find(op => op.updateComponents).updateComponents.components.filter(c => c.component === "Button");
      assert.deepEqual(buttons.map(b => b.action.event.context.decision), ["allow", "deny"]);
      assert.equal((await post({ project: "demo", forwardedProps: { a2uiAction: { userAction: userAction({ id: "fffffffffffff", decision: "allow" }) } } })).status, 400);
      assert.equal((await post({ project: "demo", forwardedProps: { a2uiAction: { userAction: userAction({ id: ID, decision: "allow" }) } } })).status, 201);
      answered = true;
    } else if (JSON.stringify(frame.data.operations).includes("Answer sent, waiting for the agent")) {
      sent = true;
      break;
    }
  }
  assert.equal(sent, true);
});
