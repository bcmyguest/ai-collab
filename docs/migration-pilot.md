# Migration pilot proof

Status: passed (2026-11-28). The three proofs the DBOS migration spike asked for: a crash test,
an engine rollback check, and a `pg_dump`/`pg_restore` round trip of the bus and dbos schemas.
Every command and output below is real, captured 2026-11-28 between 02:21Z and 02:32Z.

Per the operator's instruction (01:31Z) the live `ai-collab-runner` was never stopped, killed or
restarted for these proofs. Everything destructive ran against an isolated runner started by hand
with its own runtime, state and config dirs under `/tmp/opencode/pilot` and a scratch database
`ai_collab_pilot` (dropped after the run). The runner code was the deployed tree
(`/home/b/.local/state/ai-collab/current`, same code as the live unit), Node 26.13.0,
`@dbos-inc/dbos-sdk` 5.7.0.

One earlier attempt briefly put the `pilot-crash` schedule on the live runner (before that
instruction). The operator removed it at 20:32:32 EST; the live database keeps one harmless
`pilot-crash@2026-11-28T01:32:00.000Z` SUCCESS row and its skipped-tick mirror row as history.

## Setup: the isolated runner

`/tmp/opencode/pilot/config/ai-collab/defaults.json` (plus a copy of `pg-password`):

```json
{
  "workflowEngine": "dbos",
  "autoDeploy": false
}
```

`/tmp/opencode/pilot/config/ai-collab/schedules.json`, one tick per minute; each tick appends its
tick id (name + aligned minute, the same id the engine records) to `crash.log`, sleeps 40 s, then
appends the id again:

```json
[
  {
    "name": "pilot-crash",
    "everyMinutes": 1,
    "cwd": "/home/b/ai-collab-wt-postmig",
    "command": ["/bin/sh", "-c", "id=\"pilot-crash@$(date -u +%Y-%m-%dT%H:%M:00.000Z)\"; echo \"$id start\" >> /tmp/opencode/pilot/crash.log; sleep 40; echo \"$id end\" >> /tmp/opencode/pilot/crash.log"],
    "timeoutSec": 50
  }
]
```

Scratch database, and the runner itself (stderr in `runner*.err`, stdout in `runner*.out`):

```console
$ docker exec ai-collab-postgres-postgres-1 createdb -U ai_collab ai_collab_pilot
$ cd /home/b/.local/state/ai-collab/current
$ setsid env XDG_RUNTIME_DIR=/tmp/opencode/pilot/run XDG_STATE_HOME=/tmp/opencode/pilot/state \
    XDG_CONFIG_HOME=/tmp/opencode/pilot/config AI_COLLAB_PG_DATABASE=ai_collab_pilot \
    AI_COLLAB_RUNNER_HARNESSES=none node runner/main.mjs > runner.out 2> runner.err &
$ grep -E "Initializing|launched|listening" runner.out runner.err
runner.out:Initializing DBOS (v5.7.0)
runner.out:DBOS launched!
runner.err:ai-collab-runner: listening on /tmp/opencode/pilot/run/ai-collab/runner.sock; adapters none; recovered 0 session(s); schedules pilot-crash
```

The isolated runner uses its own socket, lock and state dir, so it cannot disturb the live one.

## 1. Crash test: kill mid-run, restart, ticks resume

The tick `pilot-crash@2026-11-28T02:23:00.000Z` was mid-run (its command sleeping) when the runner
process was killed with `kill -9`. The command survived: the isolated runner is not a systemd unit,
so `scopeSupport` declines scoping ("not started by systemd, so no cgroup to leave") and the command
ran as a direct child that `kill -9` orphaned rather than killed. On the live systemd unit the same
survival comes from the tick's own transient scope. The checkpoint, not the process tree, is what
matters: the step's start marker was recorded, its result was not.

```console
$ kill -9 $(cat runner.pid)        # 02:23:41.077Z, tick 02:23 mid-sleep
runner 1143651 killed at 2026-11-28T02:23:41.077Z
$ pgrep -fa "sleep 40"
1143799 /bin/sh -c id="pilot-crash@$(date -u +%Y-%m-%dT%H:%M:00.000Z)"; echo "$id start" >> ...
$ # same minute, restart the isolated runner (runner2)
restarted pid 1146557 at 2026-11-28T02:23:56.122Z
$ grep -E "Initializing DBOS|Recovering|DBOS launched|pilot-crash" runner2.out runner2.err
runner2.out:Initializing DBOS (v5.7.0)
runner2.out:Recovering 1 workflows for executor local from application version ai-collab-1
runner2.out:DBOS launched!
runner2.err:ai-collab-runner: pilot-crash: failed in 0 ms
```

