# Pillowfort: An MLS-Based Protocol for Ephemeral Rooms

<div class="subtitle">Protocol v4 · Profile CS1 · Evidence edition 4 · 22 November 2026</div>

## Abstract {.abstract-heading}

Joining a Pillowfort room does not oblige a participant to host it. If the host disconnects, its signed policy lets the relay offer the role, not assign it. Authority changes only when the nominated device signs an acceptance and the relay commits the transfer. If every eligible member declines, the room closes. If a successor disappears before the relay accepts that successor’s own policy, the room closes after the disconnect grace period rather than reuse the former host’s delegation. This choice gives consent priority over room availability. We describe how temporary rooms for people and software agents enforce it over Messaging Layer Security (MLS), and test how members recover when a handoff is interrupted.

**Keywords:** group messaging; MLS; authenticated state machines; crash recovery; admission control.

## 1. Scope and design objectives

MLS protects group traffic, but does not decide which device may admit a member, authorize a room action, or coordinate the next operation after a failure [1,2]. Pillowfort assigns those decisions to an authenticated room state machine.

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

No MLS Add is performed before the host explicitly approves the selected request. After approval, the host obtains an ordering grant and persists the resulting MLS state and outbound commit before transmission. Existing members receive the commit; only the joining device receives its corresponding Welcome and ratchet-tree material. The joiner stores its MLS state, applies a history-redacted bootstrap, and submits a device-signed profile proof. Activation follows validation of that proof against the admitted credential.

<figure id="fig-admission">
<img src="assets/fig-02-admission.svg" alt="Admission sequence showing invitation verification, explicit host authorization, MLS Add, targeted Welcome and bootstrap, proof validation, and relay activation.">
<figcaption><strong>Figure 2.</strong> Admission sequence. The two authorization decisions are distinct: the operator explicitly approves an exact pending device; software verifies the binding and joining proof. Arrows summarize logical messages routed through the relay. Persistence precedes dependent transmission or activation; delivery acknowledgments are omitted for clarity.</figcaption>
</figure>

A pending device cannot send ordinary member traffic or invoke active-device resume. The bootstrap excludes pre-admission chat and drawings; an existing member may nevertheless disclose earlier content independently.

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

Rejection handling depends on the mutation class. An application rejection restores application metadata while retaining advanced MLS sender state, avoiding sender-generation reuse. Rejection of a locally generated membership or update commit instead retires that identity; reverting the epoch could resurrect consumed secrets. An invalid or unstorable incoming commit stops the receiving path without acknowledging it. Other peers do not roll back their accepted epochs merely because that receiver stopped. There is no automatic fork merge: recovery requires a valid retained state and authorized replay, fresh admission, or room recreation [3,6].

<figure id="fig-recovery">
<img src="assets/fig-04-recovery.svg" alt="Abstract operation and recovery state machine separating persisted pending state, durable result, acknowledgment, and reconciliation after interruption.">
<figcaption><strong>Figure 4.</strong> Recovery abstraction for an application operation. States describe protocol obligations, not one implementation enum. A restart restores committed state and reconciles the same operation identifier. Rejection of a locally generated MLS membership/update commit is excluded from the application-rejection path and requires identity retirement.</figcaption>
</figure>

Active-device resume is a separate protocol. The device authenticates its retained identity, processes and persists the backlog prefix, reconciles the relay snapshot with its MLS roster and signed host view, and accepts the exact replay terminator. The relay activates the device only after matching resume completion; ordinary outbound work remains blocked until the corresponding acknowledgment. A replacement socket starts a new completion even when the last replayed message is unchanged.

Historical removal markers must remain paired with the membership transition that justifies removal. Backlog acknowledgment is prefix-based: acknowledging a later identifier cannot discard an unapplied earlier entry. Hosted-runtime loss differs from browser recovery: a memory-only hosted identity is unavailable after loss and must not be silently reconstructed as a replacement participant.

Room retirement clears host authority and its succession policy before the relay persists the terminal state. Only after that write does it notify authenticated attached devices. Receiving the signed close application event alone does not establish that durable shutdown has completed.

## 7. Host transfer and preauthorized succession {.page-start}

Host authority moves to an existing admitted identity; it does not create a replacement participant. The protocol supports manual handoff and offers after host disconnection. Both require the target's explicit acceptance [3,5–7].

### 7.1 Explicit handoff

The current host issues a signed offer naming the target device. Relay authorization binds the source host, target, exact offer, room context, and expiration. The target persists the authorization and explicitly accepts it as a person or authorized agent. Its signed acceptance references that authorization. The current host validates the acceptance automatically. The relay commits the authority change before dependent delivery effects. The former host remains an admitted member.

<figure id="fig-transfer">
<img src="assets/fig-05-host-transfer.svg" alt="Manual host-transfer sequence separating the signed offer, bound authorization, explicit target acceptance, automatic validation, and persisted relay authority change.">
<figcaption><strong>Figure 5.</strong> Explicit host handoff. Source and target decisions are distinguished from automatic checks. This path requires the outgoing host's validation; it is not the disconnection-recovery path. Endpoint views may reconcile at different times.</figcaption>
</figure>

