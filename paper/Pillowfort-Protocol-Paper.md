# Pillowfort: Host Succession by Consent in Encrypted Rooms

<div class="subtitle">Protocol v4 · Profile CS1 · Evidence edition 12 · 23 November 2026</div>

## Abstract {.abstract-heading}

Pillowfort is a protocol for temporary encrypted rooms in which one participant, the host, admits members and validates their actions. The relay may offer this authority to another member; it cannot appoint one. Authority transfers only when the nominated device signs a response accepting the offer and the relay records it. Those signatures establish consent, not host failure. A mistaken or dishonest relay can trigger an unnecessary offer.

A host may hand off the role directly and stay in the room. After a detected disconnect, the relay instead acts under that host’s signed policy. If an eligible guest is ready, the relay immediately records an offer and prevents the old host from reclaiming the role by reconnecting, before anyone accepts. If no guest is ready, the host has up to 120 seconds to reconnect; a guest that becomes eligible first can receive the offer during that window. If no candidate accepts, the room closes. In an implementation over Messaging Layer Security (MLS), we show both costs: a host still validating chat can lose the role when its probe replies are delayed; waiting longer to replace it delays ordinary traffic when it really is unavailable.

**Keywords:** participant consent; host succession; failure detection; group messaging; MLS.

## 1. Scope and design objectives

A move can come from an authenticated player and still be out of turn. Messaging Layer Security (MLS) protects group traffic [1,2]; it does not decide whether a move is legal. Pillowfort’s room state machine makes that decision and distinguishes identity from authority in two other cases: admitting a new device and choosing a new host.

The protocol targets small, temporary rooms. The relay orders operations and decides when disconnect deadlines have passed. Peers verify signed authority; they cannot use a signature to establish that a host was actually offline. The protocol neither elects a host by quorum nor supplies an externally witnessed transcript.

## 2. System model and assumptions

A room contains devices, one designated host device, and a relay. Each device has a signing identity and an MLS credential. A display name is application data, not evidence of a person's identity. A software agent receives no additional protocol authority merely because it is automated.

A room's host is an admitted member. It authorizes device admission and executes automatic validation of ordinary non-host mutations. The relay maintains membership lifecycle metadata, a causal-order grant, pending outcomes, and delivery backlogs. Ordinary application plaintext and MLS private state reside at participating endpoints, including managed endpoints [3].

| Symbol | Interpretation |
|:--|:--|
| $r$ | Random room instance; distinct from its user-facing room code |
| $d,c$ | Device identity and current authenticated connection |
| $x,s,\ell$ | Application event identifier, per-device sequence, and causal order |
| $g$ | Relay-issued, context-bound ordering grant |
| $\sigma_d,A_d,O_d$ | Device MLS state, application state, and durable outbox |

: **Table 1.** Room and device notation.

Cryptographic authenticity assumes uncompromised signing keys and the security of the selected MLS ciphersuite. Recovery additionally assumes that the required committed local state remains available. Network messages may be lost, repeated, delayed, or interrupted. Claims of progress require participating parties to remain available and a sufficiently timely interval for expiring protocol steps to complete.

## 3. Cryptographic and authority boundaries {.page-start}

The implementation uses MLS ciphersuite 1: X25519, AES-128-GCM, SHA-256, and Ed25519. Invitation authentication is separate from MLS membership. The resolved invitation secret authorizes a request for admission; it is not an MLS group key and does not decrypt group traffic [3].

An unsigned application event is represented abstractly as

$$e=(v,r,x,d,s,\ell,m),$$

where $m$ is its typed application content. The device signs a domain-separated deterministic encoding of these fields before MLS protection. The concrete encoding enforces bounded structure, canonical numbers, and normalized strings [4]. Changing the room context or causal order therefore invalidates the corresponding signed event; signature validity alone does not establish application legality.

<figure id="fig-system">
<img src="assets/fig-01-system-model.svg" alt="System model separating participant plaintext and MLS state from relay metadata and opaque frame delivery.">
<figcaption><strong>Figure 1.</strong> System and trust boundaries. The host is an admitted endpoint, not a cryptographically neutral intermediary. Solid links denote protected group traffic; dashed links denote coordination and delivery controls. The relay observes metadata and controls availability, but does not require ordinary application plaintext. A managed agent endpoint is inside the participant confidentiality boundary.</figcaption>
</figure>