`pilot-crash: failed in 0 ms` is the cut step answered by `onCut`
(`runner/schedules.ts`: "runner restarted during the run; not re-run"): the recovered run completed
without re-executing the command, so the command ran exactly once. The orphaned command finished on
its own and wrote its `end` line late, which is why `02:23 end` sits after `02:24 start` in the log.
(The first tick's command also started ~25 s after its minute: the fresh scratch DB made `DBOS.launch`
run migrations before the first workflow.)

The resulting `crash.log`, and the engine's own view in the scratch database:

```console
$ cat crash.log
pilot-crash@2026-11-28T02:23:00.000Z start
pilot-crash@2026-11-28T02:24:00.000Z start
pilot-crash@2026-11-28T02:23:00.000Z end
pilot-crash@2026-11-28T02:24:00.000Z end
pilot-crash@2026-11-28T02:25:00.000Z start
pilot-crash@2026-11-28T02:25:00.000Z end
pilot-crash@2026-11-28T02:26:00.000Z start
pilot-crash@2026-11-28T02:26:00.000Z end
pilot-crash@2026-11-28T02:27:00.000Z start
pilot-crash@2026-11-28T02:28:00.000Z start
pilot-crash@2026-11-28T02:28:00.000Z end
pilot-crash@2026-11-28T02:29:00.000Z start
pilot-crash@2026-11-28T02:30:00.000Z start
pilot-crash@2026-11-28T02:30:00.000Z end
pilot-crash@2026-11-28T02:31:00.000Z start
$ grep " start$" crash.log | sort | tee ids.txt | wc -l   # 9 ids: 02:23 .. 02:31, every minute
9
$ sort ids.txt | uniq -d | wc -l                          # no id appears twice
0
$ docker exec ai-collab-postgres-postgres-1 psql -U ai_collab -d ai_collab_pilot \
    -c "SELECT workflow_uuid, status FROM dbos.workflow_status WHERE workflow_uuid LIKE 'pilot-crash%' ORDER BY created_at;"
            workflow_uuid             | status
--------------------------------------+---------
 pilot-crash@2026-11-28T02:23:00.000Z | SUCCESS
 pilot-crash@2026-11-28T02:24:00.000Z | SUCCESS
 pilot-crash@2026-11-28T02:25:00.000Z | SUCCESS
 pilot-crash@2026-11-28T02:26:00.000Z | SUCCESS
 pilot-crash@2026-11-28T02:27:00.000Z | SUCCESS
```

Verdict: PASS. Across the kill the tick ids are contiguous (no gap) and unique (no duplicate), the
cut tick recovered to SUCCESS without re-running its command, and later ticks ran normally.
(`02:27`, `02:29` and `02:31` have no `end` line because those runs were cut by the graceful stops
of the rollback check below.)

## 2. Rollback check: dbos to sqlite and forward again

