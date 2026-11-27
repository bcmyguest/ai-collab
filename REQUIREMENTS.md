# AI Collab messaging requirements

Historical: written when ntfy was the transport; the local Postgres-backed bus replaced it (see [ntfy removal](docs/ntfy-removal.md)). Read "ntfy" in the quote and work split below as the bus.

Build and deploy a mobile-friendly operator chat in `~/ai-collab` so a human can talk to specific Claude Code, Codex, and Cursor sessions through the local message bus, including when the session needs to be woken.

## User request

> 1. i should be able to enter into any existing channels 2. i should be able to message agents 3. if an agent is not online, it should be woken up 4. agent high (>200k) token usage should be sent to ntfy 5. i should be able to send compact messages 6. i should be able to tag agent 7 you shouldn't hand-roll the ui, just use an off the shelf one with a few custom components and make it look nice 8 put the ui in ai-collab 9. i should have the ability to click and talk directly to one agent, and the agent should know (by being told by the tool) to respond to me in the messaging) 10 it should be mobile friendly. split the work howevery you want but luna generally should be used for easy stuff.

Earlier requirements still apply. Install the plugin in Claude Code, Codex, and Cursor. Give each running session an automatic identity, including multiple sessions of the same harness. Let agents receive phone messages and ask a human a question over MCP, then wait for a reply. Keep those question replies on the project's shared broadcast topic. Publish the source in the existing private GitHub repository and serve the UI through the approved `ai-collab-ui` Tailscale service.

## Acceptance checks

| Requirement | Check |
| --- | --- |
| 1. Join existing channels | Channels are the projects in `~/.config/ai-collab/projects.json`. The project sidebar lists every project, each served with its own configuration, and opening one shows its history and new posts. Inside a project, zoom by sender: Project (all agents and the operator), Harness (one of claude, codex, cursor), and Session (one `peer#session` thread). Custom topics opened by name are no longer supported. |
| 2. Message agents | Send a channel message from the UI. The expected agent receives it under the operator's identity. A text post from the phone still reaches the agents. |
| 3. Wake an offline agent | Send a direct message to a known offline session. Keep the message queued, resume that exact session through its harness adapter, and show whether wake succeeded, failed, or is unsupported. Exercise retry without starting duplicate sessions. |
| 4. Alert above 200k current context tokens | Use a harness-reported measurement of the session's current context. Verify that 200,000 does not trigger and crossing to 200,001 posts an alert on the bus with the session identity and measured context tokens. Repeated samples above the threshold should produce one alert per crossing. Verify a drop to 200,000 or fewer re-arms the alert. |
| 5. Request remote compaction | Provide an explicit Compact action in direct chat. Verify it requests compaction of the selected session and shows the outcome reported by its harness. Inspect the existing smarter-compact integration for the supported compaction path in each harness. |
| 6. Tag an agent | Use an autocomplete picker to insert and send an `@` tag that resolves to the selected session even when two agents share a harness. Verify the tagged agent can see the mention in its inbox. Each mention option and session picker entry shows when that session (or harness) last sent a message, such as `3m ago` or `never`, derived from history the server already holds. |
| 7. Use a chat UI kit | Use an off-the-shelf chat component kit (shadcn/ui with Tailwind CSS and the prompt-kit chat components) for the project list, message history, and composer. Build small custom controls for agent status, session selection, and ai-collab actions. Replace the hand-built prototype. |
| 8. Keep it in ai-collab | UI source, build, and deployment instructions live in `~/ai-collab`. The private GitHub repo and Tailscale service serve the tested version. |
| 9. Direct chat and replies | Click the second of two Cursor sessions and send a message. Only that session receives it. The hook or MCP tool gives the agent a concrete reply action. Its reply appears in the same conversation, including after a page reload. |
| 10. Mobile layout | At a 390 px viewport, switch projects from the drawer, change the zoom level, open a direct chat, tag a session, and send a message with no horizontal overflow. Verify sign-in and posting from a tailnet client against the HTTPS service. |
| 11. Operator AFK mode | A header switch sets `on`, `off`, or `quiet`. Each change publishes `{v:1, kind:"mode", from:"operator", mode, ts}` to the broadcast topic of every project. The latest mode envelope in history is shown and pushed to open browsers (none means `off`); mode envelopes never appear as chat messages. |

Retest phone question and reply with MCP `ask_question` and `wait_for_answer`. The existing phone syntax is `reply <id> <answer>`. For wake and compaction, only explicit authenticated operator actions may invoke host-side controls. Keep the bus token and raw harness session IDs server-side.

## Work split

| Owner | First task |
| --- | --- |
| Luna | Check the deployed ntfy API for topic discovery and subscription listing. Add a focused channel navigation acceptance check against the chosen contract. |
| Luna | Inventory available usage fields in the three harnesses and the existing `~/smarter-compact` hooks. Return file or documentation anchors and small redacted sample shapes. |
| UI implementer | Replace the prototype with an off-the-shelf kit and wire channel navigation, mentions, direct threads, and mobile layout. Coordinate request and response shapes with the messaging implementer. |
| Messaging implementer | Own the session identity, direct reply routing, and wake adapters. Check which harnesses can resume the exact session, including Cursor. Keep pending messages recoverable if the adapter fails. |
| Integrator | Review the combined diff, run the checks, update the private GitHub repo, reinstall the three plugins, and verify the Tailscale deployment. |

Start by reviewing `git status --short` in the live checkout and comparing the staged and live `web/server.mjs`. Keep the ntfy deployment and phone channel working. Stop after exercising the acceptance checks or identifying a specific blocked harness or deployment path. Report the commit, the test results, the Tailscale URL, and any cases that still lack end-to-end evidence.

## Later (not started)

- Sign in to the UI with GitHub instead of relying on tailnet access alone.
- Approve agent permission prompts from the phone through a hook (built on a branch: README "Phone approvals"; also answers Claude AskUserQuestion).
- Start new agent sessions from the phone (built on a branch: README "Start a session from the phone").
- Agents that start other agents themselves (any harness, via their shell) join ai-collab and can message each other: the child learns its parent's address and the parent its child's. No launcher tool or limits for agents; phone approvals cover the start in AFK (built on a branch: README "Agents starting agents").
- Browser notifications (Web Push, works with the tab closed; Chrome and Firefox on Android) for actions the operator must take: permission approvals and agent questions (built on a branch: README "Push notifications").
- Heartbeat over the bus for agents on other machines.

## Decided against

- Native phone apps: the web UI stays the only client.
- Full terminal mirroring: the UI shows hook events, not terminal output (tentative).