The relay enforces grant bindings, retains exact outcomes, and coordinates delivery. It cannot determine the semantic validity of ordinary encrypted content independently. Host validation supplies that decision for ordinary non-host mutations. Succession after host loss is a narrower exception: the relay verifies a previously signed delegation and the candidate's signed response through public authorization sidecars. Recipients still authenticate the MLS sender and apply their transition rules.

Neither an invitation nor a valid device signature establishes human identity. Optional out-of-band fingerprint comparison supplies additional identity assurance; it does not replace invitation binding or explicit host authorization.

## 4. Device admission {.page-start}

Admission separates invitation possession, host authorization, and active membership. The relay first authenticates the joining socket and retains a binding among the room instance, admission identifier, device signing key, and exact MLS KeyPackage digest. Host software independently checks that binding and the MLS credential before presenting the request for authorization [3,7].

A joining device must also know whose bootstrap to accept. A room code and password designate the founder. After migration, a member can share a new private link that binds the room instance to the current host’s device and signing key. The joiner retains that binding across restart and verifies it against the MLS roster and the bootstrap sender. An old invitation does not silently follow a new host.

No MLS Add is performed before the host explicitly approves the selected request. After approval, the host obtains an ordering grant and persists the resulting MLS state and outbound commit before transmission. Existing members receive the commit; only the joining device receives its corresponding Welcome and ratchet-tree material. The joiner stores its MLS state, applies a history-redacted bootstrap, and submits a device-signed profile proof. Activation follows validation of that proof against the admitted credential.

<figure id="fig-admission">
<img src="assets/fig-02-admission.svg" alt="Admission sequence showing invitation verification, explicit host authorization, MLS Add, targeted Welcome and bootstrap, proof validation, and relay activation.">
<figcaption><strong>Figure 2.</strong> Admission sequence. The two authorization decisions are distinct: the operator explicitly approves an exact pending device; software verifies the binding and joining proof. Arrows summarize logical messages routed through the relay. Persistence precedes dependent transmission or activation; delivery acknowledgments are omitted for clarity.</figcaption>
</figure>

A pending device cannot send ordinary member traffic or resume as an active member. A guest that loses its keys must obtain fresh approval. If the old device still holds its name, the new device uses a distinct name for chat and mentions. Neither the name nor the invitation restores earlier chat or drawings. An existing member can still disclose them independently.

In v2.1.1, the host-local approval window is 180 seconds. The relay bounds admission to 185 seconds from acceptance of the join, leaving a five-second completion margin under timely forwarding. Delay can reduce that margin. Expiration, rejection, or cancellation requires the prescribed fresh-admission context. Host observations expose an advisory `expiresAt`; it is not an authorization to bypass a current request or fingerprint check.

## 5. Ordered application execution {.page-start}

The relay issues at most one current causal-order grant. Abstractly,

$$g=(r,q,\tau,d,c,\ell,t_{\mathrm{exp}}),$$

where $q$ identifies the request and $\tau$ is a fresh grant token. The relay accepts a frame only in the matching room, device, connection, order, and expiry context. The signed application event also commits to $\ell$ [4,5].

Before transmission, the sender persists its post-transition MLS state, application transition context, and outbox entry. For an ordinary non-host mutation, the relay retains the opaque frame and requests a host preview. Host software decrypts and checks the candidate in an isolated engine copy. It returns an accept or reject decision bound to that exact pending frame. This is automatic protocol processing, not a per-message operator approval.

<figure id="fig-operation">
<img src="assets/fig-03-ordered-operation.svg" alt="Ordered application sequence showing grant acquisition, sender persistence, automatic host preview, relay result persistence, recipient delivery, and sender acknowledgment.">
<figcaption><strong>Figure 3.</strong> Non-host application execution. Local persistence, relay persistence, and network effects are separate steps. Recipients validate accepted events before application. A retained result and its exact acknowledgment support reconciliation; they do not establish that every recipient displayed or processed the content.</figcaption>
</figure>

