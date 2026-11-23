------------------------- MODULE M2AdmissionProof -------------------------
EXTENDS M2Admission, TLAPS

Ind == /\ DOMAIN s = {"phase", "key", "used", "authorized", "addStored", "welcome", "proof", "active", "removal", "ambiguous", "reused", "down", "room", "admission"}
       /\ Safety
       /\ (s.phase \in {"authorized", "add", "welcome", "bootstrap", "proof"} => s.authorized)
       /\ (s.phase \in {"add", "welcome", "bootstrap", "proof"} => s.addStored)
       /\ (s.phase \in {"welcome", "bootstrap", "proof"} => s.welcome)
       /\ (s.phase = "proof" => s.proof)

THEOREM Initial == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init => Ind
  BY Z3 DEF Init, Ind, Safety

THEOREM Preserved == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None", Ind PROVE Next => Ind'
<1>1. \A k \in 1..MaxOps : Request(k) => Ind'
  BY Z3 DEF Ind, Safety, Request
<1>2. Authorize => Ind'
  BY Z3 DEF Ind, Safety, Authorize
<1>3. StoreAdd => Ind'
  BY Z3 DEF Ind, Safety, StoreAdd
<1>4. Welcome => Ind'
  BY Z3 DEF Ind, Safety, Welcome
<1>5. Bootstrap => Ind'
  BY Z3 DEF Ind, Safety, Bootstrap
<1>6. \A r \in {1, 2}, a \in {1, 2} : Prove(r, a) => Ind'
  BY Z3 DEF Ind, Safety, Prove
<1>7. Activate => Ind'
  BY Z3 DEF Ind, Safety, Activate
<1>8. Expire => Ind'
  BY Z3 DEF Ind, Safety, Expire
<1>9. Remove => Ind'
  BY Z3 DEF Ind, Safety, Remove
<1>10. Leave => Ind'
  BY Z3 DEF Ind, Safety, Leave
<1>11. Crash => Ind'
  BY Z3 DEF Ind, Safety, Crash
<1>12. Restore => Ind'
  BY Z3 DEF Ind, Safety, Restore
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6, <1>7, <1>8, <1>9, <1>10, <1>11, <1>12 DEF Next

THEOREM Safe == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init /\ [][Next]_vars => []Safety
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1> QED BY <1>1, <1>2, <1>3, PTL
=============================================================================
