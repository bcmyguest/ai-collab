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
      for (const key of ["window", "windowName", "resetsAt", "verified"]) assert.equal(found[key], expect[key], `${name}: ${key}`);
      assert.ok(found.source, `${name}: source`);
    }
  });
}

test("an unknown harness is never a limit", () => {
  assert.equal(classifyLimit("other", { kind: "run_error", message: "usage limit" }), null);
});
