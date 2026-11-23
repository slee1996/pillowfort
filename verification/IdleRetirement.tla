-------------------------- MODULE IdleRetirement --------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
\* <<device, connection, authenticated>>. The last three candidates each
\* violate exactly one binding; a replacement socket never inherits a notice.
Owners == {<<1,1,TRUE>>, <<2,2,TRUE>>}
Sockets == Owners \cup {<<3,1,TRUE>>, <<1,3,TRUE>>, <<1,1,FALSE>>}
Matches(p) == \E original \in Owners :
    /\ (p[1] = original[1] \/ Broken = "AnyDevice")
    /\ (p[2] = original[2] \/ Broken = "AnyConnection")
    /\ (p[3] \/ Broken = "Unauthenticated")
Init == s = [retired |-> FALSE, marker |-> FALSE, phase |-> "live", todo |-> {},
             restarted |-> FALSE, afterOne |-> FALSE, gone |-> {}, sent |-> {}, seen |-> {}]
Delete == /\ ~s.retired
          /\ s' = [s EXCEPT !.retired = TRUE, !.marker = Broken # "NoMarker",
                    !.phase = "run", !.todo = Sockets]
Restart == /\ s.retired /\ s.phase = "run" /\ ~s.restarted
           /\ s' = [s EXCEPT !.restarted = TRUE, !.afterOne = Cardinality(s.sent) = 1,
                     !.phase = IF ~s.marker THEN "done" ELSE IF Broken = "NoWake" THEN "asleep" ELSE "run",
                     !.todo = IF s.marker THEN Sockets ELSE {}]
Drain == /\ s.phase = "run"
         /\ IF s.todo = {} THEN s' = [s EXCEPT !.phase = "done", !.marker = FALSE]
            ELSE \E p \in s.todo : s' = [s EXCEPT !.todo = @ \ {p},
                   !.sent = IF p \notin s.gone /\ Matches(p) THEN @ \cup {p} ELSE @]
Drop == \E p \in Owners \ s.gone : s' = [s EXCEPT !.gone = @ \cup {p}]
Observe == \E p \in (s.sent \ s.seen) \ s.gone : s' = [s EXCEPT !.seen = @ \cup {p}]
Next == Delete \/ Restart \/ Drain \/ Drop \/ Observe
Spec == Init /\ [][Next]_s /\ WF_s(Drain)
Safety == /\ s.sent \subseteq Owners /\ s.seen \subseteq s.sent
          /\ (s.sent # {} => s.retired)
          /\ (s.phase = "done" => Owners \ s.gone \subseteq s.sent)
AttachedProgress == s.retired ~> (Owners \ s.gone \subseteq s.sent)
NoRecoveredPrefix == ~(s.afterOne /\ s.phase = "done" /\ s.seen = Owners)
===========================================================================
