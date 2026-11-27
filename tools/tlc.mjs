// Runs TLC on every spec in spec/tla that has a .cfg (bounded models end, so deadlock is not checked); skips with exit 0 when Java or tla2tools.jar is missing.
// Java: TLC_JAVA, else $JAVA_HOME/bin/java, else java on PATH. Jar: TLA2TOOLS_JAR, else ~/.cache/tlaplus/tla2tools.jar.
// Usage: npm run tlc [-- Spec ...]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = fileURLToPath(new URL("../spec/tla/", import.meta.url));
const JAR = process.env.TLA2TOOLS_JAR || path.join(os.homedir(), ".cache", "tlaplus", "tla2tools.jar");
const RESULT = /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/;
const DEPTH = /The depth of the complete state graph search is (\d+)/;

function findJava() {
  const candidates = [process.env.TLC_JAVA, process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "java"), "java"].filter(Boolean);
  return candidates.find((bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0);
}

function specs(names) {
  const all = fs.readdirSync(SPEC_DIR).filter((name) => name.endsWith(".cfg")).map((name) => name.slice(0, -4)).sort();
  return names.length ? all.filter((name) => names.includes(name)) : all;
}

function runSpec(java, name, metaRoot) {
  const args = ["-XX:+UseParallelGC", "-cp", JAR, "tlc2.TLC", "-deadlock", "-workers", "auto", "-cleanup", "-metadir", path.join(metaRoot, name), "-config", `${name}.cfg`, `${name}.tla`];
  const run = spawnSync(java, args, { cwd: SPEC_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${run.stdout}${run.stderr}`;
  const counts = RESULT.exec(out);
  const depth = DEPTH.exec(out);
  const ok = run.status === 0 && out.includes("No error has been found");
  const summary = counts ? `${counts[1]} states, ${counts[2]} distinct, depth ${depth?.[1] ?? "?"}` : "no state counts";
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${summary}`);
  if (!ok) console.log(out);
  return ok;
}

const java = findJava();
if (!java) {
  console.log("tlc: skipped, no Java (set TLC_JAVA or JAVA_HOME)");
  process.exit(0);
}
if (!fs.existsSync(JAR)) {
  console.log(`tlc: skipped, no ${JAR} (download tla2tools.jar from https://github.com/tlaplus/tlaplus/releases or set TLA2TOOLS_JAR)`);
  process.exit(0);
}
const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-"));
try {
  const results = specs(process.argv.slice(2)).map((name) => runSpec(java, name, metaRoot));
  process.exitCode = results.every(Boolean) ? 0 : 1;
} finally {
  fs.rmSync(metaRoot, { recursive: true, force: true });
}
