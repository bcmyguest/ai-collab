#!/usr/bin/env node
// Installs this plugin into ~/.cursor/plugins/local/ai-collab (symlink; --copy to copy).
import { installCursorPlugin } from "../lib/install-cursor.mjs";

const result = installCursorPlugin({ importMetaUrl: import.meta.url, copy: process.argv.includes("--copy") });
if (!result.ok) {
  console.error(`ai-collab: ${result.message}`);
  process.exit(1);
}
console.log(`installed (${result.mode}) -> ${result.dest}`);
if (result.message) console.log(result.message);
