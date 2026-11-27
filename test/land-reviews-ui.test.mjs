import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadProjects } from "../lib/config.mjs";
import { createFileBackend, reviewPacket, taskStoreFile } from "../lib/tasks.mjs";
import { createUi } from "../web/server/ui.mjs";
import { startFakeNtfy } from "./helpers/fake-ntfy.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { sse } from "./helpers/ui-stream.mjs";

async function loadLandReviews() {
  await swc.loadBindings();
  const { code } = await swc.transform(readFileSync(new URL("../web/app/land-reviews.jsx", import.meta.url), "utf8"), {
    jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
    module: { type: "commonjs" },
  });
  const require = createRequire(import.meta.url);
  const components = {};
  new Function("require", "exports", code)(id => id === "@/components/ui/button" ? { Button: "button" } : require(id), components);
  return components.LandReviews;
}

test("one Home request opens PRs for authorized reviews in order and streams each receipt", { timeout: 10_000 }, async (t) => {
  const root = realpathSync(tempDir(t, "land-reviews-ui-"));
  const genv = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (...args) => spawnSync("git", args, { cwd: host, env: genv, encoding: "utf8" }).stdout.trim();
  const host = join(root, "host");
  mkdirSync(host);
  git("init", "-q", "-b", "main");
  writeFileSync(join(host, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const ntfy = await startFakeNtfy();
  t.after(() => ntfy.close());
  mkdirSync(join(root, ".config", "ai-collab"), { recursive: true });
  writeFileSync(join(root, ".config/ai-collab/projects.json"), JSON.stringify([{ root: host, project: "demo", url: ntfy.url, peers: "claude" }]));
  const env = { HOME: root, PATH: process.env.PATH, XDG_CONFIG_HOME: join(root, ".config"), XDG_DATA_HOME: join(root, "data"), AI_COLLAB_STATE_DIR: join(root, "state") };
  const tasks = createFileBackend(taskStoreFile("demo", env));
  for (const [at, id] of ["stale", "ordinary", "answer-sync", "pm-merge-gate", "unanswered"].entries()) {
    git("switch", "-q", "-c", `builder/${id}`, "main");
    writeFileSync(join(host, `${id}.txt`), `${id}\n`);
    git("add", `${id}.txt`);
    git("commit", "-q", "-m", id);
    const tip = git("rev-parse", "HEAD");
    await tasks.add({ id, title: id });
    await tasks.update(id, { ask: { text: "When should this land?", by: "pm" } });
    if (id !== "unanswered") await tasks.update(id, { answer: { text: "Merge when green", by: "operator:tester" } });
    await tasks.submitReview(id, reviewPacket({ branch: `builder/${id}`, commit: tip, base, check: { code: 0 }, submission: id, at }));
    if (id === "stale") {
      writeFileSync(join(host, "stale.txt"), "new tip\n");
      git("commit", "-q", "-am", "new tip");
    }
  }
  git("switch", "-q", "main");

  const opened = [];
  const origin = "https://operator.example";
  const ui = createUi({
    projects: loadProjects(env, { host: "operator" }), env, allowedOrigin: origin, landingCheckout: host,
    runMergeReview(review) {
      if (git("rev-parse", `refs/heads/${review.branch}`) !== review.commit) return { landed: false, detail: "the build branch moved past the submitted commit" };
      opened.push(review.branch);
      return { landed: false, opened: true, detail: `PR https://github.com/o/r/pull/${opened.length}` };
    },
  });
  t.after(() => ui.close());
  const post = (payload, from = origin) => ui.handle(new Request(origin + "/api/land-reviews", {
    method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }), "land-reviews");
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const updates = sse(ui.events(new Request(origin + "/api/events?view=home", { signal: ctrl.signal })));
  try {
    const initial = await updates.next();
    assert.deepEqual(initial.value.data.landing, { running: false, receipts: [] });
    assert.equal((await post({}, "https://other.example")).status, 403);
    const LandReviews = await loadLandReviews();
    const control = LandReviews({ landing: initial.value.data.landing, onLand: () => post({}) });
    assert.match(renderToStaticMarkup(control), /<button[^>]*>Open PRs for green reviews<\/button>/);
    assert.equal((await control.props.children[0].props.onClick()).status, 202);
    for await (const { data } of updates) {
      if (!data.landing?.finished) continue;
      // Staged reviews still go first; an opened PR lets the next stage open its own.
      assert.deepEqual(data.landing.receipts.map(({ id, landed, opened: pr }) => [id, landed, pr ?? false]), [
        ["pm-merge-gate", false, true], ["answer-sync", false, true], ["stale", false, false], ["ordinary", false, true],
      ]);
      const html = renderToStaticMarkup(createElement(LandReviews, { landing: data.landing }));
      assert.match(html, /demo\/pm-merge-gate · PR opened · PR https:\/\/github.com\/o\/r\/pull\/1/);
      assert.match(html, /demo\/stale · Failed · the build branch moved/);
      break;
    }
    assert.deepEqual(opened, ["builder/pm-merge-gate", "builder/answer-sync", "builder/ordinary"]);
    // Opening a PR decides nothing: every review stays pending for the operator.
    for (const id of ["ordinary", "answer-sync", "pm-merge-gate", "stale", "unanswered"]) assert.equal(tasks.get(id).status, "review");
  } finally {
    await updates.return();
  }
});
