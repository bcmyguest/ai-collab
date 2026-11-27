import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { mergeNode, npmCommand } from "../lib/land.ts";
import { tempDir } from "./helpers/tmp.mjs";

// A Node without bundled npm (Cursor's), and a mise that names an installed Node with npm.
function nodes(t) {
  const root = realpathSync(tempDir(t, "land-node-"));
  const runtime = join(root, "cursor", "node");
  const installed = join(root, "installed", "bin", "node");
  const npmCli = join(root, "installed", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const tools = join(root, "tools");
  for (const dir of [join(root, "cursor"), join(root, "installed", "bin"), join(root, "installed", "lib", "node_modules", "npm", "bin"), tools]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of [runtime, installed, npmCli]) writeFileSync(file, "");
  writeFileSync(join(tools, "mise"), `#!/bin/sh\ntest "$*" = "which node" && echo ${installed}\n`, { mode: 0o755 });
  return { root, runtime, installed, npmCli, tools };
}

test("mergeNode resolves mise's Node when the running Node has no bundled npm", (t) => {
  const { root, runtime, installed, npmCli, tools } = nodes(t);
  const node = mergeNode(runtime, root, { PATH: `${tools}:/usr/bin:/bin` });
  assert.equal(node, installed);
  assert.deepEqual(npmCommand(node, "/usr/bin:/bin"), [installed, npmCli]);
});

test("mergeNode keeps the running Node when mise is absent", (t) => {
  const { root, runtime } = nodes(t);
  assert.equal(mergeNode(runtime, root, { PATH: "/nonexistent" }), runtime);
});
