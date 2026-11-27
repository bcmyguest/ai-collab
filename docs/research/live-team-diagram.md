# Live team diagram

Read from `origin/main` at `270f2758`. No UI was built and no live run was watched. The operator wants one picture of a run in progress: who holds each role, which handoff just fired, and the path the work took.

## Recommendation

Keep `RoleGraph` and draw the run on it. The Patterns run view already has the full run and already mounts that graph. Add a state overlay (session on the node, the latest handoff emphasized, fired edges marked in log order) and watch the run directory so a run-file write pushes the snapshot the page already renders. Do not add a second diagram.

## What the page already has

`runStatus` returns the run file (`lib/pattern-runs.ts`). The UI snapshot sends the newest 20 of those objects as `data.runs` (`web/server/ui.mjs`). `RunView` in `web/app/patterns-page.jsx` reads that object. It already passes `active` and `used={run}` into `RoleGraph`.

The run object holds:

- `definition.roles` and `definition.handoffs`, the snapshot taken at start.
- `active`, the role of the first live instance (`setActive`).
- `live`, every live instance as `{role, index}`.
- `sessions[role]`, the address of instance 0, and `instances[role][index]` for the rest (`addressOf`, `withInstances`).
- `handoffs`, an append-only log. Each record has `seq`, `at`, `from`, `to`, `on`, `note`, and `instance`.

`RoleGraph` (`web/app/pattern-graph.jsx`) lays out `toGraph(definition)` (`web/lib/pattern-graph.js`). A running `active` role is filled. `used` turns into per-edge counts (`firedCounts` in `web/lib/pattern-view.js`): an uncapped edge that has fired shows `×N`, a capped edge shows `used/cap`. The same view lists each role with the instance-0 address and online flag, and lists handoffs in order under the graph. The team editor imports the same `RoleGraph` and passes only the definition, so a run overlay must stay optional.

## What is missing for a live update

The graph does not show the three facts. The node title is the role id plus harness and skill, not the session. One `active` id is highlighted, so other entries in `live` look idle. Edge labels are cumulative counts, so the latest handoff is not distinct and the order of the path is not on the picture. A role with `count` greater than 1 shows `×N`; only instance 0's address is read from `sessions`.

The snapshot is also not tied to the run file. `addProject` watches the session registry and the task store, then broadcasts. Nothing watches `<stateDir>/runner/pattern-runs/<project>`. The Patterns stream is the project stream with no `view` (`streamOf` in `web/app/chat.jsx`), so the 25s keepalive refreshes it only when that client already has queued messages, running jobs, open tasks, or a review. A hub event (activity, inbox, status) does broadcast and will refresh `data.runs`. A run-file write with no hub event leaves the open run view on the previous snapshot.

## Two ways to render it

1. **Leave `RoleGraph` as it is.** The run view already highlights the active role and shows fired counts. Sessions and the ordered log stay in the lists underneath. This needs no SVG change. It does not put the holder, the latest handoff, or the path on the diagram.

2. **Overlay run state on the same SVG.** `layoutGraph` stays. Optional props, ignored by the editor and the pattern inspect view: addresses from `instances` with `sessions` as the instance-0 fallback, every role in `live` marked and `active` named, the last `handoffs` record's edge emphasized, and edges that appear in the log drawn as taken. The ordered list stays for notes, times, and repeat firings. A cycle cannot become a polyline; the latest edge plus the existing log is the path.

## Smallest change

Do (2), plus one watch.

- In `web/server/ui.mjs`, watch the pattern-runs directory the same way the registry is watched, and call the existing `broadcast`. No new endpoint. `RunView` already re-renders when `data.runs` changes.
- In `RoleGraph`, add the overlay above. Pass the run the page already holds. Do not add a graph library or a second component.

Out of scope: a trail that replays every `seq` as its own geometry, and showing team and role on session cards. Those cards still do not read `run.sessions`.
