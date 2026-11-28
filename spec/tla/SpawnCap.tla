---------------------------- MODULE SpawnCap ----------------------------
(* The per-parent child cap in runner/runner.ts start(): a spawn is admitted when liveChildren(parent) < Cap, and   *)
(* counts in `spawning` until start() returns, then as its live session in `sessions`. The session workflow's claim  *)
(* step checks the abort signal, writes the record, and registers the session (runtime()) after the step's await, so *)
(* Check and Register are two steps. A start that times out (504) cancels the workflow, and its finally drops the    *)
(* pending entry; a claim that already passed its check still registers, and releaseCancelled ends it once the run   *)
(* stops. DeferRelease = TRUE keeps a cancelled spawn in `spawning` until its workflow ends, the fix this models.     *)
EXTENDS Naturals, FiniteSets

CONSTANTS Starts, Cap, DeferRelease

VARIABLES phase, waiting, aborted, spawning

vars == <<phase, waiting, aborted, spawning>>

(* idle: not started; pending: admitted, opening; checked: claim passed its abort check; live: in `sessions`;   *)
(* ended: session ended or claim failed; refused: over the cap; failed: open failed.                            *)
Phases == {"idle", "pending", "checked", "live", "ended", "refused", "failed"}

TypeOK ==
  /\ phase \in [Starts -> Phases]
  /\ waiting \in [Starts -> BOOLEAN]
  /\ aborted \in [Starts -> BOOLEAN]
  /\ spawning \subseteq Starts

Init ==
  /\ phase = [s \in Starts |-> "idle"]
  /\ waiting = [s \in Starts |-> FALSE]
  /\ aborted = [s \in Starts |-> FALSE]
  /\ spawning = {}

Live == {s \in Starts : phase[s] = "live"}

(* liveChildren(parent): live sessions, plus pending starts whose session has not claimed yet. *)
Count == Cardinality(Live) + Cardinality({s \in spawning : phase[s] # "live"})

Admit(s) ==
  /\ phase[s] = "idle" /\ Count < Cap
  /\ phase' = [phase EXCEPT ![s] = "pending"]
  /\ waiting' = [waiting EXCEPT ![s] = TRUE]
  /\ spawning' = spawning \cup {s}
  /\ UNCHANGED aborted

Refuse(s) ==
  /\ phase[s] = "idle" /\ Count >= Cap
  /\ phase' = [phase EXCEPT ![s] = "refused"]
  /\ UNCHANGED <<waiting, aborted, spawning>>

(* adapter.open throws: the workflow ends and start() answers 502; finally drops the entry. *)
OpenFail(s) ==
  /\ phase[s] = "pending" /\ ~aborted[s]
  /\ phase' = [phase EXCEPT ![s] = "failed"]
  /\ waiting' = [waiting EXCEPT ![s] = FALSE]
  /\ spawning' = spawning \ {s}
  /\ UNCHANGED aborted

(* The claim step: wf.signal.throwIfAborted(), then writeOwned; an aborted claim writes the record ended. *)
Check(s) ==
  /\ phase[s] = "pending"
  /\ phase' = [phase EXCEPT ![s] = IF aborted[s] THEN "ended" ELSE "checked"]
  /\ spawning' = IF aborted[s] THEN spawning \ {s} ELSE spawning
  /\ UNCHANGED <<waiting, aborted>>

(* runtime(): sessions.set, then claims.set resolves the waiting start. *)
Register(s) ==
  /\ phase[s] = "checked"
  /\ phase' = [phase EXCEPT ![s] = "live"]
  /\ UNCHANGED <<waiting, aborted, spawning>>

(* start() returns the session; finally drops the entry. *)
Return(s) ==
  /\ waiting[s] /\ phase[s] = "live"
  /\ waiting' = [waiting EXCEPT ![s] = FALSE]
  /\ spawning' = spawning \ {s}
  /\ UNCHANGED <<phase, aborted>>

(* The start timer fires (504): durable.cancel aborts the workflow; finally drops the entry unless DeferRelease. *)
Timeout(s) ==
  /\ waiting[s] /\ phase[s] \in {"pending", "checked"}
  /\ waiting' = [waiting EXCEPT ![s] = FALSE]
  /\ aborted' = [aborted EXCEPT ![s] = TRUE]
  /\ spawning' = IF DeferRelease THEN spawning ELSE spawning \ {s}
  /\ UNCHANGED phase

(* releaseCancelled after the cancelled workflow stops: its late session ends. *)
ReleaseCancelled(s) ==
  /\ aborted[s] /\ phase[s] = "live"
  /\ phase' = [phase EXCEPT ![s] = "ended"]
  /\ spawning' = spawning \ {s}
  /\ UNCHANGED <<waiting, aborted>>

(* The child finishes or the parent closes it (close_agent). *)
End(s) ==
  /\ phase[s] = "live" /\ ~aborted[s] /\ ~waiting[s]
  /\ phase' = [phase EXCEPT ![s] = "ended"]
  /\ UNCHANGED <<waiting, aborted, spawning>>

Next == \E s \in Starts :
  \/ Admit(s) \/ Refuse(s) \/ OpenFail(s) \/ Check(s) \/ Register(s) \/ Return(s) \/ Timeout(s) \/ ReleaseCancelled(s) \/ End(s)

Spec == Init /\ [][Next]_vars

(* What the cap promises: never more than Cap children live, and never more than Cap counted. *)
LiveCap == Cardinality(Live) <= Cap
CountCap == Count <= Cap
(* An entry in `spawning` belongs to a start that is still opening or whose cancelled workflow has not stopped. *)
SpawningTracked == \A s \in spawning : phase[s] \in {"pending", "checked", "live"}
=============================================================================
