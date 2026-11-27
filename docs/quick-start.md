# Quick start

Requirements: Node 24+, Docker for the local Postgres, and at least one harness on `PATH` (`claude`, `codex`, `cursor-agent`, or `opencode`).

```sh
npx ai-collab postgres up
npx ai-collab setup
```

Pick the agents with `--agent`, for example `npx ai-collab setup --agent claude,cursor,opencode`. Setup copies itself to `~/.local/share/ai-collab/app`, so plugins and the UI keep working after npm clears its cache. From a clone, run `npm ci && node scripts/ai-collab.mjs setup` instead.

## What setup does

1. **Installs the message bus** as the systemd user service `ai-collab-bus`: `lib/bus.ts` on `127.0.0.1:8794`, backed by Postgres (schema `bus`, from `ai-collab postgres up`) with a 7-day retention, deny-all without a token. Without Postgres the bus exits and setup prints the command to start it. Setup writes a token to `~/.config/ai-collab/bus-token` (mode 0600). Without systemd, setup prints how to run `scripts/ai-collab-bus.mjs` by hand.
2. **Writes `~/.config/ai-collab/defaults.json`** with `url`, `tokenFile`, and `peers` (the harnesses found on `PATH`). Every git repo then joins under its folder name; an empty `.ai-collab-off` file in a repo root keeps that repo out. See [Configuration](configuration.md#auto-join-every-repo-defaultsjson).
3. **Installs the plugin for each harness on `PATH`, or each one named with `--agent`:**

   | Harness | What setup runs | Then |
   |---|---|---|
   | Claude Code | `claude plugin marketplace add <checkout>`, `claude plugin install ai-collab@ai-collab` | |
   | Codex | `codex plugin marketplace add https://github.com/bcmyguest/ai-collab`, `codex plugin add ai-collab@ai-collab` | restart Codex and trust the hooks in `/hooks` |
   | Cursor | the [Cursor installer](install.md#cursor) with `--copy` | restart running Cursor sessions |
   | OpenCode | the [OpenCode installer](install.md#opencode) | restart OpenCode |

4. **Installs the UI** as the systemd user service `ai-collab-ui` on `http://127.0.0.1:8795`. It builds `web/` first when no build exists. An existing `~/.config/systemd/user/ai-collab-ui.service` is kept. Without systemd, setup tells you to run `npm run ui`.
5. **Prints the phone steps.** Setup changes nothing on your network.

Reruns skip finished steps: an existing `defaults.json` with `url` and `tokenFile` skips the bus step.

| Flag | Effect |
|---|---|
| `--agent a,b` | Install only these agents: `claude`, `codex`, `cursor`, `opencode` (default: every one on `PATH`) |
| `--port N` | Publish the bus on `127.0.0.1:N` instead of 8794 |
| `--no-ui` | Skip the UI service |

## Your own ntfy server

The bus speaks the ntfy wire subset, so an operator-run ntfy server still carries messages. [Threads](threads.md) need the bus: ntfy has no `/threads` routes, so the UI shows no thread list. Write
`~/.config/ai-collab/defaults.json` by hand before you run setup; setup then uses that server and skips
the bus install:

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
