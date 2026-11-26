import type { Cfg } from "../messaging.ts";

// Shapes the operation table passes between tool arguments and the ai-collab modules.
export type Args = Record<string, unknown>;

// The loaded config (lib/config.mjs) the surfaces pass to the messaging functions.
export type SurfaceConfig = Cfg;

export interface TaskView {
  id: string;
  title: string;
  status: string;
  detail?: string;
  owner?: string;
  run?: string;
  blockers: unknown[];
  progress: { by?: string; text: string }[];
  question?: unknown;
  review?: unknown;
}

/** Passes a value to a JavaScript module whose parameter types are inferred or JSDoc; that module validates its own input. */
export function passJs(value: unknown): never {
  return value as never;
}
