# Secure room protocol v2

> Historical protocol-v2 record. Production uses protocol v4; its generated-
> by-default and explicitly custom password rules are documented in
> `docs/SECURE_ROOM_PROTOCOL_V4.md`.

This document freezes the authentication and encrypted-chat contract used by
the browser, local Bun relay, and Cloudflare Durable Object relay.

## Room secret

The first-party setup flow generates the room secret and does not accept a
host-authored password. Its exact format is:

```text
pf2_<43 unpadded base64url characters>
```

The suffix encodes 32 bytes produced by `crypto.getRandomValues`, so a generated
secret carries 256 random bits. The setup field is locked; the host can reveal,
copy, or regenerate it. The join flow accepts only the same `pf2_` format and
masks the value by default. The relay cannot measure secret entropy from a
challenge proof, so non-first-party clients must enforce the same rule.

## Room authentication

The relay sends an `auth-challenge` immediately after accepting a WebSocket.
The challenge is 32 random bytes encoded as unpadded base64url, expires after
30 seconds, and can be used for exactly one authentication attempt. The message
also carries the absolute `expiresAt` time in milliseconds.

The browser derives a 32-byte Ed25519 secret-key seed with PBKDF2-HMAC-SHA-256:

- iterations: `600000`
- salt: UTF-8 `pillowfort:auth-sign-v2:<room-id>`
- input: the exact validated room secret after UI trimming
- output: 256 bits

The proof signs the UTF-8 encoding of this canonical JSON array:

```json
["pillowfort-room-auth",2,"<action>","<room-id>","<trimmed-name>","<challenge>","<public-key>"]
```

`action` is one of `set-up`, `join`, or `rejoin`. The name is trimmed and
limited to 24 characters before signing. The public key and signature use
unpadded base64url. Setup includes the public key in the payload; join and
rejoin omit it, and the relay verifies against the room's stored public key.

```ts
interface RoomAuthPayload {
  v: 2;
  kdf: "pbkdf2-sha256-600k-ed25519-v2";
  challenge: string;
  proof: string;
  publicKey?: string;
}
```

The relay stores only the 32-byte public key. A captured proof cannot be reused
because it is bound to a one-use challenge, action, room, name, and key. Room
secrets therefore remain the only private admission material.

The public key is deterministically derived from the room secret. It is not a
bearer credential and cannot produce a valid proof, but it can confirm a guessed
secret. This is why the generated-only, 256-bit `pf2_` requirement is part of
the security contract rather than merely a UI preference.

Both relays reject WebSocket frames larger than 8 KiB before `JSON.parse`, allow
at most three pre-authentication frames, consume the challenge on the first
authentication attempt, enforce its 30-second lifetime, and limit failed
authentication to five attempts per source per minute. The Bun runtime also
sets its transport `maxPayloadLength` to 8 KiB. The production relay hashes the
client address before keeping its bounded, persisted throttle buckets.

Protocol-v1 verifier state is not migrated: the Durable Object deletes an old
`authVerifier`, records a fail-closed tombstone, and will not let another party
claim that still-live room code. A new room lifecycle is required.

## Encrypted chat

Only encrypted-chat payload version 3 is accepted:

```ts
interface EncryptedChatPayload {
  v: 3;
  kdf: "pbkdf2-sha256-600k-v1";
  sid: string;
  seq: number;
  iv: string;
  ct: string;
}
```

The AES-256-GCM key uses PBKDF2-HMAC-SHA-256 with 600,000 iterations and salt
`pillowfort:chat-v3:<room-id>`. Each browser runtime creates a fresh random
128-bit sender session ID and a monotonically increasing sequence starting at
one. Additional authenticated data is:

```text
pf-e2ee:v3:<room-id>:<sender>:<sid>:<seq>
```

The encrypted JSON body repeats `sid` and `seq`; both must match the envelope.
Message text and presentation style are inside that authenticated body. Relays
forward only the sanitized v3 envelope and the socket-bound sender name; an
unauthenticated outer `text` or `style` field is discarded.

Each browser runtime rotates to a fresh sender session ID whenever its in-memory
send sequence state starts over. Receivers persist a validated high-water
sequence ledger in tab-scoped session storage. Ledger entries do not expire or
age out. Cleanup may clear keys and sender counters, but it must not erase the
receive ledger. The ledger accepts at most 10,000 room/sender/session entries;
when it is corrupt, unavailable, unwritable, or saturated, new entries fail
closed rather than evicting history and making an old packet replayable. This
prevents reload or reconnect inside the browser-tab session from accepting a
packet already processed in that session. Closing the tab ends the storage
boundary. Legacy v1/v2 encrypted-chat packets are rejected.

Incoming encrypted messages are decrypted through one ordered, room-scoped
delivery queue so promise completion time cannot reorder chat history. Changing
rooms advances a queue generation; late work from the previous room is dropped.

## Scope limits

Chat v3 encrypts message text and presentation style. Room IDs, names,
membership, presence, timing, ciphertext length, games, and drawing/control
events remain visible to the relay. The shared deterministic room key does not
provide forward secrecy, post-compromise security, or per-member confidentiality.
An origin that serves modified JavaScript can also read secrets or plaintext in
the browser. Product copy must not claim otherwise.
