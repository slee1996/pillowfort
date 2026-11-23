----------------------------- MODULE HistoricalCleanup --------------------------
EXTENDS Naturals, Sequences
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
\* Two different (device, admission, Remove, retire-request) tuples, each represented
\* by its index. The reconnecting peer's journal remains available after relay cleanup.
Init == s = [relayHead |-> 1, localHead |-> 1, commits |-> {}, retired |-> {},
    sent |-> {}, durableAcks |-> {}, receive |-> 1, marker |-> 0, applied |-> {},
    replayed |-> {}, down |-> FALSE, closeThrough |-> 0, closed |-> FALSE,
    badRemoval |-> FALSE, badClose |-> FALSE]
StoreCommit == /\ s.relayHead \in 1..2 /\ s.relayHead \notin s.commits
               /\ s' = [s EXCEPT !.commits = @ \cup {s.relayHead}]
Submit == /\ ~s.down /\ s.localHead \in s.commits /\ s.localHead \notin s.sent
          /\ s' = [s EXCEPT !.sent = @ \cup {s.localHead}]
Retire == /\ s.relayHead \in s.sent /\ s.relayHead \in s.commits
          /\ s' = [s EXCEPT !.retired = @ \cup {s.relayHead}, !.relayHead = @+1]
Ack(i) == /\ ~s.down /\ i \in s.retired /\ s.localHead <= 2
          /\ (i = s.localHead \/ Broken = "OldRetire")
          /\ s' = [s EXCEPT !.localHead = @+1, !.durableAcks = @ \cup {i}]
Lifecycle(i) == /\ ~s.down /\ i \in s.retired /\ s.localHead <= 2
                /\ IF Broken = "LifecycleReceipt" THEN s' = [s EXCEPT !.localHead = @+1] ELSE UNCHANGED s
Marker == /\ ~s.closed /\ s.receive \in s.commits /\ (s.closeThrough = 0 \/ s.receive <= s.closeThrough) /\ s.marker = 0
          /\ s' = [s EXCEPT !.marker = s.receive]
Apply == /\ ~s.closed /\ s.receive \in s.commits /\ (s.closeThrough = 0 \/ s.receive <= s.closeThrough)
         /\ (s.marker = s.receive \/ Broken = "MissingMarker")
         /\ s' = [s EXCEPT !.applied = @ \cup {s.receive}, !.badRemoval = @ \/ s.marker # s.receive,
                 !.replayed = IF s.receive \in s.applied THEN @ \cup {s.receive} ELSE @, !.receive = @+1, !.marker = 0]
\* Close is observed after an already queued Remove. It must not overtake its processing.
QueueClose == /\ ~s.closed /\ s.closeThrough = 0 /\ s.receive \in s.commits
              /\ s' = [s EXCEPT !.closeThrough = IF 2 \in s.commits THEN 2 ELSE 1]
Close == /\ s.closeThrough # 0 /\ ~s.closed /\ (s.receive > s.closeThrough \/ Broken = "EarlyClose")
         /\ s' = [s EXCEPT !.closed = TRUE, !.closeThrough = 0, !.badClose = @ \/ s.receive <= s.closeThrough]
Reconnect == /\ s.closed /\ s' = [s EXCEPT !.closed = FALSE, !.receive = 1, !.marker = 0]
Crash == /\ ~s.down /\ s' = [s EXCEPT !.down = TRUE]
Restore == /\ s.down /\ s' = [s EXCEPT !.down = FALSE]
Next == StoreCommit \/ Submit \/ Retire \/ (\E i \in 1..2 : Ack(i) \/ Lifecycle(i)) \/ Marker \/ Apply \/ QueueClose \/ Close \/ Reconnect \/ Crash \/ Restore
Safety == /\ ~s.badRemoval /\ ~s.badClose /\ s.retired \subseteq s.commits /\ s.durableAcks \subseteq s.retired
          /\ \A i \in 1..2 : (i < s.localHead) <=> (i \in s.durableAcks)
NoTwoHistoricalRemovals == ~(s.localHead = 3 /\ s.replayed = {1,2})
=============================================================================
