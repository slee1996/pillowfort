---------------------------- MODULE M3Resume -------------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "ready", connection |-> 1, request |-> 0,
             terminator |-> 0, persisted |-> FALSE, reconciled |-> FALSE,
             snapshotHost |-> 1, authenticatedHost |-> 1,
             sent |-> FALSE, acknowledged |-> FALSE, down |-> FALSE]
Ready == s.phase = "ready" /\ ~s.down
Disconnect == /\ Ready /\ s.connection = 1
              /\ s' = [s EXCEPT !.phase = "disconnected", !.connection = 2,
                                 !.acknowledged = FALSE]
Begin == /\ ~s.down /\ s.phase = "disconnected"
         /\ s' = [s EXCEPT !.phase = "replay", !.request = 1, !.terminator = 2]
PersistPrefix == /\ ~s.down /\ s.phase = "replay"
                 /\ s' = [s EXCEPT !.persisted = TRUE, !.phase = "snapshot"]
Snapshot(h) == /\ ~s.down /\ s.phase = "snapshot" /\ h \in {1, 2}
               /\ (h = s.authenticatedHost \/ Broken = "Snapshot")
               /\ s' = [s EXCEPT !.snapshotHost = h, !.reconciled = TRUE, !.phase = "terminator"]
ObserveEnd(t) == /\ ~s.down /\ s.phase = "terminator" /\ t = s.terminator
                 /\ s' = [s EXCEPT !.phase = "complete"]
SendCompletion == /\ ~s.down /\ s.phase = "complete"
                  /\ s' = [s EXCEPT !.sent = TRUE, !.phase = "waiting"]
Acknowledge(c, q, t) == /\ ~s.down /\ s.phase = "waiting"
                        /\ c = s.connection /\ q = s.request /\ t = s.terminator
                        /\ s' = [s EXCEPT !.acknowledged = TRUE, !.phase = "ready"]
Crash == /\ ~s.down /\ s' = [s EXCEPT !.down = TRUE]
Restore == /\ s.down /\ s' = [s EXCEPT !.down = FALSE]
Next == Disconnect \/ Begin \/ PersistPrefix \/ (\E h \in {1, 2} : Snapshot(h))
        \/ (\E t \in {1, 2} : ObserveEnd(t)) \/ SendCompletion
        \/ (\E c, q, t \in {1, 2} : Acknowledge(c, q, t)) \/ Crash \/ Restore
Safety == /\ (s.reconciled => s.snapshotHost = s.authenticatedHost)
          /\ (s.sent => s.persisted /\ s.reconciled)
          /\ (s.acknowledged => s.sent /\ s.persisted /\ s.reconciled)
          /\ (s.phase = "ready" /\ s.connection = 2 => s.acknowledged)
=============================================================================
