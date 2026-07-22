# Pillowfort hpke-rs fork provenance

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
combination used by MLS ciphersuite 1. When OpenMLS adopts `hpke-rs` 0.7 or a
later patched compatible release, remove this fork and its `[patch.crates-io]`
entry instead of extending it.
