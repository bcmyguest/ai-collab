# Live OpenShell bootstrap smoke

Run on a Linux host with Node 24+, the repository dependencies, Git, oncebitten,
and a working disposable OpenShell gateway. Use a disposable host account with
a running systemd user manager and readable user journal for the standalone
builder cases. Install the real harness binaries on PATH in the layouts
described in [Builders](builders.md). The test uses fresh homes, so configure
OpenShell to reach the disposable gateway from a fresh HOME, for example
through a host-local launcher named `openshell` that selects the gateway.
The launcher must forward the production CLI arguments and exit status.

Prepare disposable harness accounts or keys and export the credential
directory. Only the file for the selected harness is copied into each case's
temporary home. Keep the directory outside the repo and set the files to mode
0600. Choose models that require those credentials, including a paid or
otherwise authenticated provider model for OpenCode.

| Harness | Path under the credential directory | Model variable |
|---|---|---|
| Claude | `.claude/.credentials.json` | `AI_COLLAB_LIVE_MODEL_CLAUDE` |
| Codex | `.codex/auth.json` | `AI_COLLAB_LIVE_MODEL_CODEX` |
| Cursor | `.config/cursor/auth.json` | `AI_COLLAB_LIVE_MODEL_CURSOR` |
| OpenCode | `.local/share/opencode/auth.json` | `AI_COLLAB_LIVE_MODEL_OPENCODE` |

Run the complete matrix from the checkout with all four model variables set.

```sh
export AI_COLLAB_LIVE_CREDENTIALS=/absolute/path/to/disposable-logins
TMPDIR=$(mktemp -d -p /tmp) AI_COLLAB_LIVE_SANDBOX=1 node --test test/live-sandbox-matrix.test.mjs
```

The suite skips by default. Set `AI_COLLAB_LIVE_CASES` to a comma-separated
list to run affected cases after changing a policy, bootstrap, or credential
staging. Run the full matrix for shared changes.

```sh
TMPDIR=$(mktemp -d -p /tmp) AI_COLLAB_LIVE_SANDBOX=1 \
  AI_COLLAB_LIVE_CASES=builder:cursor,runner-owned:cursor,scheduled:cursor \
  node --test test/live-sandbox-matrix.test.mjs
```

| Case selector | Harnesses | Output verified |
|---|---|---|
| `builder:<harness>` | Claude, Codex, Cursor, OpenCode | Standalone builder's systemd user journal |
| `builder-owned:codex` | Codex | Builder session's activity timeline |
| `runner-owned:cursor` | Cursor | Runner session's activity timeline |
| `scheduled:<harness>` | Claude, Codex, Cursor, OpenCode | Scheduled tick history from the runner API |

The matrix uses `builder start`, the runner session API, and the runner
scheduler. Each case requires a successful turn containing a random response
marker and checks the sandbox list after normal teardown. The timeline checks
read the activity topic from the in-process test bus (`test/helpers/fake-ntfy.mjs`). Standalone builders
and fresh sandboxed ticks currently expose output through the journal and tick
history respectively. The extra Codex builder case exercises its runner-owned
branch. The other runner-owned harnesses lack a standalone OpenShell launch.

The temporary workspaces and staged credential copies are removed on completion.
Revoke the disposable credentials after the run. When diagnosing a standalone
builder failure, the host user journal retains the unit output. If the test is
forcibly terminated, use the disposable gateway to find and remove the smoke
sandboxes before running again.
