// Re-exports lib/builder/: the builder's public names for its importers.
export { BUILDER_HARNESSES, BUILDER_START_TIMEOUT_MS, builderPaths, builderSandbox, builderId } from "./builder/state.mjs";
export { harnessCommand, builderPolicy, claudeSettings, claudeMcpConfig, captureHooks, hostCaptureEvents } from "./builder/policy.mjs";
export { toolSources, sharedLibs } from "./builder/stage.mjs";
export { briefNotes, cursorLimitPath, fallbackAttempts, limitFallback, builderResumePrompt } from "./builder/run.mjs";
export { parseRecordedCall, replayable } from "./builder/settle.mjs";
export { stoppedBuilder, builderAssignment, recoverBuilder, ownedBuilder, markOwnedBuilderFailed, stageOwnedBuilder, claimOwnedBuilder, finishOwnedBuilder } from "./builder/recover.mjs";
export { startBuilder } from "./builder/supervisor.mjs";
export { builder } from "./builder/cli.mjs";
