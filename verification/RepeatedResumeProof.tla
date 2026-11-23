------------------------ MODULE RepeatedResumeProof ------------------------
EXTENDS RepeatedResume, TLAPS

\* The wire retains every emitted completion and receipt. Older entries are
\* never purged to make a replacement appear safe.
Phases == {"ready", "disconnected", "replay", "snapshot", "terminator", "complete", "waiting"}
GuestOK == /\ DOMAIN guest = {"phase", "connection", "request", "terminator", "persisted", "reconciled", "snapshotHost", "authenticatedHost", "sent", "acknowledged", "down"}
           /\ guest.connection \in Nat /\ guest.connection >= 1 /\ guest.phase \in Phases
           /\ (guest.connection = 1 => guest.phase = "ready")
           /\ (guest.phase \in {"disconnected", "replay", "snapshot"} => ~guest.reconciled /\ ~guest.sent /\ ~guest.acknowledged)
           /\ (guest.phase \in {"snapshot", "terminator", "complete", "waiting"} => guest.persisted /\ guest.authenticatedHost = 2)
           /\ (guest.phase \in {"terminator", "complete", "waiting"} => guest.reconciled)
           /\ (guest.phase = "waiting" => guest.sent)
MessageOK == /\ acks \subseteq requests
             /\ \A f \in requests : /\ f.socket \in 2..guest.connection /\ f.id = CompletionId(f.socket)
                                     /\ (f.socket = guest.connection => guest.sent /\ guest.authenticatedHost = 2)
             /\ \A f \in acks : f.socket = guest.connection => activatedBy = guest.connection
Ind == /\ Safety /\ GuestOK /\ MessageOK
       /\ (cleared => guest.authenticatedHost = 2)
       /\ (activatedBy # 0 => cleared)
       /\ (releasedBy # 0 => releasedBy = activatedBy /\ releasedBy = guest.connection)

THEOREM Initial == Init => Ind
  BY Z3 DEF Init, R!Init, R!Ready, R!Safety, Safety, GuestOK, Phases, MessageOK, Ind

THEOREM Preserved == ASSUME Broken = "None", Ind PROVE Next => Ind'
<1>1. Replace => Ind'
  BY Z3 DEF Replace, R!Disconnect, Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK
<1>2. Replay => Ind'
  <2> SUFFICES ASSUME Replay PROVE Ind' OBVIOUS
  <2>1. UNCHANGED <<requests, acks, cleared, activatedBy, releasedBy>> BY DEF Replay
  <2>2. R!BeginAt(Tail) => Ind'
    BY <2>1, Z3 DEF Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK, R!BeginAt
  <2>3. R!PersistPrefixWith(IF cleared THEN guest.authenticatedHost ELSE 2) => Ind'
    BY <2>1, Z3 DEF Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK, R!PersistPrefixWith
  <2>4. R!Snapshot(2) => Ind'
    BY <2>1, Z3 DEF Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK, R!Snapshot
  <2>5. R!ObserveEnd(guest.terminator) => Ind'
    BY <2>1, Z3 DEF Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK, R!ObserveEnd
  <2> QED BY <2>2, <2>3, <2>4, <2>5 DEF Replay
<1>3. Submit => Ind'
  BY Z3 DEF Submit, R!SendCompletion, Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK, CompletionId
<1>4. \A f \in requests : Accept(f) => Ind'
  BY Z3 DEF Accept, Ind, Safety, R!Safety, R!Ready, GuestOK, MessageOK
<1>5. \A f \in acks : Release(f) => Ind'
  <2> SUFFICES ASSUME NEW f \in acks, Release(f) PROVE Ind' OBVIOUS
  <2>1. f.socket = guest.connection /\ activatedBy = guest.connection
    BY Z3 DEF Release, Ind, GuestOK, MessageOK, CompletionId
  <2> QED BY <2>1, Z3 DEF Release, R!Acknowledge, Ind, Safety, R!Safety, R!Ready, GuestOK, Phases, MessageOK
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5 DEF Next

vars == <<guest, requests, acks, cleared, activatedBy, releasedBy>>
THEOREM Safe == ASSUME Broken = "None" PROVE Init /\ [][Next]_vars => []Safety
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety, R!Safety, R!Ready, MessageOK, GuestOK
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1> QED BY <1>1, <1>2, <1>3, PTL
=============================================================================
