// Shared contract for owned-session adapters; prose and rules live in docs/owned-sessions-contract.md.

export type Harness = "claude" | "codex" | "cursor" | "opencode";
export type PermissionMode = "supervised" | "accept-edits" | "auto" | "full-access";
export type Place = "folder" | "worktree" | "openshell";
export type SessionStatus = "starting" | "idle" | "running" | "ended";

// Text plus optional images; messageIds are the ntfy ids this input carries, for read receipts.
export interface UserInput {
  text: string;
  images?: { path: string; mime: string }[];
  messageIds?: string[];
}

export interface Model { id: string; label?: string; default?: boolean }
export interface SlashCommand { name: string; description?: string; argumentHint?: string }
export interface ContextUsage { tokens: number; window?: number }

// The operator's answer to an interrupt; answers carries an AskUserQuestion-style choice.
export interface Decision { behavior: "allow" | "deny"; answers?: Record<string, string>; message?: string }

// Subagent attribution, as AG-UI's subagentRunId.
interface Sub { subagentRunId?: string; subagentType?: string }

export interface JsonPatchOp { op: "add" | "replace" | "remove"; path: string; value?: unknown }

// Normalized events, named after AG-UI 1.0 event types; adapters emit only these through SessionContext.emit.
export type RunnerEvent =
  | { type: "RUN_STARTED"; runId: string; prompt?: string }
  | ({ type: "TEXT_MESSAGE_CHUNK"; messageId: string; delta: string } & Sub)
  | ({ type: "TEXT_MESSAGE_END"; messageId: string; text: string } & Sub)
  | ({ type: "TOOL_CALL_START"; toolCallId: string; toolCallName: string; args?: unknown } & Sub)
  | ({ type: "TOOL_CALL_RESULT"; toolCallId: string; toolCallName: string; content?: unknown; ok: boolean } & Sub)
  | { type: "INTERRUPT_REQUESTED"; interruptId: string; reason: "tool_approval" | "question"; toolCallId?: string; toolCallName: string; summary: string; args?: unknown; questions?: unknown[] }
  | { type: "INTERRUPT_RESOLVED"; interruptId: string; status: "resolved" | "cancelled"; reason: "allowed" | "denied" | "answered" | "cancelled" }
  | { type: "STEP_STARTED"; stepName: string; note?: string }
  | { type: "STEP_FINISHED"; stepName: string }
  | { type: "STATE_DELTA"; delta: JsonPatchOp[] }
  | { type: "CUSTOM"; name: "notice" | "error"; value: string }
  | { type: "RUN_FINISHED"; runId: string; outcome: "success" | "cancelled"; reason?: string }
  | { type: "RUN_ERROR"; runId: string; message: string };

export interface SessionContext {
  emit(event: RunnerEvent): void;
  log(message: string): void;
  // Aborted when the runner stops or the session closes.
  signal: AbortSignal;
}

export interface OpenOptions {
  project: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  // The harness settings for permissionMode, from PERMISSION_TABLE in runner/contract.mjs.
  permission: Record<string, unknown>;
  place: Place;
  // Child environment: lib/start.mjs childEnv plus AI_COLLAB_OWNED=<harness>.
  env: Record<string, string>;
}

// Projection in $AI_COLLAB_STATE_DIR/<project>/owned/<label>.json; the durable log is the source of truth.
export interface OwnedRecord {
  v: 1;
  label: string;
  address: string;
  workflowId: string;
  harness: Harness;
  nativeId: string;
  project: string;
  cwd: string;
  place: Place;
  model?: string;
  permissionMode: PermissionMode;
  status: SessionStatus;
  run: { id: string; startedAt: number } | null;
  cut?: { runId: string; at: number; reason: string };
  approvals: { id: string; interruptId: string; tool: string; summary: string }[];
  // Adapter-private resume data from SessionHandle.resumeData (JSON only).
  resume?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SessionHandle {
  // Known when open() resolves, before any prompt reaches the harness.
  nativeId: string;
  // Starts a run on an idle session; resolves with its runId once the harness accepted the input.
  send(input: UserInput): Promise<{ runId: string }>;
  // Adds input to the running run; only when capabilities.steer.
  steer?(input: UserInput): Promise<void>;
  // Ends the running run; the adapter then emits RUN_FINISHED outcome "cancelled".
  interrupt(): Promise<void>;
  respond(interruptId: string, decision: Decision): Promise<void>;
  // After resume(): the runId still running in the harness, or null when idle (live adapters only).
  activeRun?(): string | null;
  contextUsage?(): Promise<ContextUsage | null>;
  setModel?(model: string): Promise<void>;
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  resumeData?(): Record<string, unknown>;
  // Ends the session's process; the native session stays resumable.
  close(): Promise<void>;
}

export interface Capabilities {
  steer: boolean;
  images: boolean;
  // live: a run survives a runner restart; transcript: history survives, the run is cut; none: not resumable.
  resume: "live" | "transcript" | "none";
  permissionModes: PermissionMode[];
}

export interface Adapter {
  harness: Harness;
  capabilities: Capabilities;
  available(env: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
  // Opens a native session without a prompt.
  open(options: OpenOptions, ctx: SessionContext): Promise<SessionHandle>;
  // Reattaches to record.nativeId; live adapters re-emit INTERRUPT_REQUESTED for still-pending requests.
  resume(record: OwnedRecord, ctx: SessionContext, env: Record<string, string>): Promise<SessionHandle>;
  listModels(env: Record<string, string>): Promise<Model[]>;
  listCommands(cwd: string, env: Record<string, string>): Promise<SlashCommand[]>;
  // Stops shared children (one Codex app-server, one ACP process) once every session closed.
  shutdown(): Promise<void>;
}

// Default export of runner/adapters/<harness>.mjs.
export type AdapterFactory = (options: { env: Record<string, string>; stateDir: string }) => Adapter;
