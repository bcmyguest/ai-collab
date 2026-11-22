import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { merge } from "../lib/merge-cli.mjs";
import { runCli } from "../lib/cli.mjs";

test("the CLI exposes the host-only merge gate", async () => {
  let output = "";
  const status = await runCli(["merge", "--help"], {
    stdout: { write: (message) => { output += message; } },
  });
  assert.equal(status, 0);
  assert.match(output, /\/home\/b\/ai-collab/);
  assert.match(output, /875 tests/);
});

for (const failure of [null, "checkout", "merge", "ci", "test", "changed HEAD", "push"]) {
  test(`guarded merge with ${failure ?? "a green gate"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "merge-cli-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const hostCheckout = join(root, "ai-collab");
    mkdirSync(hostCheckout);
    const env = { HOME: "/host-home", PATH: "/host-bin", GIT_DIR: "/elsewhere" };
    const calls = [];
    const gateHomes = [];
    let output = "";
    let errors = "";
    let worktree;
    let headReads = 0;
    const status = merge(["start", "builder/topic"], {
      env, hostCheckout, tempRoot: root,
      out: { write: (message) => { output += message; } },
      err: { write: (message) => { errors += message; } },
      run(file, argv, options) {
        calls.push([file, argv]);
        if (file === "npm") {
          assert.equal(options.cwd, worktree);
          assert.ok(existsSync(options.env.HOME));
          assert.ok(existsSync(options.env.TMPDIR));
          assert.equal(options.env.CODEX_HOME, join(options.env.HOME, ".codex"));
          assert.notEqual(options.env.HOME, env.HOME);
          gateHomes.push(options.env.HOME);
          return { status: Number(failure === argv[0]) };
        }
        assert.equal(options.cwd, hostCheckout);
        const args = argv.join(" ");
        if (args === "rev-parse --local-env-vars") return { status: 0, stdout: "GIT_DIR\n" };
        assert.equal(options.env.HOME, env.HOME);
        assert.equal(options.env.GIT_DIR, undefined);
        if (args === "rev-parse --show-toplevel") return { status: 0, stdout: hostCheckout };
        if (args === "symbolic-ref --short HEAD") {
          return { status: 0, stdout: failure === "checkout" ? "builder/topic" : "main" };
        }
        if (args.includes("refs/heads/builder/topic^{commit}")) return { status: 0, stdout: "builder-sha" };
        if (args.includes("refs/remotes/origin/main^{commit}")) return { status: 0, stdout: "base-sha" };
        if (argv[0] === "worktree") {
          assert.deepEqual(argv.slice(0, 3), ["worktree", "add", "-b"]);
          assert.match(argv[3], /^merge\//);
          worktree = argv[4];
          assert.equal(argv[5], "base-sha");
        }
        if (argv[2] === "merge") assert.deepEqual(argv.slice(3), ["--no-edit", "builder-sha"]);
        if (args.endsWith("rev-parse HEAD")) {
          headReads++;
          return { status: 0, stdout: failure === "changed HEAD" && headReads === 2 ? "other" : "merged-sha" };
        }
        if (argv[2] === "push") assert.deepEqual(argv.slice(3), ["origin", "merged-sha:refs/heads/main"]);
        return { status: Number(Boolean(failure && argv[2] === failure)), stdout: "" };
      },
    });
    assert.equal(status, failure ? 1 : 0, errors);
    for (const home of gateHomes) assert.equal(existsSync(home), false);
    const steps = calls.flatMap(([file, argv]) => file === "npm" ? argv : argv.slice(2, 3));
    const pushed = steps.includes("push");
    assert.equal(pushed, failure === null || failure === "push");
    if (pushed) assert.deepEqual(steps.filter((step) => ["ci", "test", "push"].includes(step)), ["ci", "test", "push"]);
    assert.equal(output.includes("git pull --ff-only"), failure === null);
    if (!failure) assert.match(output, /node tools\/smoke-ui\.mjs/);
  });
}
