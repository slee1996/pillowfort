--------------------------- MODULE M4Succession ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
vars == <<s>>
Init == s = [host |-> 1, connected |-> {1, 2, 3}, policyHost |-> 1,
             policy |-> {2, 3}, attempted |-> {}, offered |-> 0,
             choice |-> "none", signedBy |-> 0, storedChoice |-> FALSE,
             grace |-> 0, fenced |-> {}, removal |-> FALSE,
             removeStored |-> FALSE, removeAcked |-> FALSE,
             retired |-> FALSE, switches |-> 0, consent |-> {},
             badTarget |-> FALSE]
Available == ~s.retired /\ s.host \in s.connected /\ ~s.removal /\ s.offered = 0
EligibleAt(x) == IF x.policyHost = x.host THEN (x.policy \cap x.connected) \ x.attempted ELSE {}
\* Normalize inside the committing transition; there is no schedulable gap in
\* which the old host could resume between loss, fencing, and a prompt offer.
First(eligible) == CHOOSE v \in eligible : \A y \in eligible : v <= y
Select(x) == LET eligible == EligibleAt(x) IN
             IF x.offered # 0 THEN x
             ELSE IF eligible = {} THEN [x EXCEPT !.retired = TRUE, !.connected = {}]
             ELSE LET d == First(eligible) IN
                  [x EXCEPT !.offered = d, !.attempted = @ \cup {d},
                            !.choice = "none", !.signedBy = 0, !.storedChoice = FALSE]
AtLoss(x) == IF x.host \notin x.connected /\ x.host \notin x.fenced /\ EligibleAt(x) # {}
                /\ Broken # "DelayedOffer"
             THEN Select([x EXCEPT !.fenced = @ \cup {x.host}]) ELSE x
Disconnect(d) == /\ ~s.retired /\ d \in s.connected
                 /\ s' = AtLoss([s EXCEPT !.connected = @ \ {d}])
\* Host ownership starts with authenticated resume. Other members become
\* candidates only on exact replay completion; ReconnectRace expands these cuts.
Reconnect(d) == /\ ~s.retired /\ d \notin s.connected /\ d \notin s.fenced
                /\ s' = AtLoss([s EXCEPT !.connected = @ \cup {d},
                                     !.grace = IF d = s.host THEN 0 ELSE @])
Grace == /\ ~s.retired /\ s.host \notin s.connected /\ s.host \notin s.fenced
         /\ EligibleAt(s) = {} /\ s' = Select([s EXCEPT !.fenced = @ \cup {s.host}, !.grace = 1])
Choose(c, d) == /\ ~s.retired /\ s.offered # 0 /\ s.choice = "none"
                /\ c \in {"accept", "reject"} /\ d \in {2, 3}
                /\ (d = s.offered \/ Broken = "Target")
                /\ d \in s.connected
                /\ s' = [s EXCEPT !.choice = c, !.signedBy = d, !.storedChoice = TRUE]
AfterConsent(x) == [x EXCEPT !.host = x.signedBy, !.consent = x.consent \cup {x.signedBy},
                                       !.badTarget = x.badTarget \/ (x.signedBy # x.offered),
                                       !.policyHost = 0, !.policy = {}, !.offered = 0,
                                       !.choice = "none", !.removal = TRUE,
                                       !.removeStored = FALSE, !.removeAcked = FALSE,
                                       !.grace = 0, !.switches = x.switches + 1]
CommitAcceptance == /\ ~s.retired /\ s.choice = "accept" /\ s.storedChoice
                    /\ s.offered # 0 /\ s.switches < MaxOps
                    /\ (s.signedBy = s.offered \/ Broken = "Target")
                    /\ s.signedBy \in s.connected
                    /\ s' = AfterConsent(s)
Refuse == /\ ~s.retired /\ s.offered # 0 /\ s.choice = "reject"
          /\ s' = Select([s EXCEPT !.offered = 0, !.choice = "none"])
ExpireOffer == /\ ~s.retired /\ s.offered # 0
               /\ s' = Select([s EXCEPT !.offered = 0, !.choice = "none", !.storedChoice = FALSE])
StoreRemove == /\ ~s.retired /\ s.host \in s.connected /\ s.removal /\ ~s.removeStored
               /\ s' = [s EXCEPT !.removeStored = TRUE]
AckRemove == /\ ~s.retired /\ s.removeStored /\ ~s.removeAcked
             /\ s' = [s EXCEPT !.removeAcked = TRUE]
CompleteRemove == /\ ~s.retired /\ s.removeAcked /\ s.removal
                  /\ s' = [s EXCEPT !.removal = FALSE]
PublishPolicy == /\ Available /\ s.policyHost = 0
                 /\ s' = [s EXCEPT !.policyHost = s.host,
                                    !.policy = {2, 3} \ (s.fenced \cup {s.host}),
                                    !.attempted = {}]
Next == (\E d \in {1, 2, 3} : Disconnect(d) \/ Reconnect(d)) \/ Grace
        \/ (\E c \in {"accept", "reject"}, d \in {2, 3} : Choose(c, d))
        \/ CommitAcceptance \/ Refuse \/ ExpireOffer \/ StoreRemove \/ AckRemove
        \/ CompleteRemove \/ PublishPolicy
Safety == /\ (~s.retired /\ s.host \notin s.connected /\ EligibleAt(s) # {} =>
                s.host \in s.fenced /\ s.offered # 0)
          /\ ~s.badTarget /\ s.policyHost \in {0, s.host}
          /\ (s.host # 1 => s.host \in s.consent)
          /\ (s.removeAcked => s.removeStored)
          /\ (s.retired => s.connected = {} /\ s.offered = 0)
          /\ (s.offered # 0 => s.offered \in s.attempted /\ s.policyHost = s.host)
=============================================================================
