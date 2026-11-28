import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { snapshotMcp } from "./helpers/surface-snapshot.mjs";
import { quietEnv } from "./helpers/surface-env.mjs";

const UPDATE = process.env.UPDATE_SURFACE_GOLDEN === "1";
const golden = (name) => fileURLToPath(new URL(`./golden/surfaces/${name}`, import.meta.url));
const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// The server version is package.json's, which a release bumps; the golden pins the surface, not the version.
function check(name, actual) {
  if (actual.initialize?.serverInfo?.version) actual.initialize.serverInfo.version = "<package version>";
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) writeFileSync(golden(name), text);
  assert.equal(text, readFileSync(golden(name), "utf8"), `${name} differs from the golden`);
}

test("ai-collab MCP tools and initialize match the golden", { timeout: 15000 }, async () => {
  check("mcp-ai-collab.json", await snapshotMcp(script("ai-collab-mcp.mjs"), { args: ["claude"], env: quietEnv() }));
});

test("ai-collab MCP tools with reads through run_code match the golden", { timeout: 15000 }, async () => {
  check("mcp-ai-collab-run-code-first.json", await snapshotMcp(script("ai-collab-mcp.mjs"), { args: ["claude"], env: quietEnv({ AI_COLLAB_REQUIRE_RUN_CODE: "1" }) }));
});

test("ai-collab-code MCP tools match the golden", { timeout: 15000 }, async () => {
  check("mcp-ai-collab-code.json", await snapshotMcp(script("ai-collab-code-mcp.mjs"), { args: ["claude"], env: quietEnv() }));
});
