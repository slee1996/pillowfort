---------------------------- MODULE M1Delivery ----------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
vars == <<s>>
Init == s = [id |-> 0, phase |-> "idle", stored |-> {}, sent |-> {},
             accepted |-> {}, senderDone |-> {}, inbox |-> <<>>, seen |-> {},
             applied |-> [i \in 1..MaxOps |-> 0], acked |-> {},
             connection |-> 1, grantConnection |-> 1, badBinding |-> FALSE,
             wire |-> "none", down |-> FALSE, hostBacklog |-> FALSE,
             hostProcessed |-> FALSE, badHostPreview |-> FALSE]
Quiescent == s.phase = "idle"
Prepare == /\ ~s.down /\ Quiescent /\ s.id < MaxOps
           /\ (~s.hostBacklog \/ Broken = "Preview")
           /\ s' = [s EXCEPT !.id = @ + 1, !.phase = "prepared",
                              !.stored = @ \cup {s.id + 1},
                              !.grantConnection = s.connection,
                              !.badHostPreview = @ \/ s.hostBacklog]
ReplaceSocket == /\ s.phase = "prepared" /\ s.connection = 1
                 /\ s' = [s EXCEPT !.connection = 2]
Regrant == /\ s.phase = "prepared" /\ s.connection # s.grantConnection
           /\ s' = [s EXCEPT !.grantConnection = s.connection]
Send == /\ ~s.down /\ s.phase = "prepared"
        /\ (s.connection = s.grantConnection \/ Broken = "Grant")
        /\ s' = [s EXCEPT !.sent = @ \cup {s.id}, !.wire = "frame",
                           !.phase = "sent",
                           !.badBinding = @ \/ (s.connection # s.grantConnection)]
SendBeforeStore == /\ Broken = "Persistence" /\ Quiescent /\ s.id < MaxOps
                   /\ s' = [s EXCEPT !.id = @ + 1, !.sent = @ \cup {s.id + 1},
                                      !.phase = "sent", !.wire = "frame"]
CommitResult == /\ s.wire = "frame" /\ s.id \notin s.accepted
                /\ Len(s.inbox) < Capacity
                /\ s' = [s EXCEPT !.accepted = @ \cup {s.id},
                                   !.inbox = Append(@, s.id), !.wire = "none",
                                   !.hostBacklog = TRUE, !.hostProcessed = FALSE]
EmitResult == /\ s.id \in s.accepted /\ s.id \notin s.senderDone
              /\ s.wire = "none" /\ s' = [s EXCEPT !.wire = "result"]
StoreResult == /\ ~s.down /\ s.wire = "result"
               /\ s' = [s EXCEPT !.senderDone = @ \cup {s.id},
                                  !.phase = "idle", !.wire = "none"]
HostStore == /\ s.hostBacklog /\ ~s.hostProcessed
             /\ s' = [s EXCEPT !.hostProcessed = TRUE]
HostAck == /\ s.hostBacklog /\ s.hostProcessed
           /\ s' = [s EXCEPT !.hostBacklog = FALSE]
Deliver == /\ Len(s.inbox) > 0 /\ Head(s.inbox) \notin s.seen
           /\ LET i == Head(s.inbox) IN
              s' = [s EXCEPT !.seen = @ \cup {i}, !.applied[i] = @ + 1]
AckPrefix == /\ Len(s.inbox) > 0 /\ Head(s.inbox) \in s.seen
             /\ s' = [s EXCEPT !.acked = @ \cup {Head(s.inbox)}, !.inbox = Tail(@)]
ReplayDelivery == /\ Len(s.inbox) > 0 /\ Head(s.inbox) \in s.seen
                  /\ UNCHANGED s
LoseFrame == /\ s.wire # "none" /\ s' = [s EXCEPT !.wire = "none"]
Retry == /\ ~s.down /\ s.phase = "sent" /\ s.wire = "none"
         /\ s.id \notin s.accepted /\ s' = [s EXCEPT !.wire = "frame"]
Crash == /\ ~s.down /\ s' = [s EXCEPT !.down = TRUE, !.wire = "none"]
Restore == /\ s.down /\ s' = [s EXCEPT !.down = FALSE]
Next == Prepare \/ ReplaceSocket \/ Regrant \/ Send \/ SendBeforeStore
        \/ CommitResult \/ EmitResult \/ StoreResult \/ Deliver \/ AckPrefix
        \/ ReplayDelivery \/ LoseFrame \/ Retry \/ Crash \/ Restore \/ HostStore \/ HostAck
Safety == /\ s.sent \subseteq s.stored
          /\ ~s.badBinding /\ ~s.badHostPreview
          /\ s.senderDone \subseteq s.accepted
          /\ s.acked \subseteq s.seen
          /\ \A i \in 1..MaxOps : s.applied[i] <= 1
          /\ Len(s.inbox) <= Capacity
=============================================================================
