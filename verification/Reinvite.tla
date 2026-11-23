------------------------------- MODULE Reinvite -------------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
\* Host numbers denote exact room/device/credential triples, not display names.
\* Delayed duplicate receipts remain possible. The first offer is declined;
\* the second may be explicitly accepted. A fresh guest retains its invitation
\* anchor with the KeyPackage, including across a crash before activation.
Init == s = [host |-> 1, issued |-> 0, offer |-> 0, declined |-> FALSE,
             consumed |-> FALSE, replayed |-> FALSE, wrongCancel |-> FALSE,
             caught |-> FALSE, phase |-> "idle", anchor |-> 0, loaded |-> 0,
             stored |-> 0, restarted |-> FALSE, approved |-> FALSE, signedBy |-> 0]
Offer == /\ s.host = 1 /\ s.offer = 0 /\ s.issued < 2
         /\ s' = [s EXCEPT !.issued = @ + 1, !.offer = s.issued + 1]
Decline == /\ s.offer = 1 /\ ~s.declined /\ s' = [s EXCEPT !.declined = TRUE]
Receipt == /\ s.declined /\ s.offer # 0
           /\ IF s.offer = 1 THEN s' = [s EXCEPT !.offer = 0, !.consumed = TRUE]
              ELSE s' = [s EXCEPT !.replayed = TRUE,
                         !.offer = IF Broken = "CancelNew" THEN 0 ELSE @,
                         !.wrongCancel = Broken = "CancelNew"]
Catch == /\ s.offer = 2 /\ s.replayed /\ s' = [s EXCEPT !.caught = TRUE, !.offer = 0, !.host = 2]
Choose(k) == /\ s.phase = "idle" /\ s.host = 2
             /\ s' = [s EXCEPT !.phase = "pending", !.anchor = k, !.loaded = k, !.stored = k]
Crash == /\ s.phase = "pending" /\ ~s.restarted
         /\ s' = [s EXCEPT !.phase = "restoring", !.loaded = 0]
Restore(k) == /\ s.phase = "restoring"
              /\ s' = [s EXCEPT !.phase = "pending", !.restarted = TRUE,
                                  !.loaded = IF Broken = "ReplacePin" THEN k ELSE s.stored]
\* Relay availability and explicit host approval are separate from a guest's
\* independent verification. Model a usable Welcome both with and without the
\* former host still present; the initial snapshot must be signed by the anchor.
Approve == /\ s.phase = "pending" /\ s.loaded = s.host
           /\ s' = [s EXCEPT !.phase = "approved", !.approved = TRUE]
Welcome(roster) == /\ s.phase = "approved" /\ s.loaded \in roster
                   /\ s' = [s EXCEPT !.phase = "joined"]
Bootstrap(k) == /\ s.phase = "joined" /\ (k = s.loaded \/ Broken = "OtherSigner")
                /\ s' = [s EXCEPT !.phase = "active", !.signedBy = k]
Next == Offer \/ Decline \/ Receipt \/ Catch \/ (\E k \in 1..2 : Choose(k)) \/ Crash
        \/ (\E k \in 1..2 : Restore(k)) \/ Approve \/ (\E r \in {{2, 3}, {1, 2, 3}} : Welcome(r))
        \/ (\E k \in {2, 3} : Bootstrap(k))
Safety == /\ ~s.wrongCancel /\ (s.host # 1 => s.caught /\ s.consumed)
          /\ (s.phase = "active" => s.approved /\ s.signedBy = s.anchor /\ s.signedBy = s.host)
NoReinvitedGuest == ~(s.phase = "active" /\ s.replayed /\ s.restarted /\ s.host = 2)
=============================================================================
