------------------------- MODULE M3ResumeProof -------------------------
EXTENDS M3Resume, TLAPS

Ind == /\ DOMAIN s = {"phase", "connection", "request", "terminator", "persisted", "reconciled", "snapshotHost", "authenticatedHost", "sent", "acknowledged", "down"}
       /\ Safety
       /\ (s.phase \in {"snapshot", "terminator", "complete", "waiting"} => s.persisted)
       /\ (s.phase \in {"terminator", "complete", "waiting"} => s.reconciled)
       /\ (s.phase = "waiting" => s.sent)

THEOREM Initial == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init => Ind
  BY Z3 DEF Init, Ind, Safety

THEOREM Preserved == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None", Ind PROVE Next => Ind'
<1>1. Disconnect => Ind'
  BY Z3 DEF Ind, Safety, Disconnect, Ready
<1>2. Begin => Ind'
  BY Z3 DEF Ind, Safety, Begin, BeginAt
<1>3. PersistPrefix => Ind'
  BY Z3 DEF Ind, Safety, PersistPrefix, PersistPrefixWith
<1>4. \A h \in {1, 2} : Snapshot(h) => Ind'
  BY Z3 DEF Ind, Safety, Snapshot
<1>5. \A t \in {1, 2} : ObserveEnd(t) => Ind'
  BY Z3 DEF Ind, Safety, ObserveEnd
<1>6. SendCompletion => Ind'
  BY Z3 DEF Ind, Safety, SendCompletion
<1>7. \A c \in {1, 2}, q \in {1, 2}, t \in {1, 2} : Acknowledge(c, q, t) => Ind'
  BY Z3 DEF Ind, Safety, Acknowledge
<1>8. Crash => Ind'
  BY Z3 DEF Ind, Safety, Crash
<1>9. Restore => Ind'
  BY Z3 DEF Ind, Safety, Restore
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6, <1>7, <1>8, <1>9 DEF Next

THEOREM Safe == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init /\ [][Next]_vars => []Safety
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1> QED BY <1>1, <1>2, <1>3, PTL
=============================================================================
