-------------------------- MODULE ReconnectRace ---------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken
VARIABLE s
\* Both sockets were lost while nobody was eligible. A and B are the old
\* and replacement host sockets; the guest must complete authenticated replay.
Init == s = [host |-> 1, socket |-> "none", guest |-> "offline", fenced |-> FALSE,
             staleClosed |-> FALSE, badClose |-> FALSE, badCandidate |-> FALSE,
             offer |-> 0, next |-> 2, signed |-> 0, visible |-> 0, now |-> 0,
             until |-> 0, issued |-> 0, restored |-> FALSE, declined |-> FALSE]
Prompt(x) == IF x.host = 1 /\ x.socket = "none" /\ x.next = 2 /\ x.offer = 0 /\
                (x.guest = "active" \/ (Broken = "EarlyCandidate" /\ x.guest = "replaying"))
             THEN [x EXCEPT !.fenced = TRUE, !.offer = 2, !.next = 3,
                      !.issued = x.now, !.until = x.now+2, !.badCandidate = x.guest # "active"] ELSE x
ReopenHost == /\ ~s.fenced /\ s.socket = "none" /\ s.host = 1
              /\ s' = [s EXCEPT !.socket = "B"]
StaleClose == /\ s.socket = "B" /\ ~s.staleClosed
              /\ s' = Prompt([s EXCEPT !.staleClosed = TRUE, !.badClose = Broken = "StaleClose",
                              !.socket = IF Broken = "StaleClose" THEN "none" ELSE @])
GuestBegin == /\ s.guest = "offline" /\ s' = Prompt([s EXCEPT !.guest = "replaying"])
GuestComplete == /\ s.guest = "replaying" /\ s' = Prompt([s EXCEPT !.guest = "active"])
Advance == /\ s.now < 4 /\ s' = [s EXCEPT !.now = @+1]
Restart == /\ s.offer = 2 /\ s.visible = 0 /\ s.signed = 0 /\ ~s.restored
           /\ s' = [s EXCEPT !.restored = TRUE, !.visible = 0,
                        !.until = IF Broken = "RenewOffer" THEN s.now+2 ELSE @]
Deliver == /\ s.offer # 0 /\ s.now < s.until /\ s.visible = 0 /\ s' = [s EXCEPT !.visible = s.offer]
Choose == /\ s.offer # 0 /\ s.visible = s.offer /\ s.now < s.until /\ s.signed = 0
          /\ s' = [s EXCEPT !.signed = s.offer]
Accept == /\ s.offer # 0 /\ s.signed = s.offer /\ s.now < s.until
          /\ s' = [s EXCEPT !.host = s.signed, !.offer = 0, !.visible = 0]
\* Device 3 is eligible at the later refusal/expiry cut in this focused model.
NextOffer == /\ s.offer # 0 /\ (s.now >= s.until \/ (s.visible = s.offer /\ s.signed = 0))
             /\ s' = [s EXCEPT !.offer = IF s.offer = 2 THEN 3 ELSE 0, !.next = 0,
                   !.host = IF s.offer = 3 THEN 0 ELSE @, !.signed = 0, !.visible = 0,
                   !.issued = s.now, !.until = s.now+2,
                   !.declined = @ \/ (s.offer = 2 /\ s.now < s.until /\ s.visible = 2)]
Next == ReopenHost \/ StaleClose \/ GuestBegin \/ GuestComplete \/ Advance \/ Restart \/ Deliver \/ Choose \/ Accept \/ NextOffer
Safety == /\ ~s.badClose /\ ~s.badCandidate
          /\ (s.fenced => s.socket = "none") /\ (s.socket = "B" => s.host = 1 /\ s.offer = 0)
          /\ (s.offer # 0 => s.host = 1 /\ s.fenced /\ s.until = s.issued+2)
          /\ (s.host \in {2,3} => s.host = s.signed /\ s.offer = 0)
NoHostReturned == ~(s.socket = "B" /\ s.guest = "active" /\ s.staleClosed)
NoGuestWon == ~(s.offer = 2 /\ s.fenced /\ s.signed = 0)
NoReplayedOffer == ~(s.host = 2 /\ s.restored /\ s.signed = 2)
NoRefusalAdvanced == ~(s.host = 3 /\ s.declined /\ s.restored)
=============================================================================
