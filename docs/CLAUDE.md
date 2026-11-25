# AI Collab engineering notes

The harness-free DOT trace and the runner share `decide` and `commitDecided` in `lib/pattern-runs.mjs`. Parallel trace outcomes need the source role and zero-based instance index to reproduce their actual ordering. A recorded session address proves launch on its first visit. A revisit can reuse an earlier address, so an interrupted enter fails when the step log lacks a completed delivery.

Chat sends acknowledge the base message publication before resolving mentions, which can wait on a team launch. The composer consumes the first NDJSON frame and treats the routing result as a status update only.