### 7.2 Consent-based succession after disconnection

While connected, host software maintains a signed `host-succession-policy` event containing admitted devices in authenticated admission order, excluding the host and members awaiting removal. Reconnection does not change that order. Membership or authority changes require a new policy.

The relay preserves the current host during a **120-second disconnect grace**. On expiry it fences that identity from resume and offers a **30-second authorization** to the earliest connected, active candidate in the current signed policy. Unavailable and removal-bound devices are ineligible. Candidate attempts and outstanding capabilities are durable; refusal or an unanswered offer advances to the next eligible candidate. An admitted device absent from the current policy is not implicitly authorized to succeed.

<figure id="fig-succession">
<img src="assets/fig-06-automatic-succession.svg" alt="Consent-based succession: the relay offers the pillow in signed admission order; each candidate explicitly accepts or declines. Acceptance transfers authority; refusal advances to the next candidate. If all refuse, the fort collapses.">
<figcaption><strong>Figure 6.</strong> Succession after host loss. Policy maintenance, offer delivery, and cryptographic checks are automatic; accepting the role is not. The disconnected host need not validate the response. The accepted successor completes the former host's MLS removal before ordinary work continues. Refusal or expiry advances the offer; exhaustion collapses the fort.</figcaption>
</figure>

The target persists the exact authorization before acknowledging delivery. Neither delivery acknowledgment nor membership accepts the host role. The participant explicitly chooses to accept or decline; its signed, encrypted `host-succession` response binds that choice to the policy and capability. The relay verifies the credential, candidate, connection, grant, order, and expiry. Recipients authenticate the MLS sender and response. This narrow response may pass a membership barrier to restore its coordinator; it does not authorize arbitrary traffic through the barrier.

On acceptance, authority and capability consumption are committed before dependent delivery effects. An unrelated delivery overflow cannot revoke an accepted transfer. The former host is retired; the successor completes its exact MLS Remove and retirement notification, then publishes a new policy. A refusal consumes the current offer without promoting or removing the refusing member. If every eligible member refuses, the fort collapses and the relay closes the room. Unanswered or unavailable candidates cannot force another member to accept. Old policies cease to authorize transfer after the host changes.

These steps are not one atomic transaction across devices. A successor that returns with its retained identity must reconcile the authority result and finish the exact former-host removal. Publishing its own policy establishes delegation for a subsequent host loss. If it is permanently lost before the relay accepts that policy, the preceding host's delegation cannot authorize another promotion: after the successor's disconnect grace, the relay retires the room. This preserves the authority boundary at the cost of availability.

