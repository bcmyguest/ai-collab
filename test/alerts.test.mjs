import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { alertPriority, buzzes, readAlertLevel, writeAlertLevel } from "../lib/alerts.mjs";

const KINDS = ["question", "direct", "other"];

test("all buzzes for every kind, none for none", () => {
  for (const kind of KINDS) {
    assert.equal(buzzes("all", kind), true);
    assert.equal(buzzes("none", kind), false);
  }
});

test("questions and direct replies buzzes questions and direct replies only", () => {
  assert.deepEqual(KINDS.map((kind) => buzzes("questions-and-direct", kind)), [true, true, false]);
});

test("questions only buzzes questions only", () => {
  assert.deepEqual(KINDS.map((kind) => buzzes("questions", kind)), [true, false, false]);
});

test("a silenced message keeps the silent priority, a buzzing one keeps its own", () => {
  assert.equal(alertPriority("questions", "other", 3), 1);
  assert.equal(alertPriority("questions", "question", 4), 4);
  assert.equal(alertPriority("all", "other", undefined), undefined);
});

test("a silenced publish goes out with ntfy priority 1 and a buzzing one keeps its own", async (t) => {
  const { createServer } = await import("node:http");
  const { publish } = await import("../lib/transport.mjs");
  const bodies = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { bodies.push(JSON.parse(data)); res.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const cfg = { url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 };
  await publish(cfg, "t", "status", { priority: alertPriority("questions", "other") });
  await publish(cfg, "t", "question", { priority: alertPriority("questions", "question", 4) });
  assert.deepEqual(bodies.map((b) => b.priority), [1, 4]);
  assert.equal(bodies[0].message, "status");
});

test("the stored level defaults to all, reads a valid level, and rejects an unknown one", () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(path.join(os.tmpdir(), "alerts-xdg-")) };
  assert.equal(readAlertLevel(env), "all");
  writeAlertLevel(env, "questions");
  assert.equal(readAlertLevel(env), "questions");
  assert.throws(() => writeAlertLevel(env, "loud"), { status: 400 });
  assert.equal(readAlertLevel(env), "questions");
  const bad = mkdtempSync(path.join(os.tmpdir(), "alerts-bad-"));
  mkdirSync(path.join(bad, "ai-collab"), { recursive: true });
  writeFileSync(path.join(bad, "ai-collab", "alerts.json"), JSON.stringify({ level: "loud" }));
  assert.equal(readAlertLevel({ XDG_CONFIG_HOME: bad }), "all");
});
