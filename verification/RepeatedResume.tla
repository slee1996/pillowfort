---------------------------- MODULE RepeatedResume ----------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken, SocketLimit
VARIABLES guest, requests, acks, cleared, activatedBy, releasedBy
R == INSTANCE M3Resume WITH s <- guest

\* Start at the cut explored by ResumeAcrossSuccession: while the ordinary
\* guest is away, host 2 succeeds host 1. Its signed acceptance is retained
\* until the relay accepts a complete replay. Until then, any number of replacement
\* sockets can receive the same nonempty terminator. Even IDs denote empty cuts;
\* 1 denotes the retained acceptance. A completion ID is fresh per incarnation.
Tail == IF cleared THEN 2 * guest.connection ELSE 1
CompletionId(c) == 2 * c + 1
Init == R!Init /\ requests = {} /\ acks = {} /\ cleared = FALSE
        /\ activatedBy = 0 /\ releasedBy = 0

Replace == /\ R!Disconnect /\ activatedBy' = 0 /\ releasedBy' = 0
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
Next == Replace \/ Replay \/ Submit \/ (\E f \in requests : Accept(f)) \/ (\E f \in acks : Release(f))
Safety == /\ R!Safety
          /\ (activatedBy # 0 => activatedBy = guest.connection /\ guest.authenticatedHost = 2)
          /\ (guest.connection > 1 /\ R!Ready => activatedBy = guest.connection /\ releasedBy = guest.connection)
\* Both ACKs exist: the first completion succeeded, its ACK was delayed across
\* another disconnect, and only the second completion released the guest.
NoSecondRecovery == ~(guest.connection = 3 /\ R!Ready /\ (\E f \in acks : f.socket = 2))
NoFourthReplacement == ~(guest.connection = 5 /\ R!Ready /\ activatedBy = 5 /\ releasedBy = 5
                         /\ \A c \in 2..4 : \E f \in acks : f.socket = c)
=============================================================================
