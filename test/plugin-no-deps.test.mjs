import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("every plugin script and library imports from a copy without node_modules", t => {
  const dir = mkdtempSync(join(tmpdir(), "ai-collab-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const copy = join(dir, "plugin");
  mkdirSync(home);
  mkdirSync(copy);
  for (const path of ["package.json", ".cursor-plugin", "hooks", "scripts", "lib", "web/lib"]) {
    cpSync(new URL(`../${path}`, import.meta.url), join(copy, path), { recursive: true });
  }
  const modules = ["lib", "scripts"].flatMap(path =>
    readdirSync(join(copy, path)).filter(name => name.endsWith(".mjs")).map(name => `./${path}/${name}`));
  const script = `
    import * as module from 'node:module';
    module.registerHooks?.({ resolve(specifier, context, next) {
      if (!module.isBuiltin(specifier) && !/^(\\.|\\/|file:)/.test(specifier)) throw Error('npm import: ' + specifier);
      return next(specifier, context);
    }});
    for (const file of ${JSON.stringify(modules)}) {
      await import(file);
      console.log('loaded ' + file);
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: copy, env: { HOME: home, CODEX_HOME: join(home, ".codex"), NODE_PATH: "" },
    input: "", encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.deepEqual(result.stdout.split("\n").filter(line => line.startsWith("loaded ")), modules.map(file => "loaded " + file));
});
