import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PROJECT_PAUSED = "New work is paused for this project";

export type PauseConfig = { stateDir: string; project: string };

const marker = (cfg: PauseConfig) => join(cfg.stateDir, cfg.project, "new-work-paused");

export function isProjectPaused(cfg: PauseConfig): boolean {
  return Boolean(statSync(marker(cfg), { throwIfNoEntry: false }));
}

export function setProjectPaused(cfg: PauseConfig, paused: boolean): void {
  const file = marker(cfg);
  if (paused) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, "", { flag: "a", mode: 0o600 });
  } else {
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