The outgoing host need not remain online. The mechanism is not quorum-based or Byzantine leader election. The relay is the connectivity and deadline oracle: signatures authenticate delegation and acceptance, not evidence that another endpoint is offline. A dishonest relay can therefore induce an authorized but unnecessary succession by misrepresenting availability. It cannot forge the host's delegation or the candidate's consent.

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
| An offer does not make its recipient the host. | In [relay tests](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/test/secure-relay-v4.test.ts#L2469), refusal passed the offer to the next candidate. Only acceptance transferred authority; when both candidates refused, the room closed. | [`1ba68f23`](https://github.com/slee1996/pillowfort/tree/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b) | Device consent is authenticated. The relay’s account of who was online is not. |
| The former host’s policy cannot authorize a second succession. | In a [three-browser run](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/browser-faults-pinned/browser-results.json), the successor disappeared before its own policy was accepted. At grace expiry the room retired rather than offer another member the role. | [`10fe8f8b`](https://github.com/slee1996/pillowfort/tree/10fe8f8b490c9e890d5a642bc25568e985c2fe8a) | One interrupted succession, not arbitrary chains of host failures. |
| Roster absence is not a retirement receipt. | A [restart regression](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/test/secure-room-engine.test.ts#L1425) retained the exact request across an unrelated ACK. After [two successor reloads](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/recovery-r3/former-host-removal.json) and a peer socket close just after Remove, encrypted chat resumed both ways. | [`1ba68f23`](https://github.com/slee1996/pillowfort/tree/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b) | One removal and replay schedule; not convergence across divergent MLS epochs. |
| An invitation permits a request, not admission. | A [real-MLS test](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/test/secure-room-engine.test.ts#L1717) required explicit approval of the exact device request before the host could admit the invitation holder. | [`1ba68f23`](https://github.com/slee1996/pillowfort/tree/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b) | Identifies an approved device, not the person operating it. |

: **Table 2.** Authority and recovery claims. In the shutdown row, the revision is the corrected production build; the earlier failure is a separate observation.

At `1ba68f23`, the five protocol suites passed 90 tests (768 assertions) and the real-MLS engine suite passed 26 (310 assertions). TLC found no invariant violation in 11 finite configurations; all 11 deliberately weakened variants produced counterexamples. Two traces reached successful recovery with the guards intact. The largest composition explored 1,202,973 states at a 16-step bound. These checks do not establish implementation refinement, unbounded progress, or cryptographic security. The [verification matrix](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r4/paper/Protocol-Verification-Matrix.md) gives the property-level results.

### 10.2 Light-load latency

| Members | Added preview delay | Local p50 | Local p95 |
|---:|---:|---:|---:|
| 2 | 0 ms | 29.71 ms | 30.74 ms |
| 3 | 0 ms | 29.60 ms | 30.77 ms |
| 3 | 100 ms | 130.27 ms | 246.14 ms |
| 6 | 0 ms | 29.87 ms | 44.95 ms |

: **Table 3. Local, light-load chat latency.** Each row covers 20 non-host sends on one Apple M3 Max with a local relay, one message outstanding at a time. Timing runs from UI submission to display at the host; it excludes the 500 ms pause after delivery. Undelayed medians near 30 ms are not WAN or throughput measurements. With 20 observations, nearest-rank p95 is not a stable tail estimate. [Raw samples](https://github.com/slee1996/pillowfort/blob/994f8e8dc212cc3230cfdc5e7737d15d0495331c/paper/evidence/benchmarks-final/browser-results.json), revision [`10fe8f8b`](https://github.com/slee1996/pillowfort/tree/10fe8f8b490c9e890d5a642bc25568e985c2fe8a).

## 11. Related designs

MLS architecture already assigns access control, delivery consistency, invalid-commit handling, and state-loss recovery to the surrounding application [2]. Pillowfort specifies one such composition rather than a new cryptographic primitive. Matrix Megolm uses per-sender ratchets and session-key distribution [12]; Signal's private-group design combines encrypted canonical group state with privacy-preserving authorization [13]. Their state and metadata goals differ from Pillowfort's visible relay coordination and admitted-host authority. The appendix compares these mechanisms; no cross-system performance experiment is implied.

## 12. Conclusion

Pillowfort composes MLS with explicit admission, context-bound ordering, persist-before-effect execution, exact replay reconciliation, and authenticated host transfer. A signed admission-order policy permits offers without the disconnected host's further participation, while every recipient retains the choice to accept or decline. Its recovery contract preserves uncertainty and refuses to reuse an invalid delegation. The bounded analysis and fault executions support specific coordination properties under the stated storage, endpoint, and relay assumptions.

## References {.references-heading}

1. IETF. *The Messaging Layer Security (MLS) Protocol*. RFC 9420. [rfc-editor.org/rfc/rfc9420](https://www.rfc-editor.org/rfc/rfc9420.html).
2. IETF. *The Messaging Layer Security (MLS) Architecture*. RFC 9750. [rfc-editor.org/rfc/rfc9750](https://www.rfc-editor.org/rfc/rfc9750.html).
3. Pillowfort. *Secure Room Protocol v4*. Implementation contract for the tested revision. [Source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/docs/SECURE_ROOM_PROTOCOL_V4.md).
4. Pillowfort. *Application Event Encoding and Signatures*. [Pinned source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/src/applicationEventsV4.ts).
5. Pillowfort. *Relay State and Transitions*. [Pinned source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/src/secureRelayV4.ts).
6. Pillowfort. *Secure Room Engine*. Persistence, rejection, and recovery. [Pinned source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/src/participant/secureRoomEngine.ts).
7. Pillowfort. *Participant Controller*. Admission and host succession. [Pinned source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/src/participant/secureRoomController.ts).
8. Pillowfort. *Agent Security and Custody*. [Pinned source](https://github.com/slee1996/pillowfort/blob/1ba68f2361636ebfd9cd2a9d5509a621a7f1d22b/docs/agents/security.md).
9. Model Context Protocol. *Subscriptions*, protocol revision 2026-07-28. [Specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md).
10. Model Context Protocol. *Tasks Extension*. [Overview](https://modelcontextprotocol.io/extensions/tasks/overview.md).
11. Pillowfort. *Protocol v4-CS1: Wire Contract and Failure Semantics*. [Technical appendix](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r4/paper/Protocol-Technical-Appendix.pdf).
12. Matrix. *Megolm Group Ratchet*, specification v1.19. [Specification](https://spec.matrix.org/v1.19/olm-megolm/megolm/).
13. Signal. *The Signal Private Group System*. [Design](https://signal.org/blog/signal-private-group-system/).

**Companion artifacts:** [bounded analysis report](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r4/paper/Formal-State-Machine-Analysis.pdf); [claim-to-test matrix](https://github.com/slee1996/pillowfort/blob/protocol-v4-cs1-evidence-2026-11-22-r4/paper/Protocol-Verification-Matrix.md); [complete evidence bundle](https://raw.githubusercontent.com/slee1996/pillowfort/protocol-v4-cs1-evidence-2026-11-22-r4/paper/Pillowfort-Protocol-v4-CS1-Evidence.zip).
