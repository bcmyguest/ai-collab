"use strict";

const { spawnSync } = require("node:child_process");
const { constants, openSync, closeSync, fstatSync, readSync, writeFileSync } = require("node:fs");

const MAX_BYTES = 1024 * 1024;

module.exports = function builderTools(count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  function command(file, args) {
    const result = spawnSync(file, args, {
      encoding: "utf8", maxBuffer: MAX_BYTES, timeout: Math.max(1, deadline - Date.now()),
      stdio: ["ignore", "pipe", "pipe"], killSignal: "SIGKILL",
    });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function read(path) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Expected a regular file");
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const length = readSync(fd, bytes, size, bytes.length - size);
        if (!length) break;
        size += length;
      }
      if (size > MAX_BYTES) throw new Error("File exceeds 1 MiB");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size));
    } finally {
      closeSync(fd);
    }
  }

  return Object.freeze({
    sh(script) {
      count();
      return command("/bin/sh", ["-c", script]);
    },
    read(path) {
      count();
      return read(path);
    },
    grep(pattern, path = ".") {
      count();
      const result = command("grep", ["-rInE", "--", pattern, path === "-" ? "./-" : path]);
      if (![0, 1].includes(result.code)) throw new Error(result.stderr || "grep failed");
      return result.stdout;
    },
    edit(path, before, after) {
      count();
      if (typeof before !== "string" || !before || typeof after !== "string") throw new Error("Expected nonempty before and string after");
      const content = read(path);
      const index = content.indexOf(before);
      if (index < 0 || content.indexOf(before, index + 1) >= 0) throw new Error("Expected exactly one occurrence of before");
      const updated = content.slice(0, index) + after + content.slice(index + before.length);
      if (Buffer.byteLength(updated) > MAX_BYTES) throw new Error("Edited file exceeds 1 MiB");
      writeFileSync(path, updated);
    },
  });
};
