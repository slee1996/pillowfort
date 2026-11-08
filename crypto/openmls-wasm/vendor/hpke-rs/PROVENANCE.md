# Pillowfort HPKE and suite-1 dependency fork provenance

- Upstream crate: `hpke-rs` 0.6.1, MPL-2.0
- Upstream repository: https://github.com/cryspen/hpke-rs
- Upstream Git commit: `f3463e7530771d7f7116635335c25e7d2d11e861`
- crates.io archive SHA-256: `b6ad6a58eb3e0ee30be8bfc7a9770ae98adcfa1d9bc820a5847732ce84f70837`
- Retrieved from Cargo's verified crates.io cache.

Pillowfort permits only MLS ciphersuite 1:
`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. The upstream 0.6.1 facade
unconditionally depends on `libcrux-sha3` 0.0.8 only to derive experimental
X-Wing/ML-KEM keys. That dependency brings RustSec-vulnerable Libcrux packages
into the production WebAssembly graph even though Pillowfort cannot select
those KEMs.

The local fork makes the narrowest fail-closed change:

1. removes the optional provider re-exports and the unconditional
   `libcrux-sha3` dependency;
2. returns upstream's existing `UnsupportedKemOperation` error for X-Wing and
   ML-KEM facade operations and removes the now-unused private PQ RNG accessor;
   and
3. otherwise keeps the classical RFC 9180 source from 0.6.1 unchanged.

`tests/hpke_suite1.rs` exercises the exact X25519/HKDF-SHA256/AES-128-GCM HPKE
combination used by MLS ciphersuite 1, the OpenMLS provider's HPKE key derivation
and exporters, Ed25519 signing and persisted credential decoding, rejection of
all other MLS suites/signature schemes/HPKE configurations, and rejection of
removed backend KEMs. Unsupported algorithms return errors; they are never
mapped to suite 1.

## November 2026 dependency remediation

[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)
affects `crypto-bigint` 0.5.5; its fixed version is at least 0.7.6. The old
integer arithmetic arrived through P-256/P-384/secp256k1, none of which
Pillowfort's sole supported suite uses. A forced `crypto-bigint` version
override is not API-compatible with those old elliptic-curve crates.

The authoritative crates.io sparse-index records were checked for
[`openmls`](https://index.crates.io/op/en/openmls),
[`openmls_rust_crypto`](https://index.crates.io/op/en/openmls_rust_crypto),
[`openmls_basic_credential`](https://index.crates.io/op/en/openmls_basic_credential),
and [`hpke-rs-rust-crypto`](https://index.crates.io/hp/ke/hpke-rs-rust-crypto).
Even OpenMLS 0.9.2's released provider and basic credential 0.6.0 still depend
on P-256/P-384 0.13. The newer HPKE RustCrypto backend 0.8.0 migrates to the
new elliptic-curve generation but is not compatible with this facade's 0.6
provider traits. Consequently, a stable drop-in upstream upgrade cannot
remove the affected graph. Keep the compatible facade and narrow the
unused provider surfaces instead.

The additional vendored sources come from Cargo's verified crates.io
archives; package versions remain the upstream versions, selected exclusively
through the root `[patch.crates-io]` entries:

| Vendor directory | Upstream crate | License | Upstream Git commit | Archive SHA-256 |
| --- | --- | --- | --- | --- |
| `openmls-rust-crypto` | `openmls_rust_crypto` 0.5.1 | MIT | `47dbedecad0c1fd8eb5368d582250ebfcc1e1ce6` | `fafcc8a3552b10fbb3ab757cccaf1a34081e826ca819f49aa7e6645b1d95c00f` |
| `openmls-basic-credential` | `openmls_basic_credential` 0.5.0 | MIT | `6b85f0edc560b4fe0f5b9266092947a774614f3f` | `983e8be1457dd6f316f409292cec334af3b57b49a19deadc925c83c3c35e15b6` |
| `hpke-rs-rust-crypto` | `hpke-rs-rust-crypto` 0.6.1 | MPL-2.0 | `f3463e7530771d7f7116635335c25e7d2d11e861` | `14b28be6cba9081c7feda2651d51c2a900029798e78b4c1e093e792f4571a870` |
| `fluvio-wasm-timer` | `fluvio-wasm-timer` 0.2.5 | MIT | `4a3361ca02b186b57ebd4141001c07d1913db643` | `b768c170dc045fa587a8f948c91f9bcfb87f774930477c6215addf54317f137f` |

OpenMLS sources: https://github.com/openmls/openmls
HPKE sources: https://github.com/cryspen/hpke-rs
Timer archive: https://static.crates.io/crates/fluvio-wasm-timer/fluvio-wasm-timer-0.2.5.crate

Local changes relative to those archives:

1. `openmls-rust-crypto`: remove the P-256 dependency and its ECDSA branches.
   Advertise only MLS suite 1. Validate the exact X25519/HKDF-SHA256/AES-128-GCM
   HPKE configuration at every HPKE entrypoint, returning
   `UnsupportedCiphersuite` before processing keys for other configurations.
   The Ed25519, symmetric crypto, randomness, and supported HPKE operations
   remain upstream implementations.
2. `openmls-basic-credential`: remove P-256 and its ECDSA generation/signing
   branches, replacing the incidental P-256 signer-trait import with the
   Ed25519 signer trait. Preserve the exact serialized key fields, storage ID,
   Ed25519 generation/signing, and storage methods.
3. `hpke-rs-rust-crypto`: remove P-256/P-384/secp256k1 and experimental PQ
   dependencies, features, source module, and KEM branches. Only X25519 is
   advertised and accepted; keep its existing length checks, low-order point
   rejection, DH, generation, and public-key derivation unchanged. Keep
   upstream KDF/AEAD and PRNG implementations. `dh_validate_sk` still rejects
   X25519, as upstream did: X25519 facade derivation clamps its key bytes
   directly and never uses the Weierstrass rejection-sampling hook.
4. `fluvio-wasm-timer`: replace `parking_lot` 0.11 with maintained 0.12
   (dropping the old `wasm-bindgen` feature, which 0.12 does not expose).
   Replace `pin-utils` with `pin-project-lite` structural projections,
   `std::pin::pin!`, and safe `Pin::new` for the already-Unpin interval delay.
   This removes unmaintained `instant` and `pin-utils` without changing
   OpenMLS's browser `SystemTime`/lifetime validation or timer scheduling.
5. Omit the HPKE backend's unused upstream benchmark/dev-only setup, and
   omit upstream readmes from these additional vendor trees. The HPKE
   crate-level doc is an inline description rather than an include of an
   omitted readme. Runtime source files are retained except for the explicitly
   removed experimental PQ module.

The existing `hpke-rs` facade fork's PQ/Libcrux exclusion and the existing
`openmls-memory-storage` zeroizing fork are unchanged. No integer crate
override, advisory suppression, alternate cryptographic implementation, or
snapshot/wire-format migration is used. Remove these patches only when a
compatible upstream graph has neither the vulnerable integer dependency nor
the unmaintained timer dependencies, and preserves these protections.

## Rebuilding reviewed browser artifacts

These dependency/source changes require rebuilding the committed browser
artifacts; changing the source digest alone must not certify old WASM.
Required integration commands (not a claim they have run):

```sh
RUSTC="$(rustup which --toolchain 1.94.1 rustc)" \
RUSTDOC="$(rustup which --toolchain 1.94.1 rustdoc)" \
  rustup run 1.94.1 cargo test --locked --manifest-path crypto/openmls-wasm/Cargo.toml
bash scripts/build-openmls-wasm.sh
```

The pinned toolchain is 1.94.1 and wasm-bindgen is 0.2.120. The build script
already explicitly selects the pinned Cargo and rustc. Existing MLS roundtrip
and browser interoperability checks must run against the rebuilt artifact.

`scripts/verify-openmls-artifacts.mjs` already recursively includes every
regular file under `vendor`, so the added vendor directories need no new
whitelist entries. After all edits and the rebuild, refresh
`browser-artifacts.sha256.json`: SHA-256 each generated artifact, and compute
`sourceSha256` from the verifier's complete sorted input set (including
Cargo.lock, Cargo.toml, toolchain, `.gitignore`, the build script, and every
file under `src`, `tests`, and `vendor`). Sort paths with the verifier's
`localeCompare(..., "en")`; hash each repository-relative POSIX path, one NUL,
its byte length as an unsigned 64-bit big-endian integer, then its exact
bytes. Retain schema 1 and the pinned tool versions, then run
`node scripts/verify-openmls-artifacts.mjs`.
