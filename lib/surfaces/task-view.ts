// Task fields as agents see them through the MCP and code surfaces.
import { PROGRESS_MAX, clipProgress, openTasks, priorityOf } from "../tasks.mjs";
import type { SurfaceConfig, TaskView } from "./types.ts";

export interface TaskUpdateArgs {
  id: string;
  status?: string;
  title?: string;
  detail?: string;
  run?: string;
  owner?: string;
  priority?: string;
  block_on?: string;
  ask?: string;
  options?: string[];
  clear_question?: boolean;
  progress?: string;
}

export function taskView(task: TaskView) {
  return {
    id: task.id, title: task.title, priority: priorityOf(task), status: task.status, ...(task.detail ? { detail: task.detail } : {}),
    ...(task.owner ? { owner: task.owner } : {}), ...(task.run ? { run: task.run } : {}), blockers: task.blockers,
    last: task.progress.at(-1) ?? null,
    ...(task.question ? { question: task.question } : {}),
    ...(task.review ? { review: task.review } : {}),
  };
}

// One task update: patch fields, block_on, and an optional progress note; the note's clipping comes back as a note.
export async function updateTask(cfg: SurfaceConfig, args: TaskUpdateArgs, env: NodeJS.ProcessEnv) {
  const backend = openTasks(cfg.project, env);
  const patch: Record<string, unknown> = {};
  for (const key of ["status", "title", "detail", "run", "owner", "priority"] as const) if (args[key] !== undefined) patch[key] = args[key];
  if (args.block_on !== undefined) patch.block = args.block_on;
  if (args.ask !== undefined && args.clear_question) throw new Error("ask and clear_question cannot be combined");
  if (args.options !== undefined && args.ask === undefined) throw new Error("options need ask");
  if (args.ask !== undefined) patch.ask = { text: args.ask, options: args.options, by: `${cfg.peer}#${cfg.session}` };
  if (args.clear_question) patch.ask = null;
  // The changes and the progress note are one store transaction: all of them are validated, or none is written.
  if (args.progress !== undefined) patch.progress = { by: `${cfg.peer}#${cfg.session}`, text: args.progress };
  const notes: string[] = [];
  if (Object.keys(patch).length) await backend.update(args.id, patch, Date.now());
  if (args.progress !== undefined && clipProgress(args.progress).truncated) notes.push(`progress clipped to ${PROGRESS_MAX} characters`);
  return { task: taskView(backend.get(args.id)), ...(notes.length ? { notes } : {}) };
}
