import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

/** Environment for a server that only lists tools: no network, empty state dir, no OpenShell. */
export function quietEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    AI_COLLAB_PROJECT: "golden",
    AI_COLLAB_PEER: "alice",
    AI_COLLAB_URL: "http://127.0.0.1:9",
    AI_COLLAB_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "ai-collab-golden-")),
    ...extra,
  };
}
