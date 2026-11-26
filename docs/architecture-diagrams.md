# Architecture diagrams

Three pictures: the whole system with its network boundaries, how a message travels between the phone and an agent, and what runs inside the runner. Colour says where a piece comes from.

| Colour | Meaning |
|---|---|
| Green | Off-the-shelf software, maintained elsewhere (robust) |
| Blue | Our code sitting on an off-the-shelf engine or framework |
| Amber | Home-grown, we own every line |

Boxes are network boundaries: the phone is off-host, everything on the host binds loopback only, the bus is a systemd user service, team runs and builders live in OpenShell sandboxes.

## System overview

```mermaid
flowchart LR
  classDef shelf fill:#e2efda,stroke:#54784b,color:#20361c
  classDef hybrid fill:#dde9f5,stroke:#3d6a99,color:#1c3a57
  classDef own fill:#fce8d5,stroke:#b06f24,color:#5c3a10

  subgraph PHONE["Phone (off-host, Tailscale tailnet)"]
    browser["Browser UI<br/>tailscale serve, https :443"]
    push["Web Push<br/>vendor push service"]
  end

  subgraph HOST["Host (loopback only)"]
    ui["UI server<br/>Next.js, 127.0.0.1:8795"]
    runner["Runner<br/>runner/main.mjs, systemd"]
    db[("Durable log<br/>SQLite WAL, runner.db")]
    state[("Task board, teams,<br/>run records, JSON")]
    hook["Session hooks<br/>ai-collab-hook.mjs"]
    mcp["MCP servers<br/>ai-collab, run_code"]
    harness["Harness CLIs<br/>claude, codex, cursor, opencode"]
  end

  subgraph DOCKER["Docker"]
    bus["ai-collab-bus<br/>127.0.0.1:8794, token-only"]
  end

  subgraph SHELL["OpenShell sandboxes"]
    team["Team runs and builders<br/>one sandbox per run"]
  end

  providers["Model provider APIs<br/>outbound HTTPS"]

  browser -- "chat, approvals, starts" --> ui
  ui -- "poll and stream topics" --> bus
  ui -- "control socket (unix)" --> runner
  ui -- "encrypted push" --> push
  runner -- "checkpoints workflows" --> db
  runner -- "reads board and teams" --> state
  runner -- "spawns and parses" --> harness
  runner -- "sandbox exec" --> team
  hook -- "activity out, inbox in" --> bus
  mcp -- "batched reads and sends" --> bus
  team -- "publishes with token" --> bus
  harness -- "model calls" --> providers
  team -- "model calls" --> providers

  class browser shelf
  class push shelf
  class ntfy shelf
  class harness shelf
  class providers shelf
  class ui hybrid
  class db hybrid
  class runner own
  class state own
  class hook own
  class mcp own
  class team own
```

Read it from the phone: the only door onto the host is Tailscale to the UI server. the bus binds loopback only; the token in `~/.config/ai-collab/bus-token` is the trust boundary. The runner is the only thing that spawns agents, and it records every step in SQLite before and after. Sandboxes reach the bus through `host.openshell.internal` routing only.

## Message path: phone to agent and back

```mermaid
sequenceDiagram
  participant O as Operator (phone)
  participant U as UI server (Next.js)
  participant N as bus (loopback)
  participant H as Session hook
  participant A as Agent session

  O->>U: POST /api/send (chat, approval, answer)
  U->>N: publish to topic (token, loopback)
  H->>N: poll inbox since cursor
  H->>A: inject as one JSON-quoted untrusted line
  A->>H: MCP call (send_to_all, reply, task update)
  H->>N: publish reply and activity
  U->>N: poll broadcast topic
  U->>O: render, push when AFK
```

Nothing pushes into an agent: the hook polls the bus with a cursor and injects at a safe point. A reply is just a message on a shared topic, so the waiting tool trusts the token, not the sender name. Permission approvals ride the same path.

## Runner internals

```mermaid
flowchart TD
  classDef shelf fill:#e2efda,stroke:#54784b,color:#20361c
  classDef hybrid fill:#dde9f5,stroke:#3d6a99,color:#1c3a57
  classDef own fill:#fce8d5,stroke:#b06f24,color:#5c3a10

  callers["UI server and CLI"]
  ctl["Control socket<br/>unix, /v1/sessions"]
  reg["Session registry<br/>runner/runner.mjs"]
  ad["Harness adapters<br/>claude, codex, cursor, opencode"]
  proc["Harness processes<br/>in the runner cgroup"]
  shell["OpenShell sandboxes<br/>team runs, builders"]
  dur["Durable core<br/>workflows, steps, messages, schedules"]
  pat["Pattern compiler<br/>team.dot to graph"]
  runs["Pattern run records<br/>pattern-runs/*.json"]
  db[("SQLite runner.db<br/>append-only, WAL")]

  callers -- "start, stop, advance" --> ctl
  ctl --> reg
  reg -- "normalize output" --> ad
  ad -- "spawn, parse" --> proc
  reg -- "exec in sandbox" --> shell
  reg -- "checkpoint every step" --> dur
  pat -- "snapshot at start" --> runs
  reg -- "advance handoffs" --> runs
  dur -- "commit" --> db

  class proc shelf
  class shell shelf
  class db hybrid
  class dur hybrid
  class callers own
  class ctl own
  class reg own
  class ad own
  class pat own
  class runs own
```

The durable core is the interesting amber-blue boundary: a home-grown, DBOS-shaped engine (workflows, checkpointed steps, deduplicated messages) on the off-the-shelf SQLite engine. A crash replays pending workflows from the log, so a restart never double-launches an agent. The prose version, including the guarantees table, is in [architecture.md](architecture.md).

## What is robust, what is ours

| Piece | Origin | Notes |
|---|---|---|
| Message bus | Home-grown (`lib/bus.mjs`), ntfy wire-compatible | Loopback bind, token-only; SQLite with 7-day retention |
| SQLite | Off-the-shelf engine (`node:sqlite`, WAL) | Schema and recovery logic are ours |
| Next.js, React, ui-sdk | Off-the-shelf framework | Pages, server routes, and phone behaviour are ours |
| Tailscale, systemd, Docker, OpenShell | Off-the-shelf plumbing | Tailscale is the only inbound path; systemd owns process lifetimes |
| Harness CLIs | Third-party (claude, codex, cursor-agent, opencode) | Adapters normalize their output; we never patch them |
| Model provider APIs | Third-party | The only outbound traffic |
| Durable core (`lib/durable.mjs`) | Home-grown | DBOS-shaped: workflows, checkpointed steps, exactly-once messages |
| Runner (`runner/`) | Home-grown | Owns sessions, sandboxes, control socket, schedules, pattern runs |
| Session hooks and MCP servers | Home-grown | The seam between harnesses and the bus; injects inbound text as untrusted data |
| Pattern compiler (`lib/catalog/dot.ts`, `lib/pattern-compiler.ts`) | Home-grown | DOT graph in, validated transitions out; verifiable with traces, no model calls |
| Task board, team files, run records | Home-grown | Plain JSON under the state dir, lock-then-rename writes |
