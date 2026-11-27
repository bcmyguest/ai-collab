---------------------------- MODULE StoreLock ----------------------------
(* The owner-pid lock of lib/store.ts (withLock / withLockSync).
   A process takes the lock with mkdir, then writes owner.json {pid, start, token} (takeLock).
   A waiter judges the lock stale (isStale) and breaks it under a breaker mutex (reclaimStale),
   re-checking staleness inside the mutex. Release renames the lock to a tomb and puts back a
   tomb that is not its own (releaseLock). Tombs left on disk do not affect the lock, so the spec drops them.
   Crash kills a process; Respawn gives its pid a new start time, which is also pid reuse.
   Age moves the lock's mtime age: fresh < staleMs < old < ceiling (10 x staleMs) < ancient.
   Assumption, as in clearOldBreaker: no process crashes while it holds the breaker. *)
EXTENDS Naturals

CONSTANTS
  Procs,               \* process ids; each process runs on the pid of the same name
  MaxStart,            \* bound on respawns per pid
  MaxAcq,              \* bound on acquisitions per incarnation
  CheckStart,          \* TRUE: isStale compares the recorded start time (the fix for pid reuse)
  OwnerWriteExclusive, \* TRUE: takeLock writes owner.json only into its own, still ownerless dir
  None                 \* a model value: no lock, no breaker holder, no tomb

Ages == {"fresh", "old", "ancient"}

VARIABLES
  lock,         \* None, or [pid, start, tok, age, file] where file = owner.json written
  breaker,      \* None, or the process holding the breaker mutex
  pc,           \* each process's step
  start,        \* start time of the process now running on each pid
  alive,        \* whether a process runs on each pid
  acq,          \* acquisitions per incarnation, the token counter
  tomb,         \* the tomb each releasing process renamed, or None
  ceilingBroke  \* history: a waiter broke a live holder's lock at the ceiling

vars == <<lock, breaker, pc, start, alive, acq, tomb, ceilingBroke>>

Tok(p) == <<p, start[p], acq[p]>>

LockRec == [pid: Procs, start: 0..MaxStart, tok: Procs \X (0..MaxStart) \X (0..MaxAcq), age: Ages, file: BOOLEAN]

TypeOK ==
  /\ lock \in LockRec \cup {None}
  /\ breaker \in Procs \cup {None}
  /\ pc \in [Procs -> {"idle", "mkdir", "owner", "check", "breaker", "recheck", "drop", "cs",
                       "relRename", "relCheck", "dead"}]
  /\ start \in [Procs -> 0..MaxStart]
  /\ alive \in [Procs -> BOOLEAN]
  /\ acq \in [Procs -> 0..MaxAcq]
  /\ tomb \in [Procs -> LockRec \cup {None}]
  /\ ceilingBroke \in BOOLEAN

