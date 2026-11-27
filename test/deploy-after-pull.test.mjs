// Deploy compares against the commit it last shipped, so a manual `git pull` before `ai-collab deploy` still deploys.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deployHost } from "../lib/land.mjs";
import { deploy } from "../lib/land-cli.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });

// A clean host checkout on main at head; the pull moves HEAD to pulled (default: nowhere).
function pulledHost(head, pulled = head) {
  const calls = [];
  let current = head;
  const run = async (file, argv, options) => {
    calls.push({ file, argv, options });
    if (file !== "git") return ok();
    if (argv[0] === "symbolic-ref") return ok("main\n");
    if (argv[0] === "pull") current = pulled;
    if (argv[0] === "rev-parse") return ok(`${argv[1] === "HEAD" ? current : pulled}\n`);
    return ok();
  };
  run.calls = calls;
  return run;
}

const npmCalls = (run) => run.calls.filter((c) => c.file === "npm").map((c) => c.argv);

test("deploy ships a HEAD that a manual pull already moved past the last shipped commit", async () => {
  const run = pulledHost(NEW);
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"], deployed: OLD });
  assert.equal(result.status, "deployed");
  assert.equal(result.line, `deployed ${OLD.slice(0, 12)}..${NEW.slice(0, 12)}`);
  assert.deepEqual(npmCalls(run), [["ci", "--include=dev"], ["run", "build", "--", "--deploy-and-verify"]]);
});

test("deploy skips when HEAD is the commit it last shipped", async () => {
  const run = pulledHost(NEW);
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"], deployed: NEW });
  assert.equal(result.status, "skipped");
  assert.match(result.line, /HEAD unchanged/);
  assert.deepEqual(npmCalls(run), []);
});

test("auto deploy acts when origin/main equals HEAD but not the last shipped commit", async () => {
  const run = pulledHost(NEW);
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"], ifMoved: true, deployed: OLD });
  assert.equal(result.status, "deployed");
});

test("auto deploy stays quiet when origin/main is the last shipped commit", async () => {
  const run = pulledHost(NEW);
  const result = await deployHost({ run, hostCheckout: "/host", npm: ["npm"], ifMoved: true, deployed: NEW });
  assert.equal(result.status, "unchanged");
});

test("the deploy CLI records the shipped commit and keeps it through a later skip", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "deploy-after-pull-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const io = { env: { AI_COLLAB_STATE_DIR: stateDir }, hostCheckout: "/host", npm: ["npm"], out: { write: () => {} }, err: { write: () => {} }, publish: async () => {} };
  const last = () => JSON.parse(readFileSync(join(stateDir, "deploy-last.json"), "utf8"));
  // No record yet and HEAD already pulled: the old rule skips, and nothing is recorded as shipped.
  await deploy([], { ...io, run: pulledHost(NEW) });
  assert.equal(last().status, "skipped");
  assert.equal(last().deployed, undefined);

  await deploy([], { ...io, run: pulledHost(OLD, NEW) });
  assert.equal(last().status, "deployed");
  assert.equal(last().deployed, NEW);

  await deploy([], { ...io, run: pulledHost(NEW) });
  assert.equal(last().status, "skipped");
  assert.equal(last().deployed, NEW);
});
