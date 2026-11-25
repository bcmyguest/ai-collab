#!/usr/bin/env node
/** Builds dist/: the package with the same paths, code compiled by tsc and no .ts imports. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packPluginCopy } from "../lib/plugin-copy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const TS_SPECIFIER = /(["'])(\.{1,2}\/[^"'\n]*\.ts)\1/g;
const SCANNED = /\.(mjs|js|cjs|jsx|tsx)$/;

const removeTs = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTs(p);
    else if (entry.name.endsWith(".ts")) fs.rmSync(p);
  }
};

/** Returns "file: specifier" for each relative .ts import left under dir. */
export function findTsSpecifiers(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (SCANNED.test(entry.name)) {
        for (const m of fs.readFileSync(p, "utf8").matchAll(TS_SPECIFIER)) found.push(`${path.relative(dir, p)}: ${m[2]}`);
      }
    }
  };
  walk(dir);
  return found;
}

function main() {
  // Copy every "files" entry first; tsc then overwrites the compiled .mjs files.
  packPluginCopy(root, dist);
  execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
  removeTs(dist);
  const bad = findTsSpecifiers(dist);
  if (bad.length) throw new Error(`dist still imports .ts modules:\n${bad.join("\n")}`);
  console.log(`dist: package at ${dist}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
