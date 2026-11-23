------------------------- MODULE M1DeliveryProof -------------------------
EXTENDS M1Delivery, TLAPS
LOCAL INSTANCE SequenceTheorems

Ind == /\ DOMAIN s = {"id", "phase", "stored", "sent", "accepted", "senderDone", "inbox", "seen", "applied", "acked", "connection", "grantConnection", "badBinding", "wire", "down", "hostBacklog", "hostProcessed", "badHostPreview"}
       /\ Safety
       /\ s.id \in 0..MaxOps /\ s.phase \in {"idle", "prepared", "sent"}
       /\ s.accepted \subseteq 1..s.id
       /\ (s.phase = "idle" => s.id = 0 \/ s.id \in s.senderDone)
       /\ (s.phase # "idle" => s.id \in 1..MaxOps /\ s.id \in s.stored)
       /\ (s.phase = "prepared" => s.id \notin s.accepted)
       /\ (s.wire = "result" => s.phase = "sent" /\ s.id \in s.accepted)
       /\ (s.wire = "frame" => s.phase = "sent")
       /\ s.inbox \in Seq(1..MaxOps)
       /\ s.applied \in [1..MaxOps -> 0..1]
       /\ \A i \in 1..MaxOps : i \notin s.seen => s.applied[i] = 0

THEOREM Initial == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init => Ind
  BY Z3, EmptySeq DEF Init, Ind, Safety

THEOREM Preserved == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None", Ind PROVE Next => Ind'
<1>1. Prepare => Ind'
  BY Z3 DEF Ind, Safety, Prepare, Quiescent
<1>2. ReplaceSocket => Ind'
  BY Z3 DEF Ind, Safety, ReplaceSocket
<1>3. Regrant => Ind'
  BY Z3 DEF Ind, Safety, Regrant
<1>4. Send => Ind'
  BY Z3 DEF Ind, Safety, Send
<1>5. SendBeforeStore => Ind'
  BY Z3 DEF Ind, Safety, SendBeforeStore, Quiescent
<1>6. CommitResult => Ind'
  <2>1. CommitResult => s.id \in 1..MaxOps BY Z3 DEF CommitResult, Ind
  <2>2. s.inbox \in Seq(1..MaxOps) BY DEF Ind
  <2>3. Len(s.inbox) \in Nat BY <2>2, LenProperties
  <2>4. CommitResult => /\ Append(s.inbox, s.id) \in Seq(1..MaxOps)
                        /\ Len(Append(s.inbox, s.id)) = Len(s.inbox)+1
    BY <2>1, <2>2, AppendProperties
  <2> QED BY <2>3, <2>4, Z3 DEF Ind, Safety, CommitResult
<1>7. EmitResult => Ind'
  BY Z3 DEF Ind, Safety, EmitResult
<1>8. StoreResult => Ind'
  BY Z3 DEF Ind, Safety, StoreResult
<1>9. HostStore => Ind'
  BY Z3 DEF Ind, Safety, HostStore
<1>10. HostAck => Ind'
  BY Z3 DEF Ind, Safety, HostAck
<1>11. Deliver => Ind'
  BY Z3, HeadTailProperties, EmptySeq DEF Ind, Safety, Deliver
<1>12. AckPrefix => Ind'
  BY Z3, HeadTailProperties, EmptySeq, LenProperties DEF Ind, Safety, AckPrefix
<1>13. ReplayDelivery => Ind'
  BY Z3 DEF Ind, Safety, ReplayDelivery
<1>14. LoseFrame => Ind'
  BY Z3 DEF Ind, Safety, LoseFrame
<1>15. Retry => Ind'
  BY Z3 DEF Ind, Safety, Retry
<1>16. Crash => Ind'
  BY Z3 DEF Ind, Safety, Crash
<1>17. Restore => Ind'
  BY Z3 DEF Ind, Safety, Restore
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6, <1>7, <1>8, <1>9, <1>10, <1>11, <1>12, <1>13, <1>14, <1>15, <1>16, <1>17 DEF Next

THEOREM Safe == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init /\ [][Next]_vars => []Safety
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1> QED BY <1>1, <1>2, <1>3, PTL
=============================================================================
