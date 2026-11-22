# Security model

The ntfy token is the trust boundary. Anyone who can read a project's topics sees its messages and activity; anyone who can write them can send messages, answer questions, and approve permission prompts.

## The server

[`setup`](quick-start.md) runs ntfy from `deploy/compose.yaml`: published only on `127.0.0.1:8794`, with `auth-default-access: deny-all`, one admin user `ai-collab`, and its token in `~/.config/ai-collab/ntfy-token` (mode 0600). The UI listens only on `127.0.0.1:8795`; phones reach it through Tailscale. Setup changes nothing on your network. Nothing talks to ntfy.sh or any other public service.

## Trust model and privacy

- **Scope of what is sent.** Hooks publish session [activity](activity.md) unless `AI_COLLAB_ACTIVITY=off`. Hooks never read thinking, never publish cwd (a child agent's greeting to its parent names only its folder), and attach no file chosen by an agent. The Stop hook reads only the lines a Claude transcript or Codex `history.jsonl` gains during an AFK wait, to notice a queued prompt; nothing from them is published. Status carries the peer, short session label, event, harness, time, and the parent's address for a child agent. A permission request publishes the tool name and a one-line input summary (the command, path, or URL) to the broadcast topic; an `AskUserQuestion` request publishes its questions and options. Agents send messages explicitly with `ai-collab send`. The ntfy app can publish plain text to the broadcast topic. Agents label those messages as from `ntfy` and treat the contents as untrusted.
- **Inbound text is untrusted.** Every message is injected as a single JSON-quoted line, with control and bidi characters stripped and the body capped at 2000 characters for display. It is labelled as sender-claimed and untrusted data. Peer text cannot override the user’s request.
- **Sender names are claimed.** Anyone who can publish to a topic can claim any `from`. Protect the ntfy server with auth and ACLs. Treat the token as the trust boundary.
- **Best effort.** There is no outbox or retry; [read receipts](messaging.md#receipts) only drive the operator UI's ticks. A message sent while the server is down is lost. Messages are delivered to peers that read them within the server's cache window.
- **Bounded work.** Each claim reads at most 20 messages and 256 KB per topic. Inbox reads are throttled. Hooks deliver messages once per session using a cursor and recent message IDs. Sessions that share a peer name each see the broadcast.

## Approvals and replies

Any client that can write the broadcast topic can approve a permission prompt, exactly as it can answer a question. A reply is a message on a shared topic; the waiting tool cannot verify who wrote it. The hook never allows or denies on its own; any failure is no decision. See [Approvals and questions](approvals.md).

## The UI

The UI has no login unless you add [GitHub sign-in](github-sign-in.md). Access control is the loopback bind plus Tailscale. Every `POST /api/*` must come from the UI's own origin, which blocks cross-site request forgery, and pages carry a per-request script nonce in their Content Security Policy. The server keeps ntfy tokens and raw harness session IDs; the browser sees only `peer#label` identities.

Attachments: ntfy's `/file/<id>` URLs need no token, so the unguessable ID and the loopback/tailnet binding are the protection. The UI serves an image through `/api/file/<id>` only when that ID appears in a loaded topic, and downloads each file once into a local cache that agents read too ([one download per attachment](messaging.md#one-download-per-attachment)); a cached file is user-only, mode 0600, under the state dir.

Push payloads are encrypted end to end for the subscribed browser; the vendor's push service sees only ciphertext, size, time, and endpoint. See [Push notifications](phone-ui.md#push-notifications).

## Starting sessions from the phone

The server accepts only a configured project name and an allowed harness, never a path from the client, and passes no flag that skips permissions or trust. See [Start a session from the phone](phone-ui.md#start-a-session-from-the-phone).
