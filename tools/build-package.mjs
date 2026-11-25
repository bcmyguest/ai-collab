#!/usr/bin/env node
/** Builds dist/: the package with the same paths, code compiled by tsc and no .ts files. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPluginCopy } from "../lib/plugin-copy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

// Copy every "files" entry first; tsc then overwrites the compiled .mjs files.
packPluginCopy(root, dist);
execFileSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });

const removeTs = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) removeTs(p);
    else if (entry.name.endsWith(".ts")) fs.rmSync(p);
  }
};
removeTs(dist);
console.log(`dist: package at ${dist}`);
