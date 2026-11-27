import { after } from "node:test";
import os from "node:os";
import { tempDir } from "./tmp.mjs";

/** Environment for a server that only lists tools: no network, empty state dir, no OpenShell. */
export function quietEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    AI_COLLAB_PROJECT: "golden",
    AI_COLLAB_PEER: "alice",
    AI_COLLAB_URL: "http://127.0.0.1:9",
    AI_COLLAB_STATE_DIR: tempDir({ after }, "ai-collab-golden-"),
    ...extra,
  };
}
