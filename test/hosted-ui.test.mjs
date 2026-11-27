import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { broadcastTopic, statusTopic } from "../lib/config.ts";
import { publishStatus } from "../lib/messaging.ts";
import { createHostedUi } from "../web/server/hosted.ts";
import { createUi } from "../web/server/ui.ts";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { firstUpdate } from "./helpers/ui-stream.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const origin = "https://hosted.example.test";
const auth = {
  user: request => request.headers.has("x-test-login") ? { login: request.headers.get("x-test-login") } : null,
};

function request(path, login, body) {
  return new Request(origin + path, {
    headers: { ...(login ? { "x-test-login": login } : {}), origin, "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
}

test("hosted UI scopes default and explicit project routes, archives, attachments and broadcast", async t => {
  const broker = await startFakeNtfy();
  t.after(() => broker.close());
  const stateDir = tempDir(t, "ai-collab-hosted-");
  const projects = ["alice", "bob"].map(owner => ({
    owner, project: owner + "-repo", token: owner + "-token",
    enabled: true, peers: ["codex"], url: broker.url, timeoutMs: 2000, stateDir,
  }));
  const ui = createHostedUi({ auth, projects, stateDir, origin, createUi });
  t.after(() => { ui.close(); rmSync(stateDir, { recursive: true, force: true }); });

  assert.equal(ui.events(request("/api/events")).status, 401);
  assert.equal(ui.events(request("/api/events", "ocelot")).status, 404);
  const address = "codex#0123456789abcdef";
  await publishStatus({ ...projects[0], peer: "codex", session: address.split("#")[1] }, { event: "start", harness: "codex" });
  const uploaded = await fetch(broker.url + "/" + broadcastTopic("bob-repo") + "?filename=secret.png", { method: "PUT", body: "image bytes" });
  assert.equal(uploaded.status, 200);
  assert.equal(ui.events(request("/api/events?project=bob-repo", "Alice")).status, 404);
  const state = await firstUpdate(ui.events(request("/api/events?view=home", "Alice")), "state");
  assert.equal(state.project, "alice-repo");
  assert.deepEqual(state.agents.map(({ id, owner }) => [id, owner]), [[address, "alice"]]);
  assert.deepEqual(state.projects.map(project => project.id), ["alice-repo"]);
  assert.deepEqual(Object.keys(state.projectCounts), ["alice-repo"]);

  assert.equal((await ui.handle(request("/api/history?project=bob-repo", "Alice", { query: "" }), "history")).status, 404);
  assert.equal((await ui.handle(request("/api/send", "Alice", { project: "bob-repo", target: "all", body: "hello" }), "send")).status, 404);
  assert.equal((await ui.handle(request("/api/afk", "Alice", { mode: "on" }), "afk")).status, 201);
  assert.equal((await ui.handle(request("/api/send", "Bob", { target: "all", body: "hello" }), "send")).status, 201);
  assert.deepEqual(broker.state.publishes.map(({ topic, auth }) => [topic, auth]), [
    [statusTopic("alice-repo"), "Bearer alice-token"],
    [broadcastTopic("bob-repo"), ""],
    [broadcastTopic("alice-repo"), "Bearer alice-token"],
    [broadcastTopic("bob-repo"), "Bearer bob-token"],
  ]);
  await firstUpdate(ui.events(request("/api/events", "Bob")), "state");
  assert.equal((await ui.file("f1.png", request("/api/file/f1.png", "Bob"))).status, 200);
  assert.equal((await ui.file("f1.png", request("/api/file/f1.png", "Alice"))).status, 404);
  assert.equal(ui.push(request("/api/push/key", "Alice")).status, 404);
  assert.equal(ui.schedules(request("/api/schedules", "Alice")).status, 404);
  assert.equal((await ui.handle(request("/api/start", "Alice", { harness: "codex" }), "start")).status, 403);
});

test("hosted UI rejects missing owners, missing tokens and shared credentials", () => {
  const create = projects => createHostedUi({ auth, projects, stateDir: "/unused", origin, createUi });
  assert.throws(() => create([{ token: "token" }]), /owner/);
  assert.throws(() => create([{ owner: "alice" }]), /token/);
  assert.throws(() => create([{ owner: "alice", token: "token" }, { owner: "bob", token: "token" }]), /share bus tokens/);
});
