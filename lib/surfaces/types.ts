// Shapes the operation table passes between tool arguments and the ai-collab modules.
export type Args = Record<string, unknown>;

// The fields of a loaded config (lib/config.mjs) that the surfaces read.
export interface SurfaceConfig {
  peer: string;
  session?: string;
  project: string;
  peers: string[];
  afkWaitS: number;
  stateDir: string;
}

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
