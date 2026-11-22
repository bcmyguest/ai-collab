import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyLimit } from "../lib/limits.mjs";

const HARNESSES = ["claude", "codex", "opencode", "cursor"];
const fixtures = (harness) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/limits/${harness}.json`, import.meta.url)), "utf8"));

for (const harness of HARNESSES) {
  test(`${harness} fixtures classify as expected`, () => {
    for (const { name, event, expect } of fixtures(harness)) {
      const found = classifyLimit(harness, event);
      if (expect === null) {
        assert.equal(found, null, name);
        continue;
      }
      assert.equal(found?.harness, harness, name);
      for (const key of ["window", "windowName", "verified"]) assert.equal(found[key], expect[key], `${name}: ${key}`);
      if (expect.resetsAt === "clamped") {
        // A reset in the past is held to 5 minutes from now.
        const floor = Date.now() + 5 * 60_000;
        assert.ok(found.resetsAt >= floor - 1000 && found.resetsAt <= floor + 5000, `${name}: resetsAt ${found.resetsAt}`);
      } else {
        assert.equal(found.resetsAt, expect.resetsAt, `${name}: resetsAt`);
      }
      assert.ok(found.source, `${name}: source`);
    }
  });
}

test("an unknown harness is never a limit", () => {
  assert.equal(classifyLimit("other", { kind: "run_error", message: "usage limit" }), null);
});