The relay records the outcome before emitting dependent delivery effects. The sender records the result before acknowledging it and releasing dependent work. A blocked ordering request receives an exact retained cancellation rather than an unbound generic error. Membership, removal, and transfer barriers restrict which subsequent steps may advance [3].

A non-host grant is deferred while the connected host has an unacknowledged delivery backlog. Otherwise a sender on another connection could use its grant before the host had reconciled the previous operation. Host delivery acknowledgment or successful host resume releases the queued request.

The statuses *locally queued*, *relay accepted*, and *observed at a receiving device* are not interchangeable. An application requiring recipient evidence must inspect the intended receiver or obtain an application-level acknowledgment.

## 6. Persistence and recovery {.page-start}

Persistence is part of protocol execution, not an independent backup mechanism. Browser state is revisioned, wrapped under authenticated encryption, and mutated under room-scoped exclusive ownership. Required writes precede dependent sends and acknowledgments. Failure of storage or exclusive ownership stops the affected execution path rather than allowing volatile-only progress [3,6].

Rejection handling depends on the mutation class. An application rejection restores application metadata while retaining advanced MLS sender state, avoiding sender-generation reuse. Rejection of a locally generated membership or update commit instead retires that identity; reverting the epoch could resurrect consumed secrets. An invalid or unstorable incoming commit stops the receiving path without acknowledging it. On recovery, the receiver authenticates the retained Add and the group join proof that the relay released after activation; it need not have seen the live activation notice. Other peers do not roll back their accepted epochs merely because that receiver stopped. There is no automatic fork merge: recovery requires a valid retained state and authorized replay, fresh admission, or room recreation [3,6].

<figure id="fig-recovery">
<img src="assets/fig-04-recovery.svg" alt="Abstract operation and recovery state machine separating persisted pending state, durable result, acknowledgment, and reconciliation after interruption.">
<figcaption><strong>Figure 4.</strong> Recovery abstraction for an application operation. States describe protocol obligations, not one implementation enum. A restart restores committed state and reconciles the same operation identifier. Rejection of a locally generated MLS membership/update commit is excluded from the application-rejection path and requires identity retirement.</figcaption>
</figure>

Active-device resume is a separate protocol. The device authenticates its retained identity, processes and persists the backlog prefix, reconciles the relay snapshot with its MLS roster and signed host view, and accepts the exact replay terminator. The relay activates the device only after matching resume completion; ordinary outbound work remains blocked until the corresponding acknowledgment. A replacement socket starts a new completion even when the last replayed message is unchanged.

Historical removal markers must remain paired with the membership transition that justifies removal. Backlog acknowledgment is prefix-based: acknowledging a later identifier cannot discard an unapplied earlier entry. Hosted-runtime loss differs from browser recovery: a memory-only hosted identity is unavailable after loss and must not be silently reconstructed as a replacement participant.

Room retirement clears host authority and its succession policy before the relay persists the terminal state. Only after that write does it notify authenticated attached devices. Receiving the signed close application event alone does not establish that durable shutdown has completed. At idle expiry, deletion and the identities of the connections to notify are committed together. If the relay restarts before finishing, it retries on those same authenticated sockets. This protects connected peers without treating a send as proof that a peer received it.

## 7. Host migration: the pillow toss {.page-start}

Host migration transfers two duties: approving joins and validating other members’ actions. It does not move the room or copy the old host’s private keys. The successor already belongs to the MLS group and signs as itself. Pillowfort calls the offer to take over a *pillow toss*. Figures 5 and 6 show who can make the offer and what happens to the former host [3,5–7].

### 7.1 Planned handoff: the host offers the role

The current host signs an offer naming one admitted device. The relay binds the authorization to the room, both devices, the exact offer, and its expiry. The recipient saves the authorization and chooses whether to accept. If it accepts, its device signs a response referencing that authorization. The outgoing host’s software validates the response automatically; the relay records the new host before notifying members. The former host stays as an ordinary member. On refusal, the host software validates the signed response and identifies the exact offer to the relay. That offer is consumed without changing the host. A later offer requires a new choice; a delayed receipt cannot dispose of it.

