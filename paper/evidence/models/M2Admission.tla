--------------------------- MODULE M2Admission ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
vars == <<s>>
Init == s = [phase |-> "none", key |-> 0, used |-> {}, authorized |-> FALSE,
             addStored |-> FALSE, welcome |-> FALSE, proof |-> FALSE,
             active |-> FALSE, removal |-> FALSE, ambiguous |-> FALSE,
             reused |-> FALSE, down |-> FALSE, room |-> 1, admission |-> 1]
Quiescent == s.phase \in {"none", "active", "retired"} /\ ~s.removal
Request(k) == /\ ~s.removal /\ s.phase \in {"none", "retired"} /\ k \in 1..MaxOps
              /\ (k \notin s.used \/ Broken = "KeyReuse")
              /\ s' = [s EXCEPT !.phase = "pending", !.key = k,
                                 !.reused = @ \/ (k \in s.used),
                                 !.authorized = FALSE, !.addStored = FALSE,
                                 !.welcome = FALSE, !.proof = FALSE,
                                 !.active = FALSE, !.ambiguous = TRUE]
Authorize == /\ ~s.down /\ s.phase = "pending"
             /\ s' = [s EXCEPT !.authorized = TRUE, !.phase = "authorized"]
StoreAdd == /\ ~s.down /\ s.phase = "authorized"
            /\ s' = [s EXCEPT !.addStored = TRUE, !.used = @ \cup {s.key}, !.phase = "add"]
Welcome == /\ ~s.down /\ s.phase = "add"
           /\ s' = [s EXCEPT !.welcome = TRUE, !.phase = "welcome"]
Bootstrap == /\ ~s.down /\ s.phase = "welcome"
             /\ s' = [s EXCEPT !.phase = "bootstrap"]
Prove(room, admission) == /\ ~s.down /\ s.phase = "bootstrap"
                         /\ room = s.room /\ admission = s.admission
                         /\ s' = [s EXCEPT !.proof = TRUE, !.phase = "proof"]
Activate == /\ ~s.down /\ s.phase = "proof"
            /\ s' = [s EXCEPT !.active = TRUE, !.phase = "active", !.ambiguous = FALSE]
Expire == /\ s.phase \in {"pending", "authorized", "add", "welcome", "bootstrap", "proof"}
          /\ s' = [s EXCEPT !.phase = "retired", !.active = FALSE,
                             !.removal = s.addStored, !.ambiguous = FALSE]
Remove == /\ s.removal /\ s' = [s EXCEPT !.removal = FALSE]
Leave == /\ s.active /\ s' = [s EXCEPT !.phase = "retired", !.active = FALSE, !.removal = TRUE]
Crash == /\ ~s.down /\ s' = [s EXCEPT !.down = TRUE]
Restore == /\ s.down /\ s' = [s EXCEPT !.down = FALSE]
Next == (\E k \in 1..MaxOps : Request(k)) \/ Authorize \/ StoreAdd \/ Welcome
        \/ Bootstrap \/ (\E r, a \in {1, 2} : Prove(r, a)) \/ Activate
        \/ Expire \/ Remove \/ Leave \/ Crash \/ Restore
Safety == /\ (s.active => s.authorized /\ s.addStored /\ s.welcome /\ s.proof)
          /\ (s.welcome => s.addStored)
          /\ ~s.reused
          /\ (s.phase \in {"pending", "authorized", "add", "welcome", "bootstrap", "proof"} => ~s.active)
=============================================================================
