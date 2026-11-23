------------------------------ MODULE HostPath ------------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
\* One host, one eligible guest, two socket incarnations, one stalled path.
\* Each Tick denotes a due alarm, not a fixed second. Fair scheduling is
\* assumed explicitly for the temporal property. A reply may arrive on either
\* side of the final deadline. A stale peer or an old socket is not proof.
Init == s = [owner |-> 1, socket |-> 1, phase |-> "quiet", round |-> 0,
             silent |-> FALSE, restarted |-> FALSE, moved |-> FALSE, wrong |-> FALSE,
             suspect |-> FALSE, accepted |-> FALSE, closed |-> FALSE]
Live == s.owner = 1 /\ ~s.suspect /\ ~s.closed
Tick == /\ Live
        /\ CASE s.phase = "quiet" -> s' = [s EXCEPT !.phase = "probe", !.round = 1-@]
              [] s.phase = "probe" -> s' = [s EXCEPT !.phase = "final"]
              [] OTHER -> s' = IF Broken = "NeverDetect" THEN [s EXCEPT !.phase = "quiet"]
                              ELSE [s EXCEPT !.suspect = TRUE, !.phase = "offered"]
Silence == Live /\ ~s.silent /\ s' = [s EXCEPT !.silent = TRUE]
Reply(socket, round, peer) == /\ Live /\ s.phase \in {"probe", "final"}
   /\ IF socket = s.socket /\ round = s.round /\ ~peer
        THEN /\ ~s.silent /\ s' = [s EXCEPT !.phase = "quiet"]
        ELSE /\ ((Broken = "OldSocket" /\ socket # s.socket) \/
                 (Broken = "WrongNonce" /\ round # s.round) \/ (Broken = "PeerReply" /\ peer))
             /\ s' = [s EXCEPT !.phase = "quiet", !.wrong = TRUE]
Replace == /\ Live /\ ~s.silent /\ ~s.moved
           /\ s' = [s EXCEPT !.socket = 2, !.moved = TRUE, !.phase = "quiet"]
Restart == /\ Live /\ ~s.restarted /\ s' = [s EXCEPT !.restarted = TRUE]
Accept == /\ s.suspect /\ s.owner = 1 /\ ~s.closed /\ s' = [s EXCEPT !.owner = 2, !.accepted = TRUE]
Decline == /\ s.suspect /\ s.owner = 1 /\ ~s.closed /\ s' = [s EXCEPT !.closed = TRUE]
Next == Tick \/ Silence \/ Replace \/ Restart \/ Accept \/ Decline \/
        (\E sock \in 1..2, n \in 0..1, peer \in BOOLEAN : Reply(sock, n, peer))
Spec == Init /\ [][Next]_s /\ WF_s(Tick)
Safety == ~s.wrong /\ (s.owner = 2 => s.suspect /\ s.accepted /\ ~s.closed)
SilentProgress == s.silent ~> s.suspect
NoFencedReturn == ~(s.moved /\ s.restarted /\ s.silent /\ s.suspect /\ s.accepted)
=============================================================================
