import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The transcript path Claude uses for a session: projects/<cwd with non-alphanumerics as "-">/<session>.jsonl. */
export function transcriptPath(home, cwd, sessionId) {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
}

/**
 * A fake Claude home under a new temp dir: settings.json (crossSessionInbound), sessions/<pid>.json with the socket
 * path, and a peer token file. Returns {home, cwd, transcript}; cwd is a fresh absolute dir.
 */
export function fakeClaudeHome(t, { sessionId, pid = process.pid, accept = "accept", socket = null, token = "tok-123", extraKeys = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fc-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "fc-cwd-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });
  const dir = join(home, ".claude");
  mkdirSync(join(dir, "sessions"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ crossSessionInbound: accept }));
  const rec = { pid, sessionId, status: "idle", cwd };
  if (socket) rec.messagingSocketPath = socket;
  writeFileSync(join(dir, "sessions", `${pid}.json`), JSON.stringify(rec));
  if (token !== null) writeFileSync(join(dir, "sessions", `${pid}.abc123.key`), `${token}\n`);
  extraKeys.forEach((name, i) => writeFileSync(join(dir, "sessions", `${pid}.k${i}.key`), `${name}\n`));
  return { home, cwd, transcript: transcriptPath(home, cwd, sessionId) };
}

/**
 * A fake messaging socket. It drops a connection whose first frame is not an auth frame with the token. After auth it
 * records each user frame; when accept is true it appends the frame to the transcript, as Claude does on delivery.
 * refuse: true keeps frames out of the transcript, the way Claude's hold or drop does.
 */
export async function fakeClaudeSocket(t, { token = "tok-123", accept = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fc-sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "s.sock");
  const frames = [];
  const dropped = [];
  const state = { accept, transcript: null };
  const server = createServer((conn) => {
    let buffer = "";
    let authed = false;
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const f = JSON.parse(line);
        if (!authed) {
          if (f.type !== "auth" || f.token !== token) {
            dropped.push(f);
            conn.destroy();
            return;
          }
          authed = true;
          continue;
        }
        frames.push(f);
        if (state.accept && state.transcript && f.type === "user") {
          mkdirSync(join(state.transcript, ".."), { recursive: true });
          appendFileSync(state.transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", content: f.message.content })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { path, frames, dropped, state };
}
