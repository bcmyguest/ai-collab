----------------------------- MODULE Delivery -----------------------------
(* One expect-reply message through the runner's durable delivery workflow (runner/delivery.mjs), under the
   policy of lib/delivery.ts nextAction: the first push needs only a ready target; a redelivery waits out
   redeliverMs, then ends on an answer, the TTL or the attempt cap, waits while the target is busy, and pushes
   once it is idle. The runner can crash at any point and restart; durable steps replay, polls run again.
   A live attempt goes from its checks to the push step without interleaving: only a crash splits them,
   after the reserve step is recorded and before the push step starts. *)
EXTENDS Naturals

CONSTANTS
  MaxAttempts,  \* MAX_ATTEMPTS: pushes in all, the first included
  MaxCrashes,   \* bound on runner crashes
  ResumeChecks  \* TRUE: a push resumed after that split checks the answer and the target again

VARIABLES
  phase,    \* the workflow's place: first, pushing, sleep, wake, redeliver, resumed, cutLanded, cutLost, done
  status,   \* running, or the outcome: answered, expired, dropped, cut
  runner,   \* up or down
  crashes,  \* crashes so far
  pushes,   \* pushes the workflow recorded as delivered
  copies,   \* copies that reached the target
  target,   \* idle (ready, takes a push) or busy (works on a turn)
  answered, \* the target answered the message
  expired,  \* the TTL has run out
  pushAfterAnswer, \* history: a push step started after the answer
  pushWhileBusy    \* history: a redelivery push step started while the target was busy

vars == <<phase, status, runner, crashes, pushes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

Phases == {"first", "pushing", "sleep", "wake", "redeliver", "resumed", "cutLanded", "cutLost", "done"}

TypeOK ==
  /\ phase \in Phases
  /\ status \in {"running", "answered", "expired", "dropped", "cut"}
  /\ runner \in {"up", "down"}
  /\ crashes \in 0..MaxCrashes
  /\ pushes \in 0..MaxAttempts
  /\ copies \in 0..MaxAttempts
  /\ target \in {"idle", "busy"}
  /\ answered \in BOOLEAN
  /\ expired \in BOOLEAN
  /\ pushAfterAnswer \in BOOLEAN
  /\ pushWhileBusy \in BOOLEAN

Init ==
  /\ phase = "first"
  /\ status = "running"
  /\ runner = "up"
  /\ crashes = 0
  /\ pushes = 0
  /\ copies = 0
  /\ target = "idle"
  /\ answered = FALSE
  /\ expired = FALSE
  /\ pushAfterAnswer = FALSE
  /\ pushWhileBusy = FALSE

Up == runner = "up"

Finish(s) ==
  /\ phase' = "done"
  /\ status' = s

\* The push step starts; the history flags record a start the policy forbids.
StartPush ==
  /\ phase' = "pushing"
  /\ pushAfterAnswer' = (pushAfterAnswer \/ answered)
  /\ pushWhileBusy' = (pushWhileBusy \/ (pushes > 0 /\ target = "busy"))

(* nextAction for a redelivery, on live facts: answer, TTL, attempt cap, busy, ready. *)
RedeliverAction ==
  IF answered THEN "answered"
  ELSE IF expired THEN "expired"
  ELSE IF pushes >= MaxAttempts THEN "dropped"
  ELSE IF target = "busy" THEN "wait"
  ELSE "push"

\* Mirrors delivery model test NewMessage: the first attempt pushes to a ready target; acks are not polled.
FirstPush ==
  /\ Up /\ phase = "first"
  /\ IF expired
     THEN Finish("expired") /\ UNCHANGED <<pushAfterAnswer, pushWhileBusy>>
     ELSE StartPush /\ UNCHANGED status
  /\ UNCHANGED <<runner, crashes, pushes, copies, target, answered, expired>>

\* Mirrors delivery model test Tick (redelivery attempt): target() polls until nextAction says push, then the push step starts.
Redeliver ==
  /\ Up /\ phase = "redeliver"
  /\ RedeliverAction # "wait"
  /\ IF RedeliverAction = "push"
     THEN StartPush /\ UNCHANGED status
     ELSE Finish(RedeliverAction) /\ UNCHANGED <<pushAfterAnswer, pushWhileBusy>>
  /\ UNCHANGED <<runner, crashes, pushes, copies, target, answered, expired>>

\* Mirrors delivery model test Cut: the runner dies right after the reserve step of an attempt, before the push step.
CrashAfterReserve ==
  /\ Up /\ phase \in {"first", "redeliver"} /\ crashes < MaxCrashes
  /\ (phase = "first" /\ ~expired) \/ (phase = "redeliver" /\ RedeliverAction = "push")
  /\ phase' = "resumed"
  /\ runner' = "down"
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<status, pushes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

(* The replayed reserve leads straight to the push step: target() and the answer re-check skip a replayed attempt.
   With ResumeChecks the push step re-runs the redelivery checks first and fails the attempt (retry after backoff)
   on a busy target or ends it on an answer, TTL or cap. *)
