// While `ai-collab deploy --from` serves another tree, the snapshot carries its ref and every screen shows a banner.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import swc from "next/dist/build/swc/index.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { deployedField } from "../lib/land.ts";
import { tempDir } from "./helpers/tmp.mjs";

const require = createRequire(import.meta.url);
const dependencies = {
  "@/components/ui/button": { Button: "button" },
  "./chat-api": { api: async () => ({}) },
};
await swc.loadBindings();
const { code } = await swc.transform(readFileSync(new URL("../web/app/land-panel.jsx", import.meta.url), "utf8"), {
  jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } } },
  module: { type: "commonjs" },
});
const exports = {};
new Function("require", "exports", code)((id) => dependencies[id] ?? require(id), exports);
const { DeployedBanner } = exports;

test("the banner names the deployed branch and renders nothing on main", () => {
  assert.match(renderToStaticMarkup(createElement(DeployedBanner, { deployed: "feat/x" })), /deployed: feat\/x/);
  assert.equal(renderToStaticMarkup(createElement(DeployedBanner, { deployed: undefined })), "");
});

test("the header renders the banner from the snapshot", () => {
  const console = readFileSync(new URL("../web/app/chat-console.jsx", import.meta.url), "utf8");
  assert.match(console, /<DeployedBanner deployed=\{data\.deployed\}\/>/);
});

test("the snapshot field carries a non-main ref from deploy-last.json", (t) => {
  const stateDir = tempDir(t, "deployed-banner-");
  const env = { AI_COLLAB_STATE_DIR: stateDir };
  assert.deepEqual(deployedField(env), {});
  const write = (record) => writeFileSync(join(stateDir, "deploy-last.json"), JSON.stringify(record));
  write({ status: "deployed", ref: "feat/x" });
  assert.deepEqual(deployedField(env), { deployed: "feat/x" });
  write({ status: "deployed", ref: "main" });
  assert.deepEqual(deployedField(env), {});
  writeFileSync(join(stateDir, "deploy-last.json"), "{not json");
  assert.deepEqual(deployedField(env), {});
});
