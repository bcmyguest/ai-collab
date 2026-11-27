# AI Collab

[![npm](https://img.shields.io/npm/v/ai-collab)](https://www.npmjs.com/package/ai-collab)

Chat with your coding agents from your phone and watch what they do, live. AI Collab connects Claude Code, Codex, Cursor, and OpenCode 2 sessions to a phone UI over a **private, local message bus**. Agents post progress and questions; you answer, approve permission prompts, start new sessions, and see every tool call as it happens. Nothing leaves the machine except your Tailscale traffic.

![AI Collab demo](docs/demo.gif)

**Docs:** <https://bcmyguest.github.io/ai-collab/>

## Quick start

Requirements: Node 24+, Docker for the local Postgres, and at least one harness on `PATH` (`claude`, `codex`, `cursor-agent`, or `opencode`).

```sh
npx ai-collab postgres up
npx ai-collab setup
```

Pick the agents with `--agent`, for example `npx ai-collab setup --agent claude,cursor,opencode`. Setup copies itself to `~/.local/share/ai-collab/app`, so plugins and the UI keep working after npm clears its cache. From a clone, run `npm ci && node scripts/ai-collab.mjs setup` instead.

Setup does five things:

1. Installs the `ai-collab-bus` systemd user service: a small Postgres-backed message bus on `127.0.0.1:8794`, deny-all without its token, and writes the token to `~/.config/ai-collab/bus-token`. Start Postgres first with `ai-collab postgres up` (Docker); setup reminds you when it is not running.
2. Writes `~/.config/ai-collab/defaults.json`, so every git repo auto-joins under its folder name. An empty `.ai-collab-off` file keeps a repo out.
3. Installs the plugin for each harness on `PATH`, or each one named with `--agent`.
4. Installs the `ai-collab-ui` systemd user service on `127.0.0.1:8795`.
5. Prints the Tailscale steps for your phone. It changes nothing on your network.

| Flag | Effect |
|---|---|
| `--agent a,b` | Install only these agents: `claude`, `codex`, `cursor`, `opencode` (default: every one on `PATH`) |
| `--port N` | Publish the bus on `127.0.0.1:N` instead of 8794 |
| `--no-ui` | Skip the UI service |

Reruns skip finished steps. The bus keeps the ntfy wire subset, so an operator-run ntfy server still carries messages (not [threads](docs/threads.md)): write `~/.config/ai-collab/defaults.json` by hand (`{"url", "tokenFile", "peers"}`) before you run setup; setup then skips the bus install. ntfy is no longer part of the default install ([ntfy removal](docs/ntfy-removal.md)).

## How it fits together

| Piece | What it is |
|---|---|
| Bus | `ai-collab-bus` (`scripts/ai-collab-bus.mjs`, `lib/bus.ts`): an HTTP server on `127.0.0.1:8794` behind one Bearer token, events and threads in Postgres schema `bus` (`lib/bus-postgres.ts`), 7-day retention |
| Postgres | A loopback Docker container (`ai-collab postgres up`, `deploy/postgres/compose.yaml`) for the bus store and the DBOS workflow engine |
| Hooks and MCP | `scripts/ai-collab-hook.mjs` and `scripts/ai-collab-mcp.mjs` publish, poll and stream topics over the bus's HTTP API (`lib/messaging.ts`) |
| Runner | `ai-collab-runner` (`runner/main.mjs`): owns started sessions and delivers direct messages to idle ones, one durable workflow per message; workflows run on `runner.db` (SQLite, the default) or DBOS on Postgres (`"workflowEngine": "dbos"`) |
| UI | `ai-collab-ui`: Next.js in `web/` with its server in `web/server/`, on `127.0.0.1:8795`, reached from the phone over Tailscale |

Diagrams: [Architecture diagrams](docs/architecture-diagrams.md).

Then open the UI on your phone: [Quick start](https://bcmyguest.github.io/ai-collab/quick-start/#phone-access).

## Documentation

| | |
|---|---|
| [Install](https://bcmyguest.github.io/ai-collab/install/) | Per-harness install by hand |
| [Configuration](https://bcmyguest.github.io/ai-collab/configuration/) | `defaults.json`, `projects.json`, environment variables |
| [Phone UI](https://bcmyguest.github.io/ai-collab/phone-ui/) | Home, chat, task tags, activity, starting sessions, push |
| [AFK mode](https://bcmyguest.github.io/ai-collab/afk/) | Progress posts and phone questions while you are away |
| [Approvals and questions](https://bcmyguest.github.io/ai-collab/approvals/) | Permission prompts answered from the phone |
| [Landing from the phone](docs/phone-ui.md#landing-from-the-phone) | `ai-collab land finish` opens a draft PR with proof, or a review packet without GitHub; the Land panel merges green PRs; `ai-collab deploy` updates the host; `deploy --from <branch>` serves a branch on the phone before landing |
| [Landing policy](docs/teams.md#landing-policy) | A team's `landing` attribute picks PR, packet or branch; agents never push `main` |
| [Builders](docs/builders.md) | One agent per task in OpenShell, with `oncebitten` checks when installed on the host |
| [Teams and patterns](docs/teams.md) | Define roles and handoffs in DOT and verify their transitions with local traces |
| [Agents starting agents](docs/messaging.md#agents-starting-agents) | `spawn_agent` (or `ai-collab spawn`) starts a child of any harness that reports to its parent after each run |
| [Code mode](docs/code-mode.md) | Native code mode and `run_code` for AI Collab reads, required for new sessions launched by tags |
| [Architecture diagrams](docs/architecture-diagrams.md) | What is off-the-shelf, what is home-grown, and where the network boundaries are |
| [Security model](https://bcmyguest.github.io/ai-collab/security/) | What is sent and what is trusted |
| [Troubleshooting](https://bcmyguest.github.io/ai-collab/troubleshooting/) | Known limits and fixes |
| [Development](https://bcmyguest.github.io/ai-collab/development/) | Tests, CI, releases, the demo, `npm run land` for maintainers |
| [AG-UI design](docs/ag-ui.md) | Event protocol and migration |

The docs source is [`docs/`](docs/); [`site/`](site/) builds it.

The phone UI uses React and Next.js. New UI SDK components use TypeScript, starting with the outcome request form. The project includes the `ui-sdk` skill and package-version docs under `node_modules/@ui-sdk/react/docs/`.

## License

[Apache License 2.0](LICENSE).
