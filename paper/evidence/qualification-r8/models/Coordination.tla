---------------------------- MODULE Coordination --------------------------
EXTENDS Naturals
CONSTANTS Capacity, MaxOps, Broken, Stage, MaxDepth
VARIABLES delivery, admission, resume, succession, depth, badInterlock
vars == <<delivery, admission, resume, succession, depth, badInterlock>>
D == INSTANCE M1Delivery WITH s <- delivery
A == INSTANCE M2Admission WITH s <- admission
R == INSTANCE M3Resume WITH s <- resume
H == INSTANCE M4Succession WITH s <- succession
Init == D!Init /\ A!Init /\ R!Init /\ H!Init /\ depth = 0 /\ badInterlock = FALSE
Allowed == (Stage < 2 \/ A!Quiescent) /\ (Stage < 3 \/ R!Ready) /\ (Stage < 4 \/ H!Available)
DeliveryStep == /\ (Broken = "Interlock" \/ Stage < 2 \/ A!Quiescent)
                /\ (Stage < 3 \/ R!Ready) /\ (Stage < 4 \/ H!Available)
                /\ D!Next
                /\ badInterlock' = (badInterlock \/ (delivery'.sent # delivery.sent /\ ~Allowed))
                /\ UNCHANGED <<admission, resume, succession>>
AdmissionStep == /\ Stage >= 2 /\ D!Quiescent
                 /\ (Stage < 3 \/ R!Ready) /\ (Stage < 4 \/ H!Available)
                 /\ A!Next /\ UNCHANGED <<delivery, resume, succession, badInterlock>>
ResumeStep == /\ Stage >= 3 /\ R!Next
              /\ UNCHANGED <<delivery, admission, succession, badInterlock>>
HostStep == /\ Stage >= 4 /\ H!Next
            /\ UNCHANGED <<delivery, admission, resume, badInterlock>>
Next == /\ depth < MaxDepth /\ depth' = depth + 1
        /\ (DeliveryStep \/ AdmissionStep \/ ResumeStep \/ HostStep)
Safety == D!Safety /\ A!Safety /\ R!Safety /\ H!Safety /\ ~badInterlock
=============================================================================
