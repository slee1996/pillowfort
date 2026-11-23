----------------------- MODULE ResumeAcrossSuccession -----------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLES resume, succession, signer, cut, completedUnder
R == INSTANCE M3Resume WITH s <- resume
H == INSTANCE M4Succession WITH s <- succession

\* 1 is the departing host, 2 the willing successor, 3 the returning guest.
\* signer is the signed acceptance retained for replay, not the relay's host
\* assertion. Only CommitAcceptance appends it. One switch can change the tail
\* from the empty-backlog resume request (1) to the acceptance message (2).
Tail == IF signer = 0 THEN 1 ELSE 2
Init == R!Init /\ H!Init /\ signer = 0 /\ completedUnder = 0
        /\ cut = [signer |-> 0, host |-> 1]

HostStep == /\ (H!Disconnect(1) \/ H!Grace \/ H!Fence \/ H!Offer
                \/ H!Choose("accept", 2) \/ H!StoreRemove \/ H!AckRemove
                \/ H!CompleteRemove \/ H!PublishPolicy)
            /\ UNCHANGED <<resume, signer, cut, completedUnder>>
Handoff == /\ resume.connection = 2 /\ H!CommitAcceptance
           /\ signer' = succession.signedBy
           /\ UNCHANGED <<resume, cut, completedUnder>>

DisconnectGuest == /\ R!Disconnect /\ H!Disconnect(3)
                   /\ UNCHANGED <<signer, cut, completedUnder>>
BeginReplay == /\ R!BeginAt(Tail)
               /\ cut' = [signer |-> signer, host |-> succession.host]
               /\ UNCHANGED <<succession, signer, completedUnder>>
\* An omitted acceptance leaves the old authenticated view intact. A snapshot
\* may confirm that view or stop the resume; it cannot supply the signature.
PrefixViews == {resume.authenticatedHost} \cup (IF cut.signer = 0 THEN {} ELSE {cut.signer})
GuestStep == /\ ((\E h \in PrefixViews : R!PersistPrefixWith(h)) \/ R!Snapshot(cut.host)
                 \/ R!ObserveEnd(resume.terminator) \/ R!SendCompletion
                 \/ R!Crash \/ R!Restore)
             /\ UNCHANGED <<succession, signer, cut, completedUnder>>

\* The relay compares with its *current* backlog, not the captured prefix.
\* Store the authority at activation: a later handoff while the ACK is in
\* flight is legitimate and must not retroactively invalidate the activation.
RelayAccept == /\ resume.phase = "waiting" /\ completedUnder = 0
               /\ (resume.terminator = Tail \/ Broken = "StaleEnd")
               /\ H!Reconnect(3) /\ completedUnder' = succession.host
               /\ UNCHANGED <<resume, signer, cut>>
ReceiveAck == /\ completedUnder # 0
              /\ R!Acknowledge(resume.connection, resume.request, resume.terminator)
              /\ UNCHANGED <<succession, signer, cut, completedUnder>>

Next == HostStep \/ Handoff \/ DisconnectGuest \/ BeginReplay \/ GuestStep \/ RelayAccept \/ ReceiveAck
Safety == R!Safety /\ H!Safety
          /\ (completedUnder # 0 => resume.authenticatedHost = completedUnder)
          /\ (resume.acknowledged => completedUnder # 0)
\* Reachability probe, checked separately with all safety guards intact.
NoRecoveredGuest == ~(completedUnder = 2 /\ R!Ready /\ H!Available)
=============================================================================