The documented knob is `workflowEngine` in `defaults.json` ([configuration.md](configuration.md#dbos-workflow-engine)).
Exercised on the isolated runner only.

Back to sqlite (graceful `kill -TERM`, wait for exit, flip the value, start again):

```console
$ sed -i 's/"workflowEngine": "dbos"/"workflowEngine": "sqlite"/' config/ai-collab/defaults.json
$ # restart (runner3); boot log:
ai-collab-runner: no enabled project; serving the control socket only
ai-collab-runner: listening on /tmp/opencode/pilot/run/ai-collab/runner.sock; adapters none; recovered 0 session(s); schedules pilot-crash
$ grep -c "Initializing DBOS" runner3.err
0
$ ls state/ai-collab/
runner.db  runner.db-shm  runner.db-wal  runner.lock
$ grep "pilot-crash: ok" runner3.err
ai-collab-runner: pilot-crash: ok in 40029 ms
$ node -e 'const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync("/tmp/opencode/pilot/state/ai-collab/runner.db",{readOnly:true});
    for (const r of db.prepare("SELECT id, status FROM workflows WHERE name LIKE ? ORDER BY id DESC LIMIT 2").all("scheduled:pilot-crash")) console.log(r.id, r.status);'
pilot-crash@2026-11-28T02:29:00.000Z PENDING
pilot-crash@2026-11-28T02:28:00.000Z SUCCESS
```

No DBOS boot, the SQLite durable log appears in the isolated state dir, and a tick runs to SUCCESS
on it (`02:28`). Forward again:

```console
$ sed -i 's/"workflowEngine": "sqlite"/"workflowEngine": "dbos"/' config/ai-collab/defaults.json
$ # restart (runner4); boot log:
runner4.out:Initializing DBOS (v5.7.0)
runner4.out:Recovering 1 workflows for executor local from application version ai-collab-1
runner4.out:DBOS launched!
runner4.err:ai-collab-runner: pilot-crash: failed in 0 ms
$ grep "pilot-crash: ok" runner4.err
ai-collab-runner: pilot-crash: ok in 40007 ms
```

The recovered run is `pilot-crash@02:27:00`, left PENDING (step cut) when the dbos runner was
gracefully stopped mid-tick before the sqlite switch; returning to dbos recovered it and answered
the cut via `onCut`, and the next tick (`02:30`) ran clean.

Verdict: PASS. The engine switch works both ways with a runner restart, and a run left PENDING in
one engine's store is recovered when that engine returns. Note the stores are independent: a tick
cut while the *other* engine was active (here `02:29`, cut in the sqlite store) is not carried over
by switching engines; the schedule simply continues with the next tick.

## 3. pg_dump / pg_restore round trip of the bus and dbos schemas

Dumped from the live `ai_collab` database, restored into a scratch database
(`ai_collab_pilotdump`), never into the live one, and dropped after.

```console
$ docker exec ai-collab-postgres-postgres-1 psql -U ai_collab -d ai_collab \
    -c "SELECT schemaname, count(*) FROM pg_tables WHERE schemaname IN ('bus','dbos') GROUP BY 1;"
 schemaname | count
------------+-------
 bus        |     6
 dbos       |    14

$ docker exec ai-collab-postgres-postgres-1 pg_dump -U ai_collab -d ai_collab -n bus -n dbos > live-bus-dbos.sql
$ ls -l live-bus-dbos.sql
-rw-rw-r-- 1 b b 72154341 Nov 27 21:31 live-bus-dbos.sql
$ docker exec ai-collab-postgres-postgres-1 createdb -U ai_collab ai_collab_pilotdump
$ docker exec -i ai-collab-postgres-postgres-1 psql -U ai_collab -d ai_collab_pilotdump \
    -v ON_ERROR_STOP=1 -q < live-bus-dbos.sql && echo "restore: OK"
restore: OK
```

Live and scratch compared after the restore (the bus keeps receiving events, so `bus.events` on the
live database grew by 2 after the dump's snapshot; every dbos count matches exactly):

```console
$ # same query on both databases:
$ docker exec ai-collab-postgres-postgres-1 psql -U ai_collab -d ai_collab -t -c \
    "SELECT (SELECT count(*) FROM bus.events), (SELECT count(*) FROM dbos.workflow_status), (SELECT count(*) FROM dbos.operation_outputs), (SELECT count(*) FROM dbos.notifications);"
      52141 |       422 |       2518 |            23
$ docker exec ai-collab-postgres-postgres-1 psql -U ai_collab -d ai_collab_pilotdump -t -c "..."
      52139 |       422 |       2518 |            23
$ docker exec ai-collab-postgres-postgres-1 dropdb -U ai_collab ai_collab_pilotdump
$ docker exec ai-collab-postgres-postgres-1 psql -U ai_collab -d postgres -t -c \
    "SELECT datname FROM pg_database WHERE datname LIKE 'ai_collab%';"
 ai_collab_test
 ai_collab
```

Verdict: PASS. The `bus` and `dbos` schemas dump and restore clean under `ON_ERROR_STOP`, with
matching table and row counts, and the scratch database is gone.

## Left behind

- Scratch databases `ai_collab_pilot` and `ai_collab_pilotdump`: dropped.
- Raw logs of the isolated run: `/tmp/opencode/pilot/` (`crash.log`, `runner*.err|out`).
- The live services were not restarted by this pilot; the only restarts on 2026-11-27 were the
  token-cleanup ones at 20:25 EST, done before the operator's no-restart instruction.
