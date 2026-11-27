# Verification

Four fast-check models run random command sequences against the real code and compare it with an abstract model after every command. Two TLA+ specs check the store lock and message delivery exhaustively over small constants with TLC. Each model command names the spec actions it mirrors.

| Check | Code under test | Invariants |
|---|---|---|
| `test/pattern-run.model.test.mjs` | `lib/pattern-runs.mjs`, `lib/pattern-workflow.mjs` on the durable engine | At most one live token per instance; every handoff applied once, logged with seq 1..n; visits, arrivals and suspensions match the model; at most one launch per instance; a run ends in a terminal state and its workflow ends with it; a restart resumes and never forks |
| `test/bus-cursor.model.test.mjs` | `lib/bus.mjs`, `lib/bus-postgres.mjs` (memory, SQLite, Postgres) | Poll and stream read the slice the cursor names; an unknown cursor replays all and flags `reset` on poll and stream alike; stream ids strictly increase; attachments follow retention |
| `test/store-lock.model.test.mjs` | `lib/store.ts` lock, with real holder processes | Lock presence, owner and holders match the model; no overlap the model does not allow; no stray break or tomb entries |
| `test/delivery-model.model.test.mjs` | `runner/delivery.mjs` on a fake clock | No push after an ack or past the TTL; no redelivery while busy; at most `MAX_ATTEMPTS` pushes; every push allowed by `nextAction`; an ended message stays ended |
| `spec/tla/StoreLock.tla` | `lib/store.ts` takeLock, reclaimStale, releaseLock | `MutualExclusion` and `HolderOwnsLock` until a ceiling break; `DeadOwnerIsStale`: a crashed or reused-pid owner's lock is stale at once |
| `spec/tla/Delivery.tla` | `runner/delivery.mjs` with `lib/delivery.ts` | `NoCopyAfterAnswer`, `NoRedeliveryWhileBusy`, `AttemptCap`, `CopiesCounted`, `Terminal`, `TerminalStable` |

## Run

The models run in `npm test`. To run one longer or replay a failure:

```sh
FC_RUNS=5000 node --test test/pattern-run.model.test.mjs
FC_SEED=<seed> FC_PATH=<path> FC_REPLAY=<replayPath> node --test test/pattern-run.model.test.mjs
```

`FC_RUNS` and `FC_SEED` work for every model. `FC_PATH` and `FC_REPLAY` are in the pattern model only. `BUS_IMPL`, `STORE_IMPL` and `DELIVERY_IMPL` point a model at a scratch copy of the code, for checking that it catches a planted bug.

`npm run tlc` runs TLC on every `spec/tla/*.cfg`. It skips and exits 0 without Java or `tla2tools.jar`. It finds Java through `TLC_JAVA`, then `$JAVA_HOME/bin/java`, then `java` on `PATH`. It finds the jar through `TLA2TOOLS_JAR`, then `~/.cache/tlaplus/tla2tools.jar`; download the jar from the [tlaplus releases](https://github.com/tlaplus/tlaplus/releases). `npm run tlc -- Delivery` runs one spec.

TLC 2.19 results (32 workers, 7 s for both):

| Spec | Constants | States | Distinct | Depth |
|---|---|---|---|---|
| Delivery | 3 attempts, 2 crashes | 2,286 | 798 | 22 |
| StoreLock | 3 processes, 1 respawn per pid, 1 acquisition each | 7,990,054 | 1,489,766 | 65 |

Each spec has a constant that switches its fix off: `OwnerWriteExclusive = FALSE` in StoreLock and `ResumeChecks = FALSE` in Delivery. TLC then finds the counterexample below.

## Bugs found

**Duplicate live token in a pattern run** (pattern model, fixed in `lib/pattern-runs.mjs` `commitDecided`). A handoff into an instance that already held a live token pushed a second one, so an operator override advanced the instance twice. Shrunk counterexample: `Advance(operator, split)`, `Advance(worker#1, help)`, `Advance(operator, help)` leaves `lead#0` holding two tokens. Regression: `test/pattern-runs-live-token.test.mjs`.

**owner.json overwrite** (StoreLock, fixed in `lib/store.ts` `takeLock`). Trace: p1 makes the lock dir and stalls past `staleMs` before writing `owner.json`; p2 breaks the ownerless dir; p3 makes a new dir and writes its owner; p1's `writeJson` overwrites p3's owner and both enter. A suspend or SIGSTOP between mkdir and the write is enough. `takeLock` now writes a temp file into the dir and links it to `owner.json`: the write fails on a broken dir and the link fails on an existing owner, so the stalled process retries. Regression: `test/store-lock-owner-race.test.mjs`.

**Push after a restart skipped its checks** (Delivery, fixed in `runner/delivery.mjs`). Trace: the first copy lands and the target works on it; it goes idle; the redelivery attempt records its reserve step and the runner dies; the runner restarts and the target turns busy (or answers); replay skips `target()` and the answer re-check, and the push goes out. A push step that runs live in a resumed attempt now checks `nextAction` on live facts first: an answer, TTL or cap ends the message, and a busy target fails the attempt so it retries after backoff. The delivery model's `RestartRunner` cannot reach this split, because it restarts only between commands, while workflows wait. Regression: `test/runner-delivery-resume.test.mjs`.

Earlier fixes these checks cover: `caa522cd` (a redelivery re-checks the answer before reserving) and `614d0db7` (break a stale lock only when its owner is gone).

## Accepted behaviour

- A holder stuck for 10 x `staleMs` loses its lock at the ceiling. Its later release renames the next holder's lock away for a moment, so a third process can enter. StoreLock checks mutual exclusion only until a ceiling break.
- A brief to a pattern member whose session ended is recorded as handed off and delivered nowhere. The reply says so (`recorded; message to X failed`), and the run waits for an operator override. A runner crash loses that reply.
- An unknown cursor on poll and stream now behaves the same: both replay from the oldest retained event and flag `reset` (`42bb840f`, on SQLite and Postgres). The bus-cursor model asserts the flag and runs restart and prune on Postgres too.

## Gaps

- The pattern model leaves out the entry step's cut, and its graph cannot stall a fan-in.
- Delivery.tla models one message and one target; `ready` folds into the target's idle state.
- StoreLock.tla assumes no crash inside the breaker mutex, as `clearOldBreaker` does.
