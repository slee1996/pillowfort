------------------------- MODULE M4SuccessionProof -------------------------
EXTENDS M4Succession, TLAPS

Ind == /\ DOMAIN s = {"host", "connected", "policyHost", "policy", "attempted", "offered", "choice", "signedBy", "storedChoice", "grace", "fenced", "removal", "removeStored", "removeAcked", "retired", "switches", "consent", "badTarget"}
       /\ Safety
       /\ s.host \in {1,2,3} /\ s.connected \subseteq {1,2,3}
       /\ s.policy \subseteq {2,3} /\ s.connected \cap s.fenced = {}
       /\ (s.policyHost = 0 => s.policy = {})
       /\ (~s.retired => (s.host \in s.fenced <=> s.offered # 0))
       /\ (s.offered # 0 => s.offered \in s.policy)

LEMMA LeastCandidate == \A e \in SUBSET {1,2,3} : e # {} =>
  First(e) \in e /\ \A y \in e : First(e) <= y
<1> SUFFICES ASSUME NEW e \in SUBSET {1,2,3}, e # {} PROVE
     First(e) \in e /\ \A y \in e : First(e) <= y OBVIOUS
<1>1. PICK v \in e : TRUE BY Zenon
<1>2. \E n \in e : \A y \in e : n <= y
  <2>1. CASE 1 \in e
    <3>1. \A y \in e : 1 <= y BY <2>1, Z3
    <3> QED BY <2>1, <3>1
  <2>2. CASE 1 \notin e /\ 2 \in e
    <3>1. \A y \in e : 2 <= y BY <2>2, Z3
    <3> QED BY <2>2, <3>1
  <2>3. CASE 1 \notin e /\ 2 \notin e
    <3>1. v = 3 /\ \A y \in e : 3 <= y BY <1>1, <2>3, Z3
    <3> QED BY <1>1, <3>1
  <2> QED BY <2>1, <2>2, <2>3
<1> QED BY <1>2, Z3 DEF First

THEOREM Initial == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init => Ind
  BY Z3 DEF Init, Ind, Safety, EligibleAt

THEOREM Preserved == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None", Ind PROVE Next => Ind'
<1>1. \A d \in {1,2,3} : Disconnect(d) => Ind'
  <2> SUFFICES ASSUME NEW d \in {1,2,3}, Disconnect(d) PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt([s EXCEPT !.connected = @ \ {d}])
  <2>domain. pool \subseteq {1,2,3} BY Z3 DEF pool, Ind, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>2. s'.host \in {1,2,3} /\ s'.connected \subseteq {1,2,3} /\ s'.policy \subseteq {2,3} /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>6. s'.retired => s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Ind, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>2. \A d \in {1,2,3} : Reconnect(d) => Ind'
  <2> SUFFICES ASSUME NEW d \in {1,2,3}, Reconnect(d) PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt([s EXCEPT !.connected = @ \cup {d}])
  <2>domain. pool \subseteq {1,2,3} BY Z3 DEF pool, Ind, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>2. s'.host \in {1,2,3} /\ s'.connected \subseteq {1,2,3} /\ s'.policy \subseteq {2,3} /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>6. s'.retired => s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Ind, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>3. Grace => Ind'
  BY Z3, LeastCandidate DEF Ind, Safety, Grace, Select, EligibleAt
<1>4. \A c \in {"accept", "reject"}, d \in {1,2,3} : Choose(c, d) => Ind'
  BY Z3 DEF Ind, Safety, Choose, EligibleAt
<1>5. CommitAcceptance => Ind'
  <2>1. CommitAcceptance => s.signedBy \in {2,3} /\ s.signedBy \notin s.fenced
    BY Z3 DEF Ind, CommitAcceptance
  <2>post. CommitAcceptance => s' = AfterConsent(s) /\ ~s.retired BY DEF CommitAcceptance
  <2>2. CommitAcceptance => /\ s'.host = s.signedBy /\ s'.host \in s'.consent
                            /\ s'.offered = 0 /\ s'.policyHost = 0 /\ s'.policy = {}
                            /\ ~s'.removeAcked /\ ~s'.badTarget
    BY <2>post, Z3 DEF CommitAcceptance, AfterConsent, Ind, Safety
  <2>3. CommitAcceptance => DOMAIN s' = DOMAIN s
    BY <2>post, Z3 DEF AfterConsent, Ind
  <2>4. CommitAcceptance => s'.connected = s.connected BY <2>post, Z3 DEF AfterConsent, Ind
  <2>5. CommitAcceptance => s'.fenced = s.fenced BY <2>post, Z3 DEF AfterConsent, Ind
  <2>6. AfterConsent(s).retired = s.retired BY Z3 DEF AfterConsent, Ind
  <2>7. CommitAcceptance => ~s'.retired BY <2>6, <2>post
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>7, Z3 DEF Ind, Safety, EligibleAt
<1>6. Refuse => Ind'
  BY Z3, LeastCandidate DEF Ind, Safety, Refuse, Select, EligibleAt
<1>7. ExpireOffer => Ind'
  <2> SUFFICES ASSUME ExpireOffer PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt(s)
  <2>domain. pool \subseteq {1,2,3} BY Z3 DEF pool, Ind, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>2. s'.host \in {1,2,3} /\ s'.connected \subseteq {1,2,3} /\ s'.policy \subseteq {2,3} /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>6. s'.retired => s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Ind, Safety, ExpireOffer, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>8. StoreRemove => Ind'
  BY Z3 DEF Ind, Safety, StoreRemove, EligibleAt
<1>9. AckRemove => Ind'
  BY Z3 DEF Ind, Safety, AckRemove, EligibleAt
<1>10. CompleteRemove => Ind'
  BY Z3 DEF Ind, Safety, CompleteRemove, EligibleAt
<1>11. PublishPolicy => Ind'
  BY Z3 DEF Ind, Safety, PublishPolicy, Available, EligibleAt
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6, <1>7, <1>8, <1>9, <1>10, <1>11 DEF Next

THEOREM Safe == ASSUME Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init /\ [][Next]_vars => []Safety
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1> QED BY <1>1, <1>2, <1>3, PTL
=============================================================================