<figure id="fig-transfer">
<img src="assets/fig-05-host-transfer.svg" alt="Manual host-transfer sequence separating the signed offer, bound authorization, explicit target acceptance, automatic validation, and persisted relay authority change.">
<figcaption><strong>Figure 5.</strong> Planned handoff. The outgoing host signs the offer; the target signs its acceptance. The authority change takes effect when the relay records it, not when either participant receives the result.</figcaption>
</figure>

### 7.2 After a disconnect: the relay offers the role

While the host is online, its software signs a `host-succession-policy` listing admitted devices in the order they joined. The list excludes the host and members awaiting removal. Reconnecting does not change priority; a change of membership or host requires a new policy. The policy tells the relay whom it may ask, not who will serve.

Suppose Ada hosts a room, and Ben and Chen joined in that order. Both guests are online and named in Ada’s signed policy. When the relay observes Ada’s socket close or its reachability check expires, it blocks that device identity from resuming and records Ben’s **30-second offer in the same transition**. It then delivers the offer. The 30 seconds are Ben’s time to respond, not a wait before asking. If Ben declines or times out, Chen gets a fresh offer. Ben stays in the room. If neither accepts, the room closes.

If nobody is eligible when Ada disconnects, the relay preserves her ability to reconnect for up to 120 seconds. If an authorized guest finishes reconnecting first, the relay makes the offer then; if Ada reconnects first, she keeps the role. Once an offer has started, even a brief interruption can cost Ada the role. This rule starts at observed disconnection, not at the first lost packet.

With an eligible guest ready, a clean close triggers the offer immediately. For a silent path with another participant connected, a current host answers automatic relay challenges. The relay sends a challenge after ten seconds, retries after five, then allows ten more for a reply on that same socket. It records a disconnect if neither answer arrives. The check establishes reachability, not whether the device has crashed: suspension or delay may lead to an unnecessary offer. The recipient must still consent. Older hosts that do not support the check depend on transport closure.

<figure id="fig-succession">
<img src="assets/fig-06-automatic-succession.svg" alt="Consent-based succession: the relay offers the pillow in signed admission order; each candidate explicitly accepts or declines. Acceptance transfers authority; refusal advances to the next candidate. If all refuse, the fort collapses.">
<figcaption><strong>Figure 6.</strong> Succession after host loss. The relay persists the first offer on socket loss if a candidate is ready. There is no additional grace period after detection if a candidate is eligible. Refusal or timeout advances the offer, never the authority. Only the accepting path leads to removal of the former host and resumption of ordinary traffic.</figcaption>
</figure>

If the relay restarts before sending the offer, the candidate can replay it on the same device. Replay preserves both the authorization and its original deadline. A delivery acknowledgment means only that the recipient saved the offer. The recipient chooses whether to accept or decline, signs a `host-succession` response bound to the policy and offer, and encrypts it with MLS. A signed copy alongside the ciphertext lets the relay check the credential, candidate, connection, grant, order, and expiry. Peers authenticate the MLS sender and the decrypted response. This response may cross a pending membership barrier to restore a host. Ordinary traffic may not.

If Chen accepts, the relay records Chen as host and consumes the authorization before delivering the result. A later delivery overflow cannot undo the transfer. Unlike a planned handoff, succession retires the absent device: Chen completes the MLS Remove for Ada’s device and its retirement notification before ordinary work continues. Ben and Chen can then exchange messages in the same room without another invitation. Chen publishes a new policy for any future succession; Ada’s policy ceased to authorize offers when the relay changed hosts.

The authority change, removal, and new policy are separate steps. If Chen’s device crashes after the relay records the transfer, it can resume with its retained identity, reconcile the result, and finish any outstanding removal. If it stays offline and the relay never accepted Chen’s own policy, the room closes at grace expiry. The relay cannot use Ada’s policy to choose a second successor.

This is not a quorum election. The relay judges connectivity and deadlines; signatures prove delegation and acceptance, not that another device was offline. A dishonest relay can therefore induce an authorized but unnecessary succession by misrepresenting availability. It cannot forge either participant’s signature.

