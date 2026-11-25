import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { deepLink, uiBase } from "../lib/deep-link.mjs";
import { publish } from "../lib/transport.mjs";
import { parseSelection } from "../web/lib/selection.js";

const BASE = "https://ui.example.test";

test("the base URL comes from AI_COLLAB_UI_URL, without a trailing slash, and is empty when unset or invalid", () => {
  assert.equal(uiBase({ AI_COLLAB_UI_URL: "https://ui.example.test/" }), BASE);
  assert.equal(uiBase({ AI_COLLAB_UI_URL: "ui.example.test" }), "");
  assert.equal(uiBase({}), "");
});

test("a link without a base URL is empty, so no click header is sent", () => {
  assert.equal(deepLink({ base: "", project: "demo" }), "");
});

test("links name the project chat, a session thread, and a subagent run in the hash parameters the UI reads", () => {
  const chat = deepLink({ base: BASE, project: "demo" });
  assert.equal(chat, `${BASE}/#project=demo&level=project`);
  assert.deepEqual(parseSelection(chat.split("#")[1]), { project: "demo", level: "project", harness: "", session: "", tab: "chat", run: "" });

  const thread = deepLink({ base: BASE, project: "demo", session: "codex#ab12" });
  assert.deepEqual(parseSelection(thread.split("#")[1]), { project: "demo", level: "session", harness: "codex", session: "codex#ab12", tab: "activity", run: "" });

  const run = deepLink({ base: BASE, project: "demo", session: "codex#ab12", run: "r9" });
  assert.deepEqual(parseSelection(run.split("#")[1]), { project: "demo", level: "session", harness: "codex", session: "codex#ab12", tab: "subagents", run: "r9" });
});

test("publish sends the link as ntfy's click field only when a link is set", async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { bodies.push({ url: req.url, body: data }); res.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 };
  const click = deepLink({ base: BASE, project: "demo" });
  await publish(cfg, "demo-broadcast", "hi", { title: "t", click });
  await publish(cfg, "demo-broadcast", "hi", { title: "t" });
  assert.equal(JSON.parse(bodies[0].body).click, click);
  assert.equal("click" in JSON.parse(bodies[1].body), false);
});
