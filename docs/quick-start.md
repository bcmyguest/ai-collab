# Quick start

Requirements: Node 22+, Docker with Compose, and at least one harness on `PATH` (`claude`, `codex`, `cursor-agent`, or `opencode`).

```sh
git clone https://github.com/bcmyguest/ai-collab && cd ai-collab && npm ci
node scripts/ai-collab.mjs setup
```

## What setup does

1. **Starts ntfy in Docker.** `docker compose -f deploy/compose.yaml up -d --wait` runs `binwiederhier/ntfy:v2.38.1` on `127.0.0.1:8794` with `auth-default-access: deny-all`, a 12-hour message and attachment cache, and data under `~/.local/share/ai-collab/ntfy`. Setup adds an ntfy admin user `ai-collab` with a random password, creates a token, and writes it to `~/.config/ai-collab/ntfy-token` (mode 0600).
2. **Writes `~/.config/ai-collab/defaults.json`** with `url`, `tokenFile`, and `peers` (the harnesses found on `PATH`). Every git repo then joins under its folder name; an empty `.ai-collab-off` file in a repo root keeps that repo out. See [Configuration](configuration.md#auto-join-every-repo-defaultsjson).
3. **Installs the plugin for each harness on `PATH`:**

   | Harness | What setup runs | Then |
   |---|---|---|
   | Claude Code | `claude plugin marketplace add <checkout>`, `claude plugin install ai-collab@ai-collab` | |
   | Codex | `codex plugin marketplace add <checkout>`, `codex plugin add ai-collab@ai-collab` | restart Codex and trust the hooks in `/hooks` |
   | Cursor | the [Cursor installer](install.md#cursor) with `--copy` | restart running Cursor sessions |
   | OpenCode | the [OpenCode installer](install.md#opencode) | restart OpenCode |

4. **Installs the UI** as the systemd user service `ai-collab-ui` on `http://127.0.0.1:8795`. It builds `web/` first when no build exists. An existing `~/.config/systemd/user/ai-collab-ui.service` is kept. Without systemd, setup tells you to run `npm run ui`.
5. **Prints the phone steps.** Setup changes nothing on your network.

Reruns skip finished steps: an existing `defaults.json` with `url` and `tokenFile` skips the ntfy step.

| Flag | Effect |
|---|---|
| `--port N` | Publish ntfy on `127.0.0.1:N` instead of 8794 |
| `--no-ui` | Skip the UI service |

## Your own ntfy server

Write `~/.config/ai-collab/defaults.json` by hand before you run setup. Setup then uses that server and skips Docker:

```json
{ "url": "https://ntfy.example.ts.net", "tokenFile": "/home/you/.config/ai-collab/ntfy-token", "peers": "claude,codex,cursor,opencode" }
```

Keep the server private: authenticated, with deny-all default access. See [Security model](security.md).

## Phone access

Setup prints these steps:

1. Install [Tailscale](https://tailscale.com/download) on this machine and your phone, both signed in to one tailnet.
2. `tailscale serve --bg --https=443 http://127.0.0.1:8795`
3. Set `AI_COLLAB_UI_ORIGIN` to the printed `https` URL in `~/.config/systemd/user/ai-collab-ui.service`, then run `systemctl --user restart ai-collab-ui`.
4. Open that URL on your phone and add it to the home screen.

Next: [Phone UI](phone-ui.md), [AFK mode](afk.md), [push notifications](phone-ui.md#push-notifications).
