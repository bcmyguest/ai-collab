// Runs TLC on every spec in spec/tla that has a .cfg (bounded models end, so deadlock is not checked); fails when TLC cannot run.
// Java: TLC_JAVA, else $JAVA_HOME/bin/java, else java on PATH, else Docker with the pinned JRE image (TLC_DOCKER=1 forces Docker).
// Jar: TLA2TOOLS_JAR, else ~/.cache/tlaplus/tla2tools.jar, downloaded and checked against JAR_SHA256 when missing.
// Usage: npm run tlc [-- Spec ...]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPEC_DIR = fileURLToPath(new URL("../spec/tla/", import.meta.url));
const JAR = process.env.TLA2TOOLS_JAR || path.join(os.homedir(), ".cache", "tlaplus", "tla2tools.jar");
// tlaplus v1.7.4 (TLC 2.19); the checksum is the release asset's.
const JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar";
const JAR_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
// eclipse-temurin:21-jre, pinned to its multi-arch index digest.
const IMAGE = "eclipse-temurin@sha256:d77e090ae1f6970c047b443c6f0a6c1358b0426d44432bb5a7753408cd43de0d";
const RESULT = /(\d+) states generated, (\d+) distinct states found, (\d+) states left on queue/;
const DEPTH = /The depth of the complete state graph search is (\d+)/;

const works = (bin, args) => spawnSync(bin, args, { stdio: "ignore" }).status === 0;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** How to run java with the jar and spec dir visible, or null when neither Java nor Docker works. */
function findJava(metaRoot) {
  if (process.env.TLC_DOCKER !== "1") {
    const host = [process.env.TLC_JAVA, process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "java"), "java"].filter(Boolean)
      .find((bin) => works(bin, ["-version"]));
    if (host) return { cmd: host, pre: [], jar: JAR, meta: metaRoot, label: host };
  }
  if (!works("docker", ["version", "--format", "{{.Server.Version}}"])) return null;
  const user = typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid()}`] : [];
  const pre = ["run", "--rm", "--network", "none", ...user, "-v", `${SPEC_DIR}:/spec:ro`, "-v", `${JAR}:/tla2tools.jar:ro`, "-v", `${metaRoot}:/meta`, "-w", "/spec", IMAGE, "java"];
  return { cmd: "docker", pre, jar: "/tla2tools.jar", meta: "/meta", label: "docker eclipse-temurin:21-jre (pinned digest)" };
}

/** Downloads the pinned jar when the default cache has none, and checks the default jar against JAR_SHA256. */
async function ensureJar() {
  if (!fs.existsSync(JAR)) {
    if (process.env.TLA2TOOLS_JAR) throw new Error(`TLA2TOOLS_JAR ${JAR} does not exist`);
    console.log(`tlc: downloading ${JAR_URL}`);
    const response = await fetch(JAR_URL);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    fs.mkdirSync(path.dirname(JAR), { recursive: true });
    const part = `${JAR}.part-${process.pid}`;
    fs.writeFileSync(part, Buffer.from(await response.arrayBuffer()));
    if (sha256(part) !== JAR_SHA256) {
      fs.rmSync(part, { force: true });
      throw new Error("downloaded tla2tools.jar does not match JAR_SHA256");
    }
    fs.renameSync(part, JAR);
  }
  if (!process.env.TLA2TOOLS_JAR && sha256(JAR) !== JAR_SHA256) throw new Error(`${JAR} does not match JAR_SHA256; delete it to download v1.7.4`);
}

function specs(names) {
  const all = fs.readdirSync(SPEC_DIR).filter((name) => name.endsWith(".cfg")).map((name) => name.slice(0, -4)).sort();
  const picked = names.length ? all.filter((name) => names.includes(name)) : all;
  if (!picked.length) throw new Error(`no spec named ${names.join(", ")} in spec/tla`);
  return picked;
}

function runSpec(java, name) {
  const args = [...java.pre, "-XX:+UseParallelGC", "-cp", java.jar, "tlc2.TLC", "-deadlock", "-workers", "auto", "-cleanup", "-metadir", `${java.meta}/${name}`, "-config", `${name}.cfg`, `${name}.tla`];
  const run = spawnSync(java.cmd, args, { cwd: SPEC_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${run.stdout}${run.stderr}`;
  const counts = RESULT.exec(out);
  const depth = DEPTH.exec(out);
  const ok = run.status === 0 && out.includes("No error has been found");
  const summary = counts ? `${counts[1]} states, ${counts[2]} distinct, depth ${depth?.[1] ?? "?"}` : "no state counts";
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${summary}`);
  if (!ok) console.log(out);
  return ok;
}

const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tlc-"));
try {
  const java = findJava(metaRoot);
  if (!java) throw new Error("no Java (TLC_JAVA, JAVA_HOME or java on PATH) and no Docker");
  await ensureJar();
  console.log(`tlc: java from ${java.label}`);
  const results = specs(process.argv.slice(2)).map((name) => runSpec(java, name));
  process.exitCode = results.every(Boolean) ? 0 : 1;
} catch (error) {
  console.log(`tlc: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(metaRoot, { recursive: true, force: true });
}
