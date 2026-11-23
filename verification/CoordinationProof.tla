------------------------ MODULE CoordinationProof -----------------------
EXTENDS Coordination, TLAPS

PD == INSTANCE M1DeliveryProof WITH s <- delivery
PA == INSTANCE M2AdmissionProof WITH s <- admission
PR == INSTANCE M3ResumeProof WITH s <- resume
PH == INSTANCE M4SuccessionProof WITH s <- succession

\* Projection, not an assumption of independence: the actual product guards each
\* component step; all other steps must stutter on that component's record.
THEOREM Safe == ASSUME RankLimit \in Nat, InitialRanks \in 1..RankLimit, Capacity \in Nat, MaxOps \in Nat, Broken = "None"
                PROVE Init /\ [][Next]_vars => []Safety /\ [][H!ConsentAtSwitch]_<<succession>>
<1>1. Init /\ [][Next]_vars => []D!Safety
  <2>1. Init => D!Init BY DEF Init
  <2>2. [Next]_vars => [D!Next]_<<delivery>>
    BY Z3 DEF Next, vars, DeliveryStep, AdmissionStep, ResumeStep, HostStep
  <2>3. PD!Init /\ [][PD!Next]_PD!vars => []PD!Safety BY PD!Safe
  <2>4. []PD!Safety <=> []D!Safety BY DEF PD!Safety, D!Safety
  <2>5. PD!Init <=> D!Init BY DEF PD!Init, D!Init
  <2>6. [D!Next]_<<delivery>> <=> [PD!Next]_PD!vars BY DEF D!Next, PD!Next, PD!vars,
      D!Quiescent, D!Prepare, D!ReplaceSocket, PD!Quiescent, PD!Prepare, PD!ReplaceSocket,
      D!Regrant, D!Send, D!SendBeforeStore, PD!Regrant, PD!Send, PD!SendBeforeStore,
      D!CommitResult, D!EmitResult, D!StoreResult, PD!CommitResult, PD!EmitResult, PD!StoreResult,
      D!HostStore, D!HostAck, D!Deliver, PD!HostStore, PD!HostAck, PD!Deliver,
      D!AckPrefix, D!ReplayDelivery, D!LoseFrame, PD!AckPrefix, PD!ReplayDelivery, PD!LoseFrame,
      D!Retry, D!Crash, D!Restore, PD!Retry, PD!Crash, PD!Restore
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, PTL
<1>2. Init /\ [][Next]_vars => []A!Safety
  <2>1. Init => A!Init BY DEF Init
  <2>2. [Next]_vars => [A!Next]_<<admission>>
    BY Z3 DEF Next, vars, DeliveryStep, AdmissionStep, ResumeStep, HostStep
  <2>3. PA!Init /\ [][PA!Next]_PA!vars => []PA!Safety BY PA!Safe
  <2>4. []PA!Safety <=> []A!Safety BY DEF PA!Safety, A!Safety
  <2>5. PA!Init <=> A!Init BY DEF PA!Init, A!Init
  <2>6. [A!Next]_<<admission>> <=> [PA!Next]_PA!vars BY DEF A!Next, PA!Next, PA!vars,
      A!Quiescent, A!Request, A!Authorize, PA!Quiescent, PA!Request, PA!Authorize,
      A!StoreAdd, A!Welcome, A!Bootstrap, PA!StoreAdd, PA!Welcome, PA!Bootstrap,
      A!Prove, A!Activate, A!Expire, PA!Prove, PA!Activate, PA!Expire,
      A!Remove, A!Leave, A!Crash, PA!Remove, PA!Leave, PA!Crash,
      A!Restore, PA!Restore
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, PTL
<1>3. Init /\ [][Next]_vars => []R!Safety
  <2>1. Init => R!Init BY DEF Init
  <2>2. [Next]_vars => [R!Next]_<<resume>>
    BY Z3 DEF Next, vars, DeliveryStep, AdmissionStep, ResumeStep, HostStep
  <2>3. PR!Init /\ [][PR!Next]_PR!vars => []PR!Safety BY PR!Safe
  <2>4. []PR!Safety <=> []R!Safety BY DEF PR!Safety, R!Safety
  <2>5. PR!Init <=> R!Init BY DEF PR!Init, R!Init
  <2>6. [R!Next]_<<resume>> <=> [PR!Next]_PR!vars BY DEF R!Next, PR!Next, PR!vars,
      R!Ready, R!Disconnect, R!BeginAt, PR!Ready, PR!Disconnect, PR!BeginAt,
      R!Begin, R!PersistPrefixWith, R!PersistPrefix, PR!Begin, PR!PersistPrefixWith, PR!PersistPrefix,
      R!Snapshot, R!ObserveEnd, R!SendCompletion, PR!Snapshot, PR!ObserveEnd, PR!SendCompletion,
      R!Acknowledge, R!Crash, R!Restore, PR!Acknowledge, PR!Crash, PR!Restore
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, PTL
<1>4. Init /\ [][Next]_vars => []H!Safety /\ [][H!ConsentAtSwitch]_<<succession>>
  <2>1. Init => H!Init BY DEF Init
  <2>2. [Next]_vars => [H!Next]_<<succession>>
    BY Z3 DEF Next, vars, DeliveryStep, AdmissionStep, ResumeStep, HostStep
  <2>3. PH!Init /\ [][PH!Next]_PH!vars => []PH!Safety /\ [][PH!ConsentAtSwitch]_PH!vars BY PH!Safe DEF PH!Parameters
  <2>4. []PH!Safety <=> []H!Safety BY DEF PH!Safety, H!Safety, PH!EligibleAt, H!EligibleAt
  <2>5. PH!Init <=> H!Init BY DEF PH!Init, H!Init
  <2>6. [H!Next]_<<succession>> <=> [PH!Next]_PH!vars BY DEF H!Next, PH!Next, PH!vars,
      H!Available, H!EligibleAt, H!First, PH!Available, PH!EligibleAt, PH!First,
      H!Select, H!AtLoss, H!Disconnect, PH!Select, PH!AtLoss, PH!Disconnect,
      H!Reconnect, H!Grace, H!Choose, PH!Reconnect, PH!Grace, PH!Choose,
      H!AfterConsent, H!CommitAcceptance, H!Refuse, H!ExpireOffer, PH!AfterConsent, PH!CommitAcceptance, PH!Refuse, PH!ExpireOffer,
      H!StoreRemove, H!AckRemove, H!CompleteRemove, PH!StoreRemove, PH!AckRemove, PH!CompleteRemove,
      H!PublishPolicy, PH!PublishPolicy, H!PolicyList, PH!PolicyList,
      H!AdmitNext, PH!AdmitNext, H!Withdraw, PH!Withdraw, H!Ranks, PH!Ranks, H!Guests, PH!Guests
  <2>7. [PH!ConsentAtSwitch]_PH!vars <=> [H!ConsentAtSwitch]_<<succession>>
    BY DEF PH!ConsentAtSwitch, H!ConsentAtSwitch, PH!vars
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, PTL
<1>5. Init /\ [][Next]_vars => []~badInterlock
  <2>1. Init => ~badInterlock BY DEF Init
  <2>2. ~badInterlock /\ [Next]_vars => ~badInterlock'
    BY Z3 DEF Next, vars, Allowed, DeliveryStep, AdmissionStep, ResumeStep, HostStep
  <2> QED BY <2>1, <2>2, PTL
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, PTL DEF Safety
===========================================================================