## 8. Agent interfaces and notification semantics {.page-start}

Browser WebMCP, local MCP, and hosted MCP expose the same participant engine and room authorization rules. A hosted service access grant allocates access to a runtime; it is neither a room invitation nor admission to a room. A local process and a managed hosted endpoint have different custody boundaries [8].

The implemented attention mechanisms include bounded participant-local observations, filtered event waits, a private mention resource with MCP subscription notifications, and hosted asynchronous event-wait Tasks. A mention is detected after decryption and application at the receiving participant. A notification or completed Task reports available attention; the client or host application decides whether to schedule an agent turn [8–10].

These mechanisms do not provide an offline inbox, exactly-once agent actions, or preservation of hosted cryptographic identity. The hosted participant has a 600-second absolute lifetime and 120-second idle deadline. Delivery metadata does not extend those limits.

## 9. Security and availability limitations

**Endpoint trust.** Confidentiality excludes admitted endpoints from the adversary set. A member, model operator, or compromised browser may disclose content available to that endpoint. Same-origin malicious code can access plaintext and keys despite encryption at rest. Memory wiping cannot guarantee removal of copies retained by a runtime, operating system, backup, or storage device.

**Host and relay behavior.** An adversarial host may deny valid transitions; an adversarial relay may withhold, delay, or selectively deliver frames. During succession the relay also determines connectivity, deadlines, and candidate eligibility within the authorized order. Signatures do not prove the accuracy of those liveness judgments or establish a globally complete transcript. Local validation is not Byzantine agreement.

**Compromise recovery.** Forward secrecy depends on erasure of obsolete secrets. Post-compromise recovery requires appropriate fresh key material, removal of the attacker's continuing access, and updates or removal of affected members that relevant peers process. Fresh entropy from an unrelated member alone is not an unconditional recovery guarantee. Subsequent updates do not undo earlier disclosure [1,2].

**Bounded operation.** Grants, admissions, delivery buffers, and identifier histories have explicit limits. Exhaustion and ambiguous recovery may require fresh admission or room recreation. Finite storage and transient success cannot establish indefinite replay protection or eventual delivery under permanent failures.

## 10. Evaluation {.page-start}

### 10.1 Claims and evidence

