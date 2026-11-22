# Troubleshooting

## Setup

| Message | Fix |
|---|---|
| `ntfy: Docker not found.` | Install Docker, or write `defaults.json` for your own ntfy (see [Quick start](quick-start.md#your-own-ntfy-server)), then rerun. |
| `ntfy: docker …: <output>` | A Docker Compose step failed; the line carries its output. Fix it and rerun; finished steps are skipped. |
| `harnesses: none found on PATH` | Put `claude`, `codex`, `cursor-agent`, or `opencode` on `PATH` and rerun, or [install by hand](install.md). |
| `ui: no systemd: run npm run ui in <checkout>` | Start the UI by hand; see [Install](install.md#the-ui-by-hand). |
| `ui: build failed: …` | Run `npm run build` in the checkout and read its output. |
| `codex: installed; restart Codex and trust the hooks in /hooks` | Restart Codex and trust the plugin hooks in `/hooks`. |

## The plugin does nothing

- **Fail open.** A timeout, outage, bad config, or malformed input prints `{}` and exits 0, so a broken setup looks like silence. Run `ai-collab peers`: invalid values disable the plugin and it prints the reason.
- **Repo opted out.** An empty `.ai-collab-off` file in the repo root keeps that repo out of auto-join.
- **Codex hooks untrusted.** Check `/hooks` after a restart.
- **Cursor.** Restart Cursor after the installer runs; only `~/.cursor/hooks.json` receives prompt and tool events (see [Install](install.md#cursor)).

CLI exit codes: 0 success, 1 error (for example a peer not in `AI_COLLAB_PEERS`, an empty body, or an outage), 2 disabled.

## The UI

- **UI broken after moving the checkout.** `next build` records the absolute path of `web/server/ui.mjs`; rebuild.
- **The UI refuses to start.** With `github.json` present it needs `AI_COLLAB_UI_ORIGIN`.
- **Posts fail from the phone.** Every `POST /api/*` must come from `AI_COLLAB_UI_ORIGIN`; set it to the HTTPS URL without a trailing slash and restart the service.
- **No push notifications.** Push needs HTTPS. On iPhone and iPad, open AI Collab from the Home Screen. See [Push notifications](phone-ui.md#push-notifications).
- **A session looks busy in AFK mode.** It is running its Stop hook; see [Coming back to the terminal](afk.md#coming-back-to-the-terminal).

## HTTP 429 from ntfy

ntfy rate-limits requests per client IP (default burst 60, one more every 5 s). All local agents and the UI share one address; many AFK agents waking at once can hit HTTP 429. `deploy/compose.yaml` sets `NTFY_VISITOR_REQUEST_LIMIT_EXEMPT_HOSTS` to `127.0.0.1,::1,172.16.0.0/12`. On your own server, add `127.0.0.1` to `visitor-request-limit-exempt-hosts`.

A 429 with code 42905 and `daily bandwidth reached` is a different limit: the exempt hosts do not cover it. The client logs `ai-collab: ntfy HTTP 429 code 42905: ...` once per process. Earlier builds re-read the same broadcast backlog every 5 s for each idle session, which likely exhausted the daily budget. The pump now keeps an in-memory read position, skips a 429 topic for the rest of its tick, and pauses 1, 2, 4 ... ticks (at most 6) after a tick that met a 429. If the line persists, check `docker logs ai-collab-ntfy` and the server's visitor bandwidth setting.

## Known limits

- Peer names are self-asserted. Use ntfy ACLs to restrict who can publish.
- Delivery is best effort with no retry; read receipts are best effort too. An offline peer only gets messages still inside the server's cache window.
- Codex, Cursor, and OpenCode event shapes are not verified against live sessions. `beforeSubmitPrompt` and Codex `PostToolUse` are deliberately not registered.
- Status shows peers that have started or stopped. It is not a presence system.
- An agent idle at its prompt with AFK mode `off` still hears a message only at its next hook.
- A mode set more than 12 hours ago is gone from the ntfy cache; new sessions then start in `off`.
