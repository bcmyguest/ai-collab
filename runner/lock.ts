// Single-instance lock: a pid file beside the workflow log, replaced only when its process is gone.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the lock at file; throws while another live runner holds it. Resolves to a release function. */
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue; // released between the two calls
        throw readError;
      }
      if (alive(pid)) throw new Error(`another runner holds ${file} (pid ${pid})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`cannot take ${file}`);
}
