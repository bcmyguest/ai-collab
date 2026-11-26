// Posts to the shared channel; a progress post also records on the session's building task.
import { sendMessage } from "../inbox.mjs";
import { storedMode } from "../mode.mjs";
import { PROGRESS_MAX, clipProgress, ownedBuilding, recordOwnerProgress } from "../tasks.mjs";
import type { SurfaceConfig } from "./types.ts";

export interface ChannelPost {
  body: string;
  reply_to?: string;
  progress?: boolean;
  attachment?: string;
}

export async function postToChannel(cfg: SurfaceConfig, { body, reply_to: replyTo, progress, attachment }: ChannelPost, env: NodeJS.ProcessEnv) {
  const { mode } = storedMode(cfg);
  if (progress === true && mode === "quiet") return { sent: false, reason: "AFK mode is QUIET: progress posts are dropped." };
  await sendMessage(cfg, "all", body, { replyTo, attachment });
  if (progress !== true) return { sent: true, mode };
  // The post already went out, so a task store fault becomes a note and never a failed (retried) send.
  const notes: string[] = [];
  let owned: unknown[] = [];
  try {
    owned = ownedBuilding(cfg, env);
    recordOwnerProgress(cfg, body, env).catch((error: Error) => process.stderr.write(`ai-collab: task progress not recorded: ${error.message}\n`));
  } catch (error) {
    process.stderr.write(`ai-collab: task store unavailable: ${(error as Error).message}\n`);
    notes.push(`task store unavailable: ${(error as Error).message}`);
  }
  if (clipProgress(body).truncated) notes.push(`progress clipped to ${PROGRESS_MAX} characters on its task entries`);
  if (!owned.length && !notes.some((n) => n.startsWith("task store"))) notes.push("no building task is owned by this session; the note went to the channel only");
  return notes.length ? { sent: true, mode, notes } : { sent: true, mode };
}
