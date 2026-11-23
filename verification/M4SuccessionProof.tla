------------------------- MODULE M4SuccessionProof -------------------------
EXTENDS M4Succession, TLAPS, FiniteSetTheorems

Parameters == /\ RankLimit \in Nat /\ InitialRanks \in 1..RankLimit
RosterOK(x) == /\ x.high \in InitialRanks..RankLimit /\ x.admitted \subseteq 1..x.high
               /\ x.connected \subseteq x.admitted /\ x.fenced \subseteq 1..x.high
               /\ (1 \in x.admitted => x.host = 1)
               /\ IF x.retired THEN x.host = 0 /\ x.admitted = {} ELSE x.host \in x.admitted
Fields == {"host", "high", "admitted", "connected", "policyHost", "policy", "attempted", "offered", "choice", "signedBy", "storedChoice", "grace", "fenced", "removal", "removeStored", "removeAcked", "retired", "switches", "consent", "badTarget"}
Ind == /\ DOMAIN s = Fields
       /\ Safety
       /\ RosterOK(s)
       /\ s.policy \subseteq Guests /\ s.connected \cap s.fenced = {}
       /\ (s.policyHost = 0 => s.policy = {})
       /\ (~s.retired => (s.host \in s.fenced <=> s.offered # 0))
       /\ (s.offered # 0 => s.offered \in s.policy)

LEMMA LeastCandidate == \A e \in SUBSET Nat : e # {} =>
  First(e) \in e /\ \A y \in e : First(e) <= y
<1> SUFFICES ASSUME NEW e \in SUBSET Nat, e # {} PROVE
     First(e) \in e /\ \A y \in e : First(e) <= y OBVIOUS
<1>1. e \subseteq Nat BY Z3
<1>2. \E m \in e : \A y \in e : <<y,m>> \notin OpToRel(<,Nat)
  BY <1>1, WFMin, NatLessThanWellFounded
<1>3. PICK m \in e : \A y \in e : <<y,m>> \notin OpToRel(<,Nat) BY <1>2
<1>4. \A y \in e : m <= y BY <1>1, <1>3, Z3 DEF OpToRel
<1>5. \E n \in e : \A y \in e : n <= y BY <1>3, <1>4
<1> QED BY <1>5, Z3 DEF First

THEOREM Initial == ASSUME Parameters, Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init => Ind
  BY Z3 DEF Init, Parameters, RosterOK, Ranks, Guests, Ind, Fields, Safety, EligibleAt

THEOREM Preserved == ASSUME Parameters, Capacity \in Nat, MaxOps \in Nat, Broken = "None", Ind PROVE Next => Ind'
<1>1. \A d \in Ranks : Disconnect(d) => Ind'
  <2> SUFFICES ASSUME NEW d \in Ranks, Disconnect(d) PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt([s EXCEPT !.connected = @ \ {d}])
  <2>domain. pool \subseteq Nat BY Z3 DEF pool, Parameters, RosterOK, Ranks, Guests, Ind, Fields, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>2. RosterOK(s') /\ s'.policy \subseteq Guests /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>6. s'.retired => s'.host = 0 /\ s'.policyHost = 0 /\ s'.policy = {} /\ s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (~s'.retired /\ s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Disconnect, AtLoss, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>2. \A d \in Ranks : Reconnect(d) => Ind'
  <2> SUFFICES ASSUME NEW d \in Ranks, Reconnect(d) PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt([s EXCEPT !.connected = @ \cup {d}])
  <2>domain. pool \subseteq Nat BY Z3 DEF pool, Parameters, RosterOK, Ranks, Guests, Ind, Fields, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>2. RosterOK(s') /\ s'.policy \subseteq Guests /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>6. s'.retired => s'.host = 0 /\ s'.policyHost = 0 /\ s'.policy = {} /\ s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (~s'.retired /\ s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, Reconnect, AtLoss, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>3. Grace => Ind'
  BY Z3, LeastCandidate DEF Ind, Fields, Safety, RosterOK, Guests, Ranks, Parameters, Grace, Select, EligibleAt
<1>4. \A c \in {"accept", "reject"}, d \in Guests : Choose(c, d) => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, Choose, EligibleAt
<1>5. CommitAcceptance => Ind'
  <2>1. CommitAcceptance => s.signedBy \in Guests /\ s.signedBy \notin s.fenced
    BY Z3 DEF Ind, CommitAcceptance, RosterOK, Guests
  <2>post. CommitAcceptance => s' = AfterConsent(s) /\ ~s.retired BY DEF CommitAcceptance
  <2>2. CommitAcceptance => /\ s'.host = s.signedBy /\ s'.host \in s'.consent
                            /\ s'.offered = 0 /\ s'.policyHost = 0 /\ s'.policy = {}
                            /\ ~s'.removeAcked /\ ~s'.badTarget
    BY <2>post, Z3 DEF CommitAcceptance, AfterConsent, Fields, Ind, Safety
  <2>3. CommitAcceptance => DOMAIN s' = DOMAIN s
    BY <2>post, Z3 DEF AfterConsent, Fields, Ind
  <2>4. CommitAcceptance => s'.connected = s.connected BY <2>post, Z3 DEF AfterConsent, Fields, Ind
  <2>5. CommitAcceptance => s'.fenced = s.fenced BY <2>post, Z3 DEF AfterConsent, Fields, Ind
  <2>6. AfterConsent(s).retired = s.retired BY Z3 DEF AfterConsent, Fields, Ind
  <2>7. CommitAcceptance => ~s'.retired BY <2>6, <2>post
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>7, Z3 DEF Ind, Fields, Safety, EligibleAt, RosterOK, Guests, Ranks, AfterConsent, CommitAcceptance
<1>6. Refuse => Ind'
  BY Z3, LeastCandidate DEF Ind, Fields, Safety, RosterOK, Guests, Ranks, Parameters, Refuse, Select, EligibleAt
<1>7. ExpireOffer => Ind'
  <2> SUFFICES ASSUME ExpireOffer PROVE Ind' OBVIOUS
  <2> DEFINE pool == EligibleAt(s)
  <2>domain. pool \subseteq Nat BY Z3 DEF pool, Parameters, RosterOK, Ranks, Guests, Ind, Fields, EligibleAt
  <2>pick. pool # {} => First(pool) \in pool BY <2>domain, LeastCandidate
  <2>1. DOMAIN s' = DOMAIN s
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>2. RosterOK(s') /\ s'.policy \subseteq Guests /\ s'.connected \cap s'.fenced = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>3. s'.policyHost = 0 => s'.policy = {}
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>4. ~s'.retired => (s'.host \in s'.fenced <=> s'.offered # 0)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>5. s'.offered # 0 => s'.offered \in s'.policy /\ s'.offered \in s'.attempted /\ s'.policyHost = s'.host
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>6. s'.retired => s'.host = 0 /\ s'.policyHost = 0 /\ s'.policy = {} /\ s'.connected = {} /\ s'.offered = 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>7. ~s'.retired /\ s'.host \notin s'.connected /\ EligibleAt(s') # {} => s'.host \in s'.fenced /\ s'.offered # 0
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2>8. ~s'.badTarget /\ s'.policyHost \in {0, s'.host} /\ (~s'.retired /\ s'.host # 1 => s'.host \in s'.consent) /\ (s'.removeAcked => s'.removeStored)
    BY <2>pick, Z3 DEF pool, Parameters, RosterOK, Guests, Ranks, Ind, Fields, Safety, ExpireOffer, Select, EligibleAt
  <2> QED BY <2>1, <2>2, <2>3, <2>4, <2>5, <2>6, <2>7, <2>8, Z3 DEF Ind, Safety
<1>8. StoreRemove => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, StoreRemove, EligibleAt
<1>9. AckRemove => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, AckRemove, EligibleAt
<1>10. CompleteRemove => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, CompleteRemove, EligibleAt
<1>11. PublishPolicy => Ind'
  BY Z3 DEF Ind, Fields, Safety, PublishPolicy, PolicyList, RosterOK, Guests, Ranks, Parameters, Available, EligibleAt
<1>12. AdmitNext => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, Ranks, Guests, Parameters, AdmitNext, Available, EligibleAt
<1>13. \A d \in Ranks : Withdraw(d) => Ind'
  BY Z3 DEF Ind, Fields, Safety, RosterOK, Ranks, Guests, Parameters, Withdraw, Available, EligibleAt
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6, <1>7, <1>8, <1>9, <1>10, <1>11, <1>12, <1>13 DEF Next


\* Each new offer chooses the least eligible ordinal and consumes exactly one
\* entry from this signed policy. Connectivity may change between offers.
THEOREM NewOffer == ASSUME NEW x, DOMAIN x = Fields, x.offered = 0,
                           EligibleAt(x) # {}, EligibleAt(x) \subseteq Nat
                    PROVE LET y == Select(x) IN
                      /\ y.host = x.host /\ y.offered \in EligibleAt(x)
                      /\ \A d \in EligibleAt(x) : y.offered <= d
                      /\ y.policy \ y.attempted = (x.policy \ x.attempted) \ {y.offered}
                      /\ y.offered \in x.policy \ x.attempted
<1>1. First(EligibleAt(x)) \in EligibleAt(x) /\
        \A d \in EligibleAt(x) : First(EligibleAt(x)) <= d BY LeastCandidate
<1> QED BY <1>1, Z3 DEF Select, Fields, EligibleAt

THEOREM FiniteOfferBudget == ASSUME NEW x, DOMAIN x = Fields, x.offered = 0,
                              EligibleAt(x) # {}, EligibleAt(x) \subseteq Nat, IsFiniteSet(x.policy)
             PROVE Cardinality(Select(x).policy \ Select(x).attempted) = Cardinality(x.policy \ x.attempted) - 1
<1> DEFINE remaining == x.policy \ x.attempted
<1>1. remaining \in SUBSET x.policy BY Z3 DEF remaining
<1>2. IsFiniteSet(remaining) BY <1>1, FS_Subset
<1>3. Select(x).offered \in remaining /\
       Select(x).policy \ Select(x).attempted = remaining \ {Select(x).offered} BY NewOffer DEF remaining
<1>4. Cardinality(remaining \ {Select(x).offered}) = Cardinality(remaining) - 1
  BY <1>2, <1>3, FS_RemoveElement
<1> QED BY <1>3, <1>4 DEF remaining

LEMMA AuthorityStep == ASSUME Ind, Broken = "None" PROVE Next => ConsentAtSwitch
<1>1. (\E d \in Ranks : Disconnect(d) \/ Reconnect(d)) => s'.retired \/ s'.host = s.host
  BY Z3 DEF Disconnect, Reconnect, AtLoss, Select, Ind, Fields
<1>2. (Grace \/ Refuse \/ ExpireOffer) => s'.retired \/ s'.host = s.host
  BY Z3 DEF Grace, Refuse, ExpireOffer, Select, Ind, Fields
<1>3. ((\E c \in {"accept", "reject"}, d \in Guests : Choose(c,d)) \/ StoreRemove \/ AckRemove
        \/ CompleteRemove \/ PublishPolicy \/ AdmitNext \/ (\E d \in Ranks : Withdraw(d))) => s'.host = s.host
  BY Z3 DEF Choose, StoreRemove, AckRemove, CompleteRemove, PublishPolicy, AdmitNext, Withdraw, Ind, Fields
<1>4. CommitAcceptance => ConsentAtSwitch
  BY Z3 DEF CommitAcceptance, AfterConsent, ConsentAtSwitch, Ind, Fields, Safety
<1> QED BY <1>1, <1>2, <1>3, <1>4 DEF Next, ConsentAtSwitch

THEOREM Safe == ASSUME Parameters, Capacity \in Nat, MaxOps \in Nat, Broken = "None" PROVE Init /\ [][Next]_vars => []Safety /\ [][ConsentAtSwitch]_vars
<1>1. Init => Ind BY Initial
<1>2. Ind /\ [Next]_vars => Ind'
  <2>1. Ind /\ Next => Ind' BY Preserved
  <2>2. Ind /\ UNCHANGED vars => Ind' BY Z3 DEF vars, Ind, Safety
  <2> QED BY <2>1, <2>2
<1>3. Ind => Safety BY DEF Ind
<1>4. Ind /\ [Next]_vars => [ConsentAtSwitch]_vars BY AuthorityStep
<1> QED BY <1>1, <1>2, <1>3, <1>4, PTL
=============================================================================