ResumePush ==
  /\ Up /\ phase = "resumed"
  /\ IF ResumeChecks /\ pushes > 0 /\ RedeliverAction # "push"
     THEN IF RedeliverAction = "wait"
          THEN phase' = "redeliver" /\ UNCHANGED <<status, pushAfterAnswer, pushWhileBusy>>
          ELSE Finish(RedeliverAction) /\ UNCHANGED <<pushAfterAnswer, pushWhileBusy>>
     ELSE StartPush /\ UNCHANGED status
  /\ UNCHANGED <<runner, crashes, pushes, copies, target, answered, expired>>

\* The push step completes: the copy reaches the target, which starts a turn on it; mark, then sleep redeliverMs.
Land ==
  /\ Up /\ phase = "pushing"
  /\ phase' = "sleep"
  /\ copies' = copies + 1
  /\ pushes' = pushes + 1
  /\ target' = "busy"
  /\ UNCHANGED <<status, runner, crashes, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* The durable redelivery sleep runs out.
Wake ==
  /\ Up /\ phase = "sleep"
  /\ phase' = "wake"
  /\ UNCHANGED <<status, runner, crashes, pushes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* The acked step and the wake check: answer, TTL and cap end the message; otherwise a redelivery attempt starts.
AckedStep ==
  /\ Up /\ phase = "wake"
  /\ IF answered \/ expired \/ pushes >= MaxAttempts
     THEN Finish(IF answered THEN "answered" ELSE IF expired THEN "expired" ELSE "dropped")
     ELSE phase' = "redeliver" /\ UNCHANGED status
  /\ UNCHANGED <<runner, crashes, pushes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test RestartRunner (crash half): a push step in flight either reached the target or not.
Crash ==
  /\ Up /\ crashes < MaxCrashes /\ phase # "done"
  /\ runner' = "down"
  /\ crashes' = crashes + 1
  /\ IF phase = "pushing"
     THEN \/ phase' = "cutLanded" /\ copies' = copies + 1 /\ target' = "busy"
          \/ phase' = "cutLost" /\ UNCHANGED <<copies, target>>
     ELSE UNCHANGED <<phase, copies, target>>
  /\ UNCHANGED <<status, pushes, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test RestartRunner (restart half): recovery resumes the workflow.
Restart ==
  /\ runner = "down"
  /\ runner' = "up"
  /\ UNCHANGED <<phase, status, crashes, pushes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* The push step's onCut: waitConfirmed finds a landed copy (delivered); an unconfirmed push is cut, never sent again.
OnCut ==
  /\ Up /\ phase \in {"cutLanded", "cutLost"}
  /\ IF phase = "cutLanded"
     THEN phase' = "sleep" /\ pushes' = pushes + 1 /\ UNCHANGED status
     ELSE Finish("cut") /\ UNCHANGED pushes
  /\ UNCHANGED <<runner, crashes, copies, target, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test SetBusy: the target starts a turn from another source.
TargetBusy ==
  /\ target = "idle"
  /\ target' = "busy"
  /\ UNCHANGED <<phase, status, runner, crashes, pushes, copies, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test SetReady: the target's turn ends.
TargetIdle ==
  /\ target = "busy"
  /\ target' = "idle"
  /\ UNCHANGED <<phase, status, runner, crashes, pushes, copies, answered, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test Ack: during a turn the target answers a message it has received.
Answer ==
  /\ target = "busy" /\ copies > 0 /\ ~answered
  /\ answered' = TRUE
  /\ UNCHANGED <<phase, status, runner, crashes, pushes, copies, target, expired, pushAfterAnswer, pushWhileBusy>>

\* Mirrors delivery model test Tick past TTL_MS.
Expire ==
  /\ ~expired
  /\ expired' = TRUE
  /\ UNCHANGED <<phase, status, runner, crashes, pushes, copies, target, answered, pushAfterAnswer, pushWhileBusy>>

Next ==
  \/ FirstPush \/ Redeliver \/ CrashAfterReserve \/ ResumePush \/ Land \/ Wake \/ AckedStep
  \/ Crash \/ Restart \/ OnCut
  \/ TargetBusy \/ TargetIdle \/ Answer \/ Expire

Spec == Init /\ [][Next]_vars

(* No copy after an answer: no push step starts once the target has answered. *)
NoCopyAfterAnswer == ~pushAfterAnswer

(* No redelivery while busy: a redelivery push step starts only on an idle target. *)
NoRedeliveryWhileBusy == ~pushWhileBusy

(* At most MAX_ATTEMPTS copies, and each copy that reached the target is counted once. *)
AttemptCap == copies <= MaxAttempts
CopiesCounted == phase \notin {"cutLanded"} => copies = pushes

(* An ended message stays ended and gets no further copy. *)
Terminal == phase = "done" <=> status # "running"
TerminalStable == [][status # "running" => status' = status /\ copies' = copies]_vars

=============================================================================
