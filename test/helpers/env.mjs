import { after } from "node:test";
import os from "node:os";
import { tempDir } from "./tmp.mjs";

/** Environment for a peer talking to the fake server, with an isolated state dir. */
export function peerEnv(fake, { peer = "alice", stateDir, ...extra } = {}) {
  return {
    PATH: process.env.PATH,
    HOME: os.tmpdir(),
    AI_COLLAB_URL: fake.url,
    AI_COLLAB_PROJECT: "demo",
    AI_COLLAB_PEER: peer,
    AI_COLLAB_PEERS: "alice,bob,carol",
    AI_COLLAB_STATE_DIR: stateDir || tempDir({ after }, "ai-collab-state-"),
    AI_COLLAB_TIMEOUT_MS: "2000",
    ...extra,
  };
}
