// Pins the builder's pure outputs as sha256 of their exact bytes, so a move of code cannot change them unnoticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { builderId, builderPaths, builderPolicy, briefNotes, builderSandbox, captureHooks, claudeMcpConfig, claudeSettings, harnessCommand } from "../lib/builder.mjs";

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`).digest("hex");

const PINNED = {
  "policy.cursor": "d1794abc8ae01ccc964c97f27149f8ddae8858499b8dbd3d4aa1156123a96881",
  "policyNoNtfy.cursor": "4c6390afb77adcbe93fafbef34061b6695986607c8cd509220346a28f9b67807",
  "argv.cursor": "71e6076d18c5ccd1b70adae7c1a27f3863d31a8c5e32503fa40096441239396c",
  "policy.codex": "fa593111a0f01eb60bca11c164c18099293a38b69a8b2301d94db16a50d70466",
  "policyNoNtfy.codex": "d58e6d549f5e1c43a56b8fd2913ee5a4dbd3bf046820eff3389bdf8ea832f79f",
  "argv.codex": "8151d236ee5bb8c98aa05f73c4912fd6116aeefb762d09a1ee5bcf0e93f918d7",
  "policy.claude": "7b992cf6f5e321014d6e05f415d7a7d2ef8cb1ce4da094035fbb28ab598207d3",
  "policyNoNtfy.claude": "9244342126598e2658e7c2d7d8fa4ca92414afd7352e1868c7809399d09662a7",
  "argv.claude": "dd90c73b198a50701224974cead63798c0f8414b96537529747a82fc4e6fd79b",
  "policy.opencode": "25f11e6511838a3c2ff09c7137a430ae8bf657eeb61ccbacf7e2e719bf09be92",
  "policyNoNtfy.opencode": "1e2e0c2e7ea1f8bb1761adbf527d53a31fe586aebe5204d76ef89cc36a644c8e",
  "argv.opencode": "740d6dba67c3ca4fa30e3929f396624c48da40ad1a87bfc2d20ea18e702387d7",
  claudeSettings: "a7fba250b3340304bf6e961c11ed65de69a623881b0478a8da4567c9f4f46873",
  claudeMcp: "9b772447ea7eb9429d976737dc2b13a990e9cdf366aea05b2da3e5a000364f49",
  cursorHooks: "f7921b4c343ff7e958d4c2c6603f51009999303fbacc6e4a44ddacaa6aaac812",
  claudeHooks: "0803da8b7cd4b0fd42803628795691bbef180d4fcb67f0b78e5b455a548a92a6",
  briefNotes: "d4f8b41dcd61a596ce2c756685620a9cde66afa9ef8ba0ac607061a25f07c7e6",
  paths: "44e248a3f366fec676024df55aa11a014338dfa5141a2d9089385307e049b606",
};

const HARNESSES = ["cursor", "codex", "claude", "opencode"];

test("the sandbox policy bytes per harness are unchanged", () => {
  for (const harness of HARNESSES) {
    const binaries = [`/sandbox/${harness}/bin/x`, "/sandbox/tools/bin/y"];
    assert.equal(digest(builderPolicy({ harness, binaries, ntfyBinaries: ["/sandbox/tools/node/bin/node"] })), PINNED[`policy.${harness}`], harness);
    assert.equal(digest(builderPolicy({ harness, binaries: ["/sandbox/x"] })), PINNED[`policyNoNtfy.${harness}`], harness);
  }
});

test("the harness argv bytes per harness are unchanged", () => {
  for (const harness of HARNESSES) {
    const command = harnessCommand({ harness, model: "m-1", brief: "Do it.", workdir: "/sandbox/work/w", launcher: "/sandbox/x/launch", builderCode: harness === "cursor" });
    assert.equal(digest(command), PINNED[`argv.${harness}`], harness);
  }
});

test("the Claude settings, MCP config and hook files are unchanged", () => {
  assert.equal(digest(claudeSettings(["UserPromptSubmit", "PostToolUse"])), PINNED.claudeSettings);
  assert.equal(digest(claudeMcpConfig({ node: true, project: "demo", codeMode: true })), PINNED.claudeMcp);
  assert.equal(digest(captureHooks("cursor", ["beforeSubmitPrompt"])), PINNED.cursorHooks);
  assert.equal(digest(captureHooks("claude", ["UserPromptSubmit"])), PINNED.claudeHooks);
});

test("the brief notes and the builder paths are unchanged", () => {
  assert.equal(digest(briefNotes({ task: "t-1", branch: "builder/t-1", workdir: "/sandbox/work/w" })), PINNED.briefNotes);
  assert.equal(digest(builderPaths("smoke-task", { HOME: "/h", AI_COLLAB_STATE_DIR: "/s" })), PINNED.paths);
  assert.equal(builderSandbox("smoke-task"), "b-smoke-ta-d39a55");
  assert.equal(builderSandbox("a-very-long-task-identifier-here"), "b-a-very-l-7fadf4");
  assert.equal(builderId("Some Task_ID!"), "some-task-id");
});
