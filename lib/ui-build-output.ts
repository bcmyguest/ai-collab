import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function productionDistDir(web: string = fileURLToPath(new URL("../web/", import.meta.url))): string {
  if (process.env.AI_COLLAB_NEXT_DIST) return process.env.AI_COLLAB_NEXT_DIST;
  let build: string;
  try {
    build = readFileSync(path.join(web, ".next-builds", "current"), "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ".next";
    throw err;
  }
  if (!/^build-[a-zA-Z0-9]+$/.test(build)) throw new Error("Invalid Next.js build pointer");
  return ".next-builds/" + build;
}
