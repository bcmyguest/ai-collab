// The checked-in MCP SDK bundle must come from the SDK version package-lock installs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("lib/vendor/mcp-sdk.mjs is built from the locked SDK version", () => {
  const locked = JSON.parse(read("package-lock.json")).packages["node_modules/@modelcontextprotocol/sdk"].version;
  const banner = read("lib/vendor/mcp-sdk.mjs").split("\n", 1)[0];
  assert.match(banner, new RegExp(`@modelcontextprotocol/sdk ${locked.replaceAll(".", "\\.")};`), "run npm run vendor:mcp");
});

test("the bundle imports only node builtins", () => {
  const imports = [...read("lib/vendor/mcp-sdk.mjs").matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((name) => !name.startsWith("node:")), []);
});
