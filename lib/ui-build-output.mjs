import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function productionDistDir(web = fileURLToPath(new URL("../web/", import.meta.url))) {
  if (process.env.AI_COLLAB_NEXT_DIST) return process.env.AI_COLLAB_NEXT_DIST;
  let build;
  try {
    build = readFileSync(path.join(web, ".next-builds", "current"), "utf8").trim();
  } catch (err) {
    if (err.code === "ENOENT") return ".next";
    throw err;
  }
  if (!/^build-[a-zA-Z0-9]+$/.test(build)) throw new Error("Invalid Next.js build pointer");
  return ".next-builds/" + build;
}
