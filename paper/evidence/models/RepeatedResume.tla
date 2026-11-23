---------------------------- MODULE RepeatedResume ----------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLES guest, requests, acks, cleared, activatedBy, releasedBy
R == INSTANCE M3Resume WITH s <- guest

\* Start at the cut explored by ResumeAcrossSuccession: while the ordinary
\* guest is away, host 2 succeeds host 1. Its signed acceptance is retained
\* until the relay accepts a complete replay. Before then, both replacement
\* sockets can legitimately receive the SAME nonempty terminator (10).
Tail == IF cleared THEN guest.connection ELSE 10
CompletionId(c) == 20 + c
Init == R!Init /\ requests = {} /\ acks = {} /\ cleared = FALSE
        /\ activatedBy = 0 /\ releasedBy = 0

FirstLoss == R!Disconnect /\ UNCHANGED <<requests, acks, cleared, activatedBy, releasedBy>>
SecondLoss == /\ guest.connection = 2 /\ guest.phase \notin {"ready", "disconnected"}
              /\ guest' = [guest EXCEPT !.phase = "disconnected", !.connection = 3,
                            !.request = 0, !.terminator = 0, !.sent = FALSE,
                            !.reconciled = FALSE, !.persisted = FALSE, !.acknowledged = FALSE]
              /\ activatedBy' = 0 /\ releasedBy' = 0
              /\ UNCHANGED <<requests, acks, cleared>>
Replay == /\ (R!BeginAt(Tail) \/ R!PersistPrefixWith(IF cleared THEN guest.authenticatedHost ELSE 2)
              \/ R!Snapshot(2) \/ R!ObserveEnd(guest.terminator))
          /\ UNCHANGED <<requests, acks, cleared, activatedBy, releasedBy>>
Submit == /\ R!SendCompletion
          /\ requests' = requests \cup {[socket |-> guest.connection, endId |-> guest.terminator,
                                          id |-> CompletionId(guest.connection)]}
          /\ UNCHANGED <<acks, cleared, activatedBy, releasedBy>>
\* Retention in the channel allows delayed or duplicate delivery. A completion
\* retains its originating authenticated socket; an ACK names a completion ID.
Accept(f) == /\ activatedBy = 0 /\ guest.phase \notin {"ready", "disconnected"}
             /\ (f.socket = guest.connection \/ Broken = "OldCompletion") /\ f.endId = Tail
             /\ activatedBy' = f.socket /\ cleared' = TRUE /\ acks' = acks \cup {f}
             /\ UNCHANGED <<guest, requests, releasedBy>>
Release(f) == /\ (f.id = CompletionId(guest.connection) \/ Broken = "OldAck")
              /\ R!Acknowledge(guest.connection, guest.request, guest.terminator)
              /\ releasedBy' = f.socket /\ UNCHANGED <<requests, acks, cleared, activatedBy>>
Next == FirstLoss \/ SecondLoss \/ Replay \/ Submit \/ (\E f \in requests : Accept(f)) \/ (\E f \in acks : Release(f))
Safety == /\ R!Safety
          /\ (activatedBy # 0 => activatedBy = guest.connection /\ guest.authenticatedHost = 2)
          /\ (guest.connection > 1 /\ R!Ready => activatedBy = guest.connection /\ releasedBy = guest.connection)
\* Both ACKs exist: the first completion succeeded, its ACK was delayed across
\* another disconnect, and only the second completion released the guest.
NoSecondRecovery == ~(guest.connection = 3 /\ R!Ready /\ (\E f \in acks : f.socket = 2))
=============================================================================
