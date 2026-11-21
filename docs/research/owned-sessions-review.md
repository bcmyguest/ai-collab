# Review of owned-sessions.md (Opus, 2026-11-21)

An adversarial check of `owned-sessions.md` against local sources: the T3 clone, the Codex source and schema, OpenCode, and this repo.

## Why Codex marks the AI Collab hooks "Failed"

Both causes are hook or packaging bugs. Neither needs owned sessions.

**A. The plugin-root hash times out.**
- Before running a plugin hook, Codex hashes the whole plugin root, bounded by the hook's own `timeout`. On timeout it returns "hook timed out" and never runs the hook (`codex-rs/hooks/src/engine/command_runner.rs:230-247`, `plugin_fingerprint.rs:15-80`).
- A content change returns "plugin contents changed; hook approval required" (`plugin_trust.rs:40-43`).
- The cached plugin 0.9.0 was 9.1 GB in 304,621 files, 8.2 GB of it `.claude/worktrees`, because the marketplace pointed at the working checkout.
- Fixed: the marketplace now points at a clean `npm pack` copy (876 KB) in `~/.local/share/ai-collab/codex-plugin`, and `.claude/worktrees/` is gitignored.

**B. An extra key breaks the context hooks.**
- Codex hook output structs use `#[serde(deny_unknown_fields)]` (`hooks/src/schema.rs:88-100, 129-141, 386-394, 428-440`), so a top-level `additional_context` makes the output invalid (`output_parser.rs:347-358`, `session_start.rs:288-297`, `user_prompt_submit.rs:212-216`).
- Codex never injected inbox messages, but the hook had already claimed them and sent read receipts: the messages were silently lost.
- Fixed: `hookOutput` in `lib/format.mjs` gives Codex `hookSpecificOutput` only.

## Claims checked

**Confirmed:**
- Code-mode commands run `PreToolUse` as `Bash` (`registry.rs:896`, `exec_command.rs:331-342`, `wait_handler.rs:238-244`). A live run also confirmed this, so decision 3 is moot.
- T3 commit `5935157` is MIT-licensed, and the line counts are as stated.
- T3 passes `thread_unload_delay_secs=0` (`codexLaunchArgs.ts:16-21`); `MAX_RESENDS = 3`.
- `KillMode=control-group` on the UI unit; `lib/start.mjs:198` starts children with `detached: true`.
- The Codex daemon socket exists.
- The OpenCode 2.3.2 endpoints are as stated.
- The Claude Agent SDK `^0.3.330` is a dependency.

**Wrong or stale:**
- `service.json` is mode 0600, so it is checked, not "not checked".
- `-c thread_unload_delay_secs` reaching a running daemon through `app-server proxy` is unverified and likely ineffective. T3 sets it on its own child.

**Unverified:**
- Cursor ACP `loadSession`.
- Whether the TUI shares daemon threads.
- Which client wins when two answer the same approval.
- Whether Cursor ACP loads `~/.cursor` plugins.

## Omissions that change decisions

1. The motivating Codex gap is mostly hook bugs A and B.
2. The doc does not cover OpenShell.
   - Cursor `--force` inside a sandbox would run as `openshell sandbox exec --no-tty -n <sb> -- cursor-agent acp`.
   - Whether `--force` combines with `acp` is unverified.
   - Still to solve: the Cursor login inside the sandbox, file sync (no host bind mount was seen), ntfy access through policy, and sandbox lifetime.
3. Four parallel adapter agents need a shared contract first: the adapter surface and the envelope shape.
4. Owned Codex sessions load the same plugin hooks, so cause A would have broken them too.

## Suggested settlement of the remaining decisions

- **Codex transport:** a separate `codex app-server` child per runner, with `-c thread_unload_delay_secs=0` and `AI_COLLAB_OWNED`.
- **Cursor:** `cursor-agent acp` via `openshell sandbox exec --no-tty` with `--force`. Fall back to `-p --force --resume` per turn.
- **Event path:** ntfy envelopes for completed items, approvals and push, plus a direct runner→UI SSE stream for deltas. Defer the SSE until the adapters work.
- **Hook stand-down:** a registry file keyed by the native session id, plus an env var where the runner spawns the process.
- **Permissions:**
  - Cursor: full access inside the sandbox.
  - Codex: `on-request` with auto review.
  - Claude: `acceptEdits`.
  - OpenCode: `once` replies.
- **Restart cuts:** avoid them with the runner unit and the sandbox, mark the remaining cut turns interrupted, and never auto-resend.
