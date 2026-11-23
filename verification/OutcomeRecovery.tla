------------------------------ MODULE OutcomeRecovery -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
Tokens == 1..MaxOps
Verdicts == {"accepted", "rejected"}
Init == s = [next |-> 1, pending |-> 0, wire |-> 0, receipt |-> 0,
    first |-> [i \in Tokens |-> "none"], relay |-> [i \in Tokens |-> "none"],
    done |-> [i \in Tokens |-> "none"], sent |-> {}, application |-> {},
    generation |-> 0, down |-> FALSE, restoredRejected |-> FALSE]
\* A token denotes one immutable application ciphertext. Preparation stores the
\* advanced MLS generation and a reversible application mutation in one write.
Prepare == /\ ~s.down /\ s.pending = 0 /\ s.next \in Tokens
           /\ s' = [s EXCEPT !.pending = s.next, !.next = @+1,
                   !.generation = @+1, !.application = @ \cup {s.next}]
Send == /\ ~s.down /\ s.pending # 0 /\ s.wire = 0
        /\ s' = [s EXCEPT !.wire = s.pending, !.sent = @ \cup {s.pending}]
Commit(v) == /\ s.wire # 0 /\ v \in Verdicts
             /\ (s.relay[s.wire] = "none" \/ Broken = "Rewrite")
             /\ s' = [s EXCEPT !.first[s.wire] = IF @ = "none" THEN v ELSE @,
                     !.relay[s.wire] = v, !.wire = 0]
Deliver(i) == /\ i \in Tokens /\ s.relay[i] \in Verdicts /\ s.receipt = 0
              /\ s' = [s EXCEPT !.receipt = i]
Apply == /\ ~s.down /\ s.receipt # 0 /\ s.pending # 0
         /\ (s.receipt = s.pending \/ Broken = "OtherOutcome")
         /\ LET v == s.relay[s.receipt] IN
            s' = [s EXCEPT !.done[s.pending] = v, !.pending = 0, !.receipt = 0,
                  !.application = IF v = "rejected" THEN @ \ {s.pending} ELSE @,
                  !.generation = IF v = "rejected" /\ Broken = "RewindRatchet" THEN @-1 ELSE @]
Lose == /\ (s.wire # 0 \/ s.receipt # 0)
        /\ s' = [s EXCEPT !.wire = 0, !.receipt = 0]
Crash == /\ ~s.down /\ s' = [s EXCEPT !.down = TRUE, !.wire = 0, !.receipt = 0]
Restore == /\ s.down /\ s' = [s EXCEPT !.down = FALSE,
                        !.restoredRejected = @ \/ (IF s.pending = 0 THEN FALSE ELSE s.relay[s.pending] = "rejected")]
Next == Prepare \/ Send \/ (\E v \in Verdicts : Commit(v)) \/ (\E i \in Tokens : Deliver(i)) \/ Apply \/ Lose \/ Crash \/ Restore
Safety == /\ s.generation = s.next-1
          /\ \A i \in Tokens : /\ s.relay[i] = s.first[i]
                              /\ (s.done[i] # "none" => s.done[i] = s.first[i] /\ i \in s.sent)
                              /\ (i \in s.application <=> i = s.pending \/ s.done[i] = "accepted")
NoRecoveredRejection == ~(s.restoredRejected /\ s.done[1] = "rejected" /\ s.done[2] = "accepted" /\ s.generation = 2)
=============================================================================
