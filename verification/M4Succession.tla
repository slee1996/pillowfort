--------------------------- MODULE M4Succession ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxOps, Broken, RankLimit, InitialRanks, RosterChanges
VARIABLE s
vars == <<s>>
\* Semantic identity is the immutable positive admission ordinal, not a device ID.
Ranks == 1..RankLimit
Guests == 2..RankLimit
Init == s = [host |-> 1, high |-> InitialRanks, admitted |-> 1..InitialRanks,
             connected |-> 1..InitialRanks, policyHost |-> 1,
             policy |-> 2..InitialRanks, attempted |-> {}, offered |-> 0,
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
             ELSE IF eligible = {} THEN [x EXCEPT !.retired = TRUE, !.host = 0, !.connected = {},
                                         !.admitted = {}, !.policyHost = 0, !.policy = {}]
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
Reconnect(d) == /\ ~s.retired /\ d \in s.admitted /\ d \notin s.connected /\ d \notin s.fenced
                /\ s' = AtLoss([s EXCEPT !.connected = @ \cup {d},
                                     !.grace = IF d = s.host THEN 0 ELSE @])
Grace == /\ ~s.retired /\ s.host \notin s.connected /\ s.host \notin s.fenced
         /\ EligibleAt(s) = {} /\ s' = Select([s EXCEPT !.fenced = @ \cup {s.host}, !.grace = 1])
Choose(c, d) == /\ ~s.retired /\ s.offered # 0 /\ s.choice = "none"
                /\ c \in {"accept", "reject"} /\ d \in Guests
                /\ (d = s.offered \/ Broken = "Target")
                /\ d \in s.connected
                /\ s' = [s EXCEPT !.choice = c, !.signedBy = d, !.storedChoice = TRUE]
AfterConsent(x) == [x EXCEPT !.host = x.signedBy, !.consent = x.consent \cup {x.signedBy},
                                       !.admitted = x.admitted \ {x.host},
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
\* A fresh admission rank is never recycled, even after voluntary departure.
AdmitNext == /\ RosterChanges /\ Available /\ s.high < RankLimit
             /\ LET d == s.high + 1 IN
                s' = [s EXCEPT !.high = d, !.admitted = @ \cup {d}, !.connected = @ \cup {d}]
Withdraw(d) == /\ RosterChanges /\ Available /\ d \in s.admitted /\ d # s.host
               /\ s' = [s EXCEPT !.admitted = @ \ {d}, !.connected = @ \ {d}]
PolicyList == s.admitted \ (s.fenced \cup {s.host})
PublishPolicy == /\ Available /\ (s.policyHost = 0 \/ s.policy # PolicyList)
                 /\ s' = [s EXCEPT !.policyHost = s.host,
                                    !.policy = PolicyList,
                                    !.attempted = {}]
Next == (\E d \in Ranks : Disconnect(d) \/ Reconnect(d) \/ Withdraw(d)) \/ Grace
        \/ (\E c \in {"accept", "reject"}, d \in Guests : Choose(c, d))
        \/ CommitAcceptance \/ Refuse \/ ExpireOffer \/ StoreRemove \/ AckRemove
        \/ CompleteRemove \/ PublishPolicy \/ AdmitNext
Safety == /\ (~s.retired /\ s.host \notin s.connected /\ EligibleAt(s) # {} =>
                s.host \in s.fenced /\ s.offered # 0)
          /\ ~s.badTarget /\ s.policyHost \in {0, s.host}
          /\ (~s.retired /\ s.host # 1 => s.host \in s.consent)
          /\ (s.removeAcked => s.removeStored)
          /\ (s.retired => s.host = 0 /\ s.policyHost = 0 /\ s.policy = {} /\ s.connected = {} /\ s.offered = 0)
          /\ (s.offered # 0 => s.offered \in s.attempted /\ s.policyHost = s.host)
\* A trace property of the actual transition, not a guard on Next. Retiring clears
\* authority; every other change of validator must consume this very offer.
ConsentAtSwitch == ~s'.retired /\ s'.host # s.host =>
  /\ s.host \in s.fenced /\ s.policyHost = s.host /\ s.offered # 0
  /\ s.storedChoice /\ s.choice = "accept" /\ s.signedBy = s.offered
  /\ s'.host = s.signedBy /\ s'.policyHost = 0 /\ s'.offered = 0
  /\ s'.admitted = s.admitted \ {s.host}
\* Reachability probe, separate from Safety. Only an actual signed acceptance advances switches.
NoFourthHolder == ~(s.host = 4 /\ s.switches = 3 /\ ~s.removal /\ s.policyHost = 4)
=============================================================================
