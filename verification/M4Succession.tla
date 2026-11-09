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
Disconnect(d) == /\ ~s.retired /\ d \in s.connected
                 /\ s' = [s EXCEPT !.connected = @ \ {d}]
Reconnect(d) == /\ ~s.retired /\ d \notin s.connected /\ d \notin s.fenced
                /\ s' = [s EXCEPT !.connected = @ \cup {d},
                                   !.grace = IF d = s.host THEN 0 ELSE @]
Grace == /\ ~s.retired /\ s.host \notin s.connected /\ s.grace = 0
         /\ s' = [s EXCEPT !.grace = 1]
Fence == /\ ~s.retired /\ s.host \notin s.connected /\ s.grace = 1
         /\ s.host \notin s.fenced
         /\ s' = [s EXCEPT !.fenced = @ \cup {s.host}]
Eligible == (s.policy \cap s.connected) \ s.attempted
Offer == /\ ~s.retired /\ s.host \in s.fenced /\ s.offered = 0
         /\ s.policyHost = s.host /\ Eligible # {}
         /\ LET d == CHOOSE x \in Eligible : \A y \in Eligible : x <= y IN
            s' = [s EXCEPT !.offered = d, !.attempted = @ \cup {d},
                               !.choice = "none", !.signedBy = 0, !.storedChoice = FALSE]
Choose(c, d) == /\ ~s.retired /\ s.offered # 0 /\ s.choice = "none"
                /\ c \in {"accept", "reject"} /\ d \in {2, 3}
                /\ (d = s.offered \/ Broken = "Target")
                /\ d \in s.connected
                /\ s' = [s EXCEPT !.choice = c, !.signedBy = d, !.storedChoice = TRUE]
CommitAcceptance == /\ ~s.retired /\ s.choice = "accept" /\ s.storedChoice
                    /\ s.offered # 0 /\ s.switches < MaxOps
                    /\ (s.signedBy = s.offered \/ Broken = "Target")
                    /\ s.signedBy \in s.connected
                    /\ s' = [s EXCEPT !.host = s.signedBy, !.consent = @ \cup {s.signedBy},
                                       !.badTarget = @ \/ (s.signedBy # s.offered),
                                       !.policyHost = 0, !.policy = {}, !.offered = 0,
                                       !.choice = "none", !.removal = TRUE,
                                       !.removeStored = FALSE, !.removeAcked = FALSE,
                                       !.grace = 0, !.switches = @ + 1]
Refuse == /\ ~s.retired /\ s.offered # 0 /\ s.choice = "reject"
          /\ s' = [s EXCEPT !.offered = 0, !.choice = "none"]
ExpireOffer == /\ ~s.retired /\ s.offered # 0
               /\ s' = [s EXCEPT !.offered = 0, !.choice = "none", !.storedChoice = FALSE]
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
Collapse == /\ ~s.retired /\ s.host \in s.fenced /\ s.offered = 0
            /\ (s.policyHost # s.host \/ Eligible = {})
            /\ s' = [s EXCEPT !.retired = TRUE, !.connected = {}, !.offered = 0]
Next == (\E d \in {1, 2, 3} : Disconnect(d) \/ Reconnect(d)) \/ Grace \/ Fence
        \/ Offer \/ (\E c \in {"accept", "reject"}, d \in {2, 3} : Choose(c, d))
        \/ CommitAcceptance \/ Refuse \/ ExpireOffer \/ StoreRemove \/ AckRemove
        \/ CompleteRemove \/ PublishPolicy \/ Collapse
Safety == /\ ~s.badTarget /\ s.policyHost \in {0, s.host}
          /\ (s.host # 1 => s.host \in s.consent)
          /\ (s.removeAcked => s.removeStored)
          /\ (s.retired => s.connected = {} /\ s.offered = 0)
          /\ (s.offered # 0 => s.offered \in s.attempted /\ s.policyHost = s.host)
=============================================================================
