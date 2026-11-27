// Shared contract for owned-session adapters; prose and rules live in docs/owned-sessions-contract.md.
import type { AGUIEventOf, CustomEvent, EventType } from "@ag-ui/core";

export type Harness = "claude" | "codex" | "cursor" | "opencode";
export type PermissionMode = "supervised" | "accept-edits" | "auto" | "full-access";
export type Place = "folder" | "worktree" | "openshell";
export type SessionStatus = "starting" | "idle" | "running" | "ended";

// Text plus optional images; messageIds are the bus event ids this input carries, for read receipts.
export interface UserInput {
  text: string;
  images?: { path: string; mime: string }[];
  messageIds?: string[];
}

export interface Model { id: string; label?: string; default?: boolean }
export interface SlashCommand { name: string; description?: string; argumentHint?: string }
export interface ContextUsage { tokens: number; window?: number }
// What a harness compaction reported: before/after token counts when the harness names them.
export interface CompactResult { before?: number; after?: number }

// The operator's answer to an interrupt; answers carries an AskUserQuestion-style choice. scope "session" allows the
// same tool kind for the rest of the session (the adapter answers later asks itself); "once" or none allows this call.
export interface Decision { behavior: "allow" | "deny"; answers?: Record<string, string>; message?: string; scope?: "once" | "session" }

type RunnerCustomEvent = CustomEvent & (
  | { name: "ai-collab.notice" | "ai-collab.error"; value: string }
  | { name: "ai-collab.approval-requested"; value: {
      interruptId: string; reason: "tool_approval" | "question"; toolCallId?: string;
      toolCallName: string; summary: string; questions?: unknown[];
    } }
  | { name: "ai-collab.approval-resolved"; value: {
      interruptId: string; status: "resolved" | "cancelled"; reason: "allowed" | "denied" | "answered" | "cancelled";
    } }
);

export type RunnerEvent = RunnerCustomEvent | AGUIEventOf<
  EventType.RUN_STARTED | EventType.RUN_FINISHED | EventType.RUN_ERROR |
  EventType.TEXT_MESSAGE_CONTENT | EventType.TEXT_MESSAGE_CHUNK |
  EventType.TOOL_CALL_CHUNK | EventType.TOOL_CALL_RESULT |
  EventType.STEP_STARTED | EventType.STEP_FINISHED | EventType.STATE_DELTA
>;

export interface SessionContext {
  emit(event: RunnerEvent): void;
  log(message: string): void;
  // Aborted when the runner stops or the session closes.
  signal: AbortSignal;
}

export interface OpenOptions {
  project: string;
  cwd: string;
  patternRun?: string;
  model?: string;
  permissionMode: PermissionMode;
  // The harness settings for permissionMode, from PERMISSION_TABLE in runner/contract.ts.
  permission: Record<string, unknown>;
  place: Place;
  // Child environment: lib/sessions/launch.ts childEnv plus AI_COLLAB_OWNED=<harness> (and AI_COLLAB_MANAGED=1 for a managed Claude or Codex session).
  env: Record<string, string>;
  // Set for a session ai-collab started (team, pattern, builder, spawn): the adapter turns native subagents off.
  managed?: boolean;
  // MCP servers beyond the ai-collab bus server, for an adapter that passes them to its harness (Cursor ACP): an ACP McpServer array or a Cursor mcp.json `mcpServers` record.
  mcpServers?: unknown;
}

// Projection in $AI_COLLAB_STATE_DIR/<project>/owned/<label>.json; the durable log is the source of truth.
export interface OwnedRecord {
  v: 1;
  label: string;
  address: string;
  workflowId: string;
  taskId?: string;
  harness: Harness;
  nativeId: string;
  project: string;
  cwd: string;
  place: Place;
  patternRun?: string;
  model?: string;
  // A session ai-collab started; native subagents stay off on resume.
  managed?: boolean;
  // The address that spawned this session (spawn_agent), and its depth below the first parent.
  parent?: string;
  spawn?: { depth: number };
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
  // A rejection may carry: mayHaveStarted (the harness may have taken the input; never resent), or retryable
  // (the harness refused the request and ran nothing; the caller may retry it).
  send(input: UserInput): Promise<{ runId: string }>;
  // Adds input to the running run; only when capabilities.steer.
  steer?(input: UserInput): Promise<void>;
  // Ends the running run; the adapter then emits RUN_FINISHED outcome "cancelled".
  interrupt(): Promise<void>;
  // Compacts the session's context in place through the harness's own trigger, and resolves once it finished.
  // Absent when the harness exposes no trigger (Cursor); the runner then reports that instead of asking by message.
  compact?(): Promise<CompactResult>;
  respond(interruptId: string, decision: Decision): Promise<void>;
  contextUsage?(): Promise<ContextUsage | null>;
  setModel?(model: string): Promise<void>;
  // Applies PERMISSION_TABLE[harness][mode] to the open session; only the operator reaches it, through the control socket.
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  resumeData?(): Record<string, unknown>;
  // Ends the session's process; the native session stays resumable.
  close(): Promise<void>;
}

export interface Capabilities {
  steer: boolean;
  images: boolean;
  // transcript: history survives a runner restart and the run is cut (marked interrupted, never resent); none: not resumable.
  resume: "transcript" | "none";
  permissionModes: PermissionMode[];
  // Places the runner may put a session in; folder and worktree when absent.
  places?: Place[];
}

export interface Adapter {
  harness: Harness;
  capabilities: Capabilities;
  available(env: Record<string, string>): Promise<{ ok: boolean; detail?: string }>;
  // Opens a native session without a prompt.
  open(options: OpenOptions, ctx: SessionContext): Promise<SessionHandle>;
  // Reattaches to record.nativeId for the next input; a cut run is not resumed.
  resume(record: OwnedRecord, ctx: SessionContext, env: Record<string, string>): Promise<SessionHandle>;
  listModels(env: Record<string, string>): Promise<Model[]>;
  listCommands(cwd: string, env: Record<string, string>): Promise<SlashCommand[]>;
  // Stops shared children (one Codex app-server, one ACP process) once every session closed.
  shutdown(): Promise<void>;
}

// Default export of runner/adapters/<harness>.ts (cursor.mjs until its ACP client lands).
export type AdapterFactory = (options: { env: Record<string, string>; stateDir: string }) => Adapter;