| Protocol claim | Supporting observation | Tested revision | Limit |
|:-----------------------|:-----------------------------------------------|:-----------|:-----------------------|
| A stale resume ACK cannot unlock sends. | A [browser experiment](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/recovery-r3/second-resume.json) withheld the current ACK. The guest could receive, but could not send until that ACK arrived. Removing the guard made the [two-socket model](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/models/mutation-OldAck.log) ready too early. | [`1ba68f23`](https://github.com/slee1996/pillowfort/tree/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b) | Two replacement sockets; not unbounded reconnects or eventual delivery. |
| Receiving a signed close does not prove durable retirement. | A [peer saw the close](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/production-close-before.json) while the relay write failed. After the fix, the retired snapshot survived export/import and a [production peer reached the terminal screen](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/production-release-fixed-shutdown.json). | [`c726c5ec`](https://github.com/slee1996/pillowfort/tree/c726c5eccafacb6fe6c881be3fcc174287c2f86f) (fix) | One production shutdown; not proof of disk durability or notice to every peer. |
| Host loss triggers an offer, not a promotion. | The [relay](https://github.com/slee1996/pillowfort/blob/0df3215d98139861831c6e3f68eb0b0997c584ad/test/secure-relay-v4.test.ts) issued the offer without advancing the clock. In [one production room](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r8/paper/evidence/prompt-succession-r7/production/browser-results.json), the first guest saw it 181 ms after host tab closure began, declined, and exchanged encrypted chat after the second guest accepted. | [`0df3215d`](https://github.com/slee1996/pillowfort/tree/0df3215d98139861831c6e3f68eb0b0997c584ad) | One clean browser close, not a latency bound or a measure of silent-failure detection. |
| A stored offer survives loss of its first delivery. | [Three browsers and a local Worker](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r8/paper/evidence/qualification-r8/restart/browser-results.json): the relay instance was evicted before dispatch. The same device recovered the same authorization and deadline, declined, and exchanged encrypted chat after its peer accepted. | [`f03fa147`](https://github.com/slee1996/pillowfort/tree/f03fa147f79847dda5dac5b0a8ed37c8d040cee5) | One interruption with durable storage intact, not recovery after permanent loss. |
| Idle deletion survives a restart during notification. | In [two local runs](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r11/paper/evidence/qualification-r11/scenarios.json), the relay stopped after notifying zero or one of two peers. Both peers then saw closure without acting. | [`a5f0fe6b`](https://github.com/slee1996/pillowfort/tree/a5f0fe6b4f2a6e0d4c1e2888db6268048d1f904f) | [One live room](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r11/paper/evidence/qualification-r11/deployment.json): both saw closure by 600.45 s. No offline receipt guarantee. |
| The former host’s policy cannot authorize a second succession. | In a [three-browser run](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/browser-faults-pinned/browser-results.json), the successor disappeared before its own policy was accepted. At grace expiry the room retired rather than offer another member the role. | [`10fe8f8b`](https://github.com/slee1996/pillowfort/tree/10fe8f8b490c9e890d5a642bc25568e985c2fe8a) | One interrupted succession, not arbitrary chains of host failures. |
| Roster absence is not a retirement receipt. | A [restart regression](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/test/secure-room-engine.test.ts#L1425) retained the exact request across an unrelated ACK. After [two successor reloads](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/recovery-r3/former-host-removal.json) and a peer socket close just after Remove, encrypted chat resumed both ways. | [`1ba68f23`](https://github.com/slee1996/pillowfort/tree/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b) | One removal and replay schedule; not convergence across divergent MLS epochs. |
| Refusal does not prevent a new offer; migration does not transfer invitation trust automatically. | In [independent room journeys](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r9/paper/evidence/qualification-r9/qualification.json), the same guest declined and later caught a new offer. A successor admitted a fresh device; the obsolete founder link did not create a pending request. | [`8ba7ab70`](https://github.com/slee1996/pillowfort/tree/8ba7ab7040da0522a02ea0c222801e2a072efa05) | A new private link designates one host, not a chain of delegation. |
| A missing host response starts an offer, not a promotion. | In [three isolated cuts](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r10/paper/evidence/qualification-r10/scenarios.json), the host stopped receiving, sending, or both. The first eligible guest declined; the second accepted and exchanged encrypted messages. A healthy host survived a lost challenge across Worker eviction without an offer. | [`181a29f7`](https://github.com/slee1996/pillowfort/tree/181a29f79205650328fd3a1049f673003d113af3) | Opted-in host, scheduled alarms and intact storage. No absolute detection deadline. |
| A receiver can recover a missed admission. | After an [IndexedDB write failure](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r10/paper/evidence/qualification-r10/scenarios.json) during the Add, the original device replayed the committed proof and exchanged encrypted messages with the new member. | [`181a29f7`](https://github.com/slee1996/pillowfort/tree/181a29f79205650328fd3a1049f673003d113af3) | Prior keys and durable state remained intact; no arbitrary epoch repair. |
| Losing a device key does not transfer membership. | After [erasing a guest’s local keys](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r11/paper/evidence/qualification-r11/scenarios.json), the same invite and name produced a different key and request. The host approved it anew. Only its new name received mentions; earlier chat was absent. | [`a5f0fe6b`](https://github.com/slee1996/pillowfort/tree/a5f0fe6b4f2a6e0d4c1e2888db6268048d1f904f) | New admission, not restoration of old keys or history. |
| Local erasure failure does not reopen the room. | A [guest received retirement](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/evidence/qualification-r12/terminal-storage.json) but could not erase its IndexedDB record. Sending stopped immediately; after reload, an explicit retry with the original credentials cleared both record and pointer. | [`cbd7977d`](https://github.com/slee1996/pillowfort/tree/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708) | Recoverable local storage failure; no guarantee of physical erasure. |

: **Table 2.** Authority and recovery claims. In the shutdown row, the revision is the corrected production build; the earlier failure is a separate observation.

At [`cbd7977d`](https://github.com/slee1996/pillowfort/tree/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708), 594 application and 14 hosted-adapter tests passed. An [independent transition observer](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/evidence/qualification-r12/relay-conformance.json) checked 2,152 accepted and 40 rejected relay steps. TLC checked 18 intact configurations, exposed all 34 deliberate mutations, and reached 11 target states. The smallest composed model exhausted 6,544,512 reachable states without a depth cutoff. [Bounds and configurations](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/evidence/qualification-r12/models.json). These are release checks, not a proof that the implementation refines the models.

The [earlier transport-only test](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r8/paper/evidence/qualification-r8/silent/browser-results.json) saw no disconnect in 150 seconds. With reachability checks, local Worker detection took 23.05–23.07 seconds across three open-socket cuts; the first offer appeared 313–328 ms later. No test forced a close to obtain these results. These are three observations, not latency percentiles or an edge-service guarantee. By contrast, closing a host tab normally in [one production room](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r10/paper/evidence/qualification-r10/deployment.json) produced a visible offer in 287 ms. A frozen Chromium page that continued replying kept the role; stopping its JavaScript thread produced an offer after 23.93 seconds although the computer was still online.

### 10.2 Light-load latency

| Members | Added preview delay | Local p50 | Local p95 |
|---:|---:|---:|---:|
| 2 | 0 ms | 29.71 ms | 30.74 ms |
| 3 | 0 ms | 29.60 ms | 30.77 ms |
| 3 | 100 ms | 130.27 ms | 246.14 ms |
| 6 | 0 ms | 29.87 ms | 44.95 ms |

: **Table 3. Local, light-load chat latency.** Each row covers 20 non-host sends on one Apple M3 Max with a local relay, one message outstanding at a time. Timing runs from UI submission to display at the host; it excludes the 500 ms pause after delivery. Undelayed medians near 30 ms are not WAN or throughput measurements. With 20 observations, nearest-rank p95 is not a stable tail estimate. [Raw samples](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/benchmarks-final/browser-results.json), revision [`10fe8f8b`](https://github.com/slee1996/pillowfort/tree/10fe8f8b490c9e890d5a642bc25568e985c2fe8a).

A separate [capacity test](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r10/paper/evidence/qualification-r10/scenarios.json) admitted 20 independent browser profiles; a 21st was refused before approval. Five paced messages reached all 20 in 167–213 ms from submission to observation of the last profile. Checking all profiles adds observer overhead. This tests the membership boundary, not maximum throughput or performance over mobile networks.

### 10.3 When does a recoverable host lose authority?

We compared the released detector with an otherwise identical relay that waited 30 seconds longer for the final reply. Each of 24 local trials began with a host and two eligible guests. We held traffic on the host’s open socket, stopped and resumed its entire Chromium process tree, or delayed only genuine challenge replies. The relay and both guests continued running. We call an offer *avoidable in this experiment* when the released detector offered the role but, under the same interruption in the comparison room, the original host kept its socket, exchanged chat, and answered the next fresh challenge.

| Recoverable interruption | Released: offers | Chat (ms) | Longer wait: offers | Chat (ms) |
|:------------------------|-----------------:|----------:|--------------------:|----------:|
| Traffic held, 3 s | 0/2 | 48–55 | — | — |
| Browser stopped, 3 s | 0/2 | 47–56 | — | — |
| Probe replies held, 12 s | 0/2 | 52–54 | — | — |
| Traffic held, 18 s | 2/2 | 151–153 | 0/2 | 52–58 |
| Browser stopped, 18 s | 2/2 | 149–152 | 0/2 | 57 |
| Probe replies held, 18 s | 2/2 | 131–151 | 0/2 | 52–71 |
| Clean socket close, 3 s | 2/2 | 139–153 | — | — |

: **Table 4. Offers and ordinary traffic after restoration.** Offers are rooms with an offer / rooms tested; chat is the observed range from release of the interruption to display of a new guest-to-guest message. Guests deliberately waited until restoration to accept. A dash means not run. The clean close bypasses the silent-path detector and is not counted as an avoidable timeout.

All six 18-second interruptions produced an avoidable offer. The first guest received it about 15 seconds after the first challenge, before any acceptance. When only probe replies were late, ordinary encrypted chat had already reached its recipient in 50–52 ms in the two released-detector runs. An unanswered challenge can therefore displace a host that is still validating traffic.

The shorter wait had a measurable benefit when the host **remained unavailable**. In four separate trials the guest accepted as soon as it saw the offer. From the first challenge to guest-to-guest message display took **15.57–15.58 s** with the released detector and **45.20–45.24 s** with the longer wait. Neither clock starts at the first lost packet. These deliberately selected interruptions on one computer do not estimate how often an unnecessary offer occurs in practice. Stopping Chromium is not physical laptop sleep, Wi-Fi reassociation, or a WAN outage. [Trial data](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/evidence/qualification-r12/premature-succession.json) and [measurement procedure](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/scripts/measure-premature-succession.py).

## 11. Related designs

MLS architecture already assigns access control, delivery consistency, invalid-commit handling, and state-loss recovery to the surrounding application [2]. Pillowfort specifies one such composition rather than a new cryptographic primitive. Matrix Megolm uses per-sender ratchets and session-key distribution [12]; Signal's private-group design combines encrypted canonical group state with privacy-preserving authorization [13]. Their state and metadata goals differ from Pillowfort's visible relay coordination and admitted-host authority. The appendix compares these mechanisms; no cross-system performance experiment is implied.

## 12. Conclusion

Pillowfort delegates the right to make an offer, not the power to appoint a validator. A planned handoff changes who validates actions without removing anyone. After a disconnect, a signed policy lets the relay offer the same role without the former host’s participation, but only a member’s signed acceptance can complete the transfer. In the [browser recovery run](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/recovery-r3/handoff-guest.json), a returning guest replayed that acceptance and resumed encrypted chat without changing its device identity. If no eligible member agrees to host, the protocol closes the room instead.

## References {.references-heading}

1. IETF. *The Messaging Layer Security (MLS) Protocol*. RFC 9420. [rfc-editor.org/rfc/rfc9420](https://www.rfc-editor.org/rfc/rfc9420.html).
2. IETF. *The Messaging Layer Security (MLS) Architecture*. RFC 9750. [rfc-editor.org/rfc/rfc9750](https://www.rfc-editor.org/rfc/rfc9750.html).
3. Pillowfort. *Secure Room Protocol v4*. Wire contract for the measured implementation. [Source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/docs/SECURE_ROOM_PROTOCOL_V4.md).
4. Pillowfort. *Application Event Encoding and Signatures*. [Pinned source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/src/applicationEventsV4.ts).
5. Pillowfort. *Relay State and Transitions*. [Pinned source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/src/secureRelayV4.ts).
6. Pillowfort. *Secure Room Engine*. Persistence, rejection, and recovery. [Pinned source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/src/participant/secureRoomEngine.ts).
7. Pillowfort. *Participant Controller*. Admission and host succession. [Pinned source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/src/participant/secureRoomController.ts).
8. Pillowfort. *Agent Security and Custody*. [Pinned source](https://github.com/slee1996/pillowfort/blob/cbd7977df9df29bb6e80baf34a3f32b9f4dc4708/docs/agents/security.md).
9. Model Context Protocol. *Subscriptions*, protocol revision 2026-07-28. [Specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md).
10. Model Context Protocol. *Tasks Extension*. [Overview](https://modelcontextprotocol.io/extensions/tasks/overview.md).
11. Pillowfort. *Protocol v4-CS1.* [Wire contract](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/Protocol-Technical-Appendix.pdf), [state machines](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/Formal-State-Machine-Analysis.pdf), [claim matrix](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/Protocol-Verification-Matrix.md), [results](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-23-r12/paper/evidence/qualification-r12/qualification.json), [replication archive](https://github.com/slee1996/pillowfort/releases/download/protocol-v4-cs1-evidence-2026-11-23-r12/Pillowfort-Protocol-v4-CS1-R12.zip).
12. Matrix. *Megolm Group Ratchet*, specification v1.19. [Specification](https://spec.matrix.org/v1.19/olm-megolm/megolm/).
13. Signal. *The Signal Private Group System*. [Design](https://signal.org/blog/signal-private-group-system/).