(* isStale: without owner.json, by age; with one, at the ceiling, when the pid is gone, or when its start time differs. *)
IsStale(l) ==
  IF ~l.file THEN l.age \in {"old", "ancient"}
  ELSE \/ l.age = "ancient"
       \/ ~alive[l.pid]
       \/ (CheckStart /\ start[l.pid] # l.start)

(* The owner incarnation that took the lock is gone: its pid is dead or now runs another process. *)
OwnerGone(l) == ~alive[l.pid] \/ start[l.pid] # l.start

Init ==
  /\ lock = None
  /\ breaker = None
  /\ pc = [p \in Procs |-> "idle"]
  /\ start = [p \in Procs |-> 0]
  /\ alive = [p \in Procs |-> TRUE]
  /\ acq = [p \in Procs |-> 0]
  /\ tomb = [p \in Procs |-> None]
  /\ ceilingBroke = FALSE

\* Mirrors store-lock model test Acquire: a process starts withLock.
Begin(p) ==
  /\ pc[p] = "idle" /\ acq[p] < MaxAcq
  /\ acq' = [acq EXCEPT ![p] = @ + 1]
  /\ pc' = [pc EXCEPT ![p] = "mkdir"]
  /\ UNCHANGED <<lock, breaker, start, alive, tomb, ceilingBroke>>

\* takeLock: mkdir succeeds on a free path, else the waiter checks staleness.
Mkdir(p) ==
  /\ pc[p] = "mkdir"
  /\ IF lock = None
     THEN /\ lock' = [pid |-> p, start |-> start[p], tok |-> Tok(p), age |-> "fresh", file |-> FALSE]
          /\ pc' = [pc EXCEPT ![p] = "owner"]
     ELSE /\ pc' = [pc EXCEPT ![p] = "check"]
          /\ UNCHANGED lock
  /\ UNCHANGED <<breaker, start, alive, acq, tomb, ceilingBroke>>

Mine(p) == [pid |-> p, start |-> start[p], tok |-> Tok(p), age |-> "fresh", file |-> TRUE]

(* takeLock writes owner.json into the dir it made. A waiter may have broken that dir meanwhile (no owner.json and
   older than staleMs) and another process may have made a new one. Exclusive: the write lands only in a dir that
   still has no owner.json, else the process retries. Otherwise (writeJson: mkdir -p, then rename over owner.json)
   it recreates a missing dir or overwrites the other owner's owner.json, and the process enters cs. *)
WriteOwner(p) ==
  /\ pc[p] = "owner"
  /\ IF OwnerWriteExclusive
     THEN IF lock # None /\ ~lock.file
          THEN /\ lock' = [lock EXCEPT !.pid = p, !.start = start[p], !.tok = Tok(p), !.file = TRUE]
               /\ pc' = [pc EXCEPT ![p] = "cs"]
          ELSE /\ pc' = [pc EXCEPT ![p] = "mkdir"]
               /\ UNCHANGED lock
     ELSE /\ lock' = IF lock = None THEN Mine(p) ELSE [lock EXCEPT !.pid = p, !.start = start[p], !.tok = Tok(p), !.file = TRUE]
          /\ pc' = [pc EXCEPT ![p] = "cs"]
  /\ UNCHANGED <<breaker, start, alive, acq, tomb, ceilingBroke>>

\* reclaimStale: a lock that is not stale sends the waiter back to mkdir (it retries until waitMs).
Check(p) ==
  /\ pc[p] = "check"
  /\ pc' = [pc EXCEPT ![p] = IF lock # None /\ IsStale(lock) THEN "breaker" ELSE "mkdir"]
  /\ UNCHANGED <<lock, breaker, start, alive, acq, tomb, ceilingBroke>>

TakeBreaker(p) ==
  /\ pc[p] = "breaker"
  /\ IF breaker = None
     THEN /\ breaker' = p
          /\ pc' = [pc EXCEPT ![p] = "recheck"]
     ELSE /\ pc' = [pc EXCEPT ![p] = "mkdir"]
          /\ UNCHANGED breaker
  /\ UNCHANGED <<lock, start, alive, acq, tomb, ceilingBroke>>

\* Inside the breaker: remove the lock only if it is still stale. Only the ceiling breaks a live holder's lock.
Recheck(p) ==
  /\ pc[p] = "recheck"
  /\ IF lock # None /\ IsStale(lock)
     THEN /\ lock' = None
          /\ ceilingBroke' = (ceilingBroke \/ \E q \in Procs : pc[q] \in {"cs", "relRename"} /\ lock.tok = Tok(q))
     ELSE UNCHANGED <<lock, ceilingBroke>>
  /\ pc' = [pc EXCEPT ![p] = "drop"]
  /\ UNCHANGED <<breaker, start, alive, acq, tomb>>

DropBreaker(p) ==
  /\ pc[p] = "drop"
  /\ breaker' = None
  /\ pc' = [pc EXCEPT ![p] = "mkdir"]
  /\ UNCHANGED <<lock, start, alive, acq, tomb, ceilingBroke>>

\* Mirrors store-lock model test Release: releaseLock reads owner.json; a lock not ours is left alone.
RelRead(p) ==
  /\ pc[p] = "cs"
  /\ pc' = [pc EXCEPT ![p] = IF lock # None /\ lock.tok = Tok(p) THEN "relRename" ELSE "idle"]
  /\ UNCHANGED <<lock, breaker, start, alive, acq, tomb, ceilingBroke>>

\* rename(lock, tomb) moves whatever lock is on the path now.
RelRename(p) ==
  /\ pc[p] = "relRename"
  /\ IF lock # None
     THEN /\ tomb' = [tomb EXCEPT ![p] = lock]
          /\ lock' = None
          /\ pc' = [pc EXCEPT ![p] = "relCheck"]
     ELSE /\ UNCHANGED <<tomb, lock>>
          /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<breaker, start, alive, acq, ceilingBroke>>

\* Our tomb is removed; another owner's tomb goes back to the lock path, or stays on disk if the path was retaken.
RelCheck(p) ==
  /\ pc[p] = "relCheck"
  /\ lock' = IF tomb[p].tok # Tok(p) /\ lock = None THEN tomb[p] ELSE lock
  /\ tomb' = [tomb EXCEPT ![p] = None]
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<breaker, start, alive, acq, ceilingBroke>>

\* Mirrors store-lock model test Crash: SIGKILL; the lock, a tomb or nothing stays behind.
Crash(p) ==
  /\ pc[p] \notin {"dead", "recheck", "drop"}
  /\ pc' = [pc EXCEPT ![p] = "dead"]
  /\ alive' = [alive EXCEPT ![p] = FALSE]
  /\ tomb' = [tomb EXCEPT ![p] = None]
  /\ UNCHANGED <<lock, breaker, start, acq, ceilingBroke>>

\* Mirrors store-lock model test ReusePid: another process (or this one restarted) runs on the pid with a new start time.
Respawn(p) ==
  /\ pc[p] = "dead" /\ start[p] < MaxStart
  /\ start' = [start EXCEPT ![p] = @ + 1]
  /\ alive' = [alive EXCEPT ![p] = TRUE]
  /\ acq' = [acq EXCEPT ![p] = 0]
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<lock, breaker, tomb, ceilingBroke>>

\* Mirrors store-lock model test Advance: the lock dir's mtime ages past staleMs, then past the ceiling.
Age ==
  /\ lock # None /\ lock.age # "ancient"
  /\ lock' = [lock EXCEPT !.age = IF @ = "fresh" THEN "old" ELSE "ancient"]
  /\ UNCHANGED <<breaker, pc, start, alive, acq, tomb, ceilingBroke>>

Next ==
  \/ Age
  \/ \E p \in Procs :
       \/ Begin(p) \/ Mkdir(p) \/ WriteOwner(p) \/ Check(p) \/ TakeBreaker(p) \/ Recheck(p) \/ DropBreaker(p)
       \/ RelRead(p) \/ RelRename(p) \/ RelCheck(p) \/ Crash(p) \/ Respawn(p)

Spec == Init /\ [][Next]_vars

InCS(p) == pc[p] = "cs"

(* At most one holder, until a waiter breaks a live holder's lock at the ceiling. After that the broken holder's
   release can rename the next holder's lock away for a moment and let a third process in: the accepted cost of a
   ceiling that only a holder stuck for 10 x staleMs triggers. *)
MutualExclusion ==
  ~ceilingBroke => \A p, q \in Procs : InCS(p) /\ InCS(q) => p = q

(* A holder owns the lock on disk, until a ceiling break. *)
HolderOwnsLock ==
  ~ceilingBroke => \A p \in Procs : InCS(p) => lock # None /\ lock.tok = Tok(p)

(* No stuck lock: a lock whose owner incarnation is gone is stale at once, without waiting for the ceiling. *)
DeadOwnerIsStale ==
  lock # None /\ lock.file /\ OwnerGone(lock) => IsStale(lock)

=============================================================================
