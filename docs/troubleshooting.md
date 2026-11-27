# Troubleshooting

## Setup

| Message | Fix |
|---|---|
| `bus: no systemd: run ...` | No systemd user services; run `node scripts/ai-collab-bus.mjs` in the background, or install systemd. |
| `ai-collab-bus: no token` | The bus found no token. Set `tokenFile` in `defaults.json`, or `AI_COLLAB_BUS_TOKEN`. |
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

## Usage-limit cards

| Symptom | Fix |
|---|---|
| No limit card after a session hit its limit. | Detached `codex exec`, `opencode run` and `cursor-agent -p` sessions have no error hook, so they never alert. Owned sessions and Claude sessions do. The Codex, OpenCode and Cursor patterns are UNVERIFIED; see [Usage-limit cards](phone-ui.md#usage-limit-cards). |

## The UI

- **UI broken after moving the checkout.** `next build` records the absolute path of `web/server/ui.mjs`; rebuild.
- **The UI refuses to start.** With `github.json` present it needs `AI_COLLAB_UI_ORIGIN`.
- **Posts fail from the phone.** Every `POST /api/*` must come from `AI_COLLAB_UI_ORIGIN`; set it to the HTTPS URL without a trailing slash and restart the service.
- **No push notifications.** Push needs HTTPS. On iPhone and iPad, open AI Collab from the Home Screen. See [Push notifications](phone-ui.md#push-notifications).
- **A session looks busy in AFK mode.** It is running its Stop hook; see [Coming back to the terminal](afk.md#coming-back-to-the-terminal).

## HTTP 429 (only with your own ntfy server)

The local bus does not rate-limit. If you point `url` at an ntfy server, it rate-limits per client IP and bills attachment bandwidth; add `127.0.0.1` to `visitor-request-limit-exempt-hosts` there. The client logs `ai-collab: ntfy HTTP 429 ...` once per process, and the pump skips a 429 topic for the rest of its tick and backs off.

## Known limits

- Peer names are self-asserted. The bus token is the only gate; keep it private.
- A failed send is not retried; only `expect_reply` messages are redelivered. Read receipts are best effort too. An offline peer only gets messages still inside the bus's 7-day retention (`AI_COLLAB_BUS_RETENTION_HOURS`).
- Codex, Cursor, and OpenCode event shapes are not verified against live sessions. `beforeSubmitPrompt` and Codex `PostToolUse` are deliberately not registered.
- Status shows peers that have started or stopped. It is not a presence system.
- An idle Cursor session hears a message only at its next hook; Claude, Codex and OpenCode get direct messages pushed ([Waking idle sessions](messaging.md#waking-idle-sessions)). Broadcasts without an `@mention` wake nobody.
- A mode set more than 12 hours ago is outside the mode read window (`lib/mode.ts`); new sessions then start in `off`.
