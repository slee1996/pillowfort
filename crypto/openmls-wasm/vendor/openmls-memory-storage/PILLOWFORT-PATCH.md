# Pillowfort OpenMLS memory-storage patch

This directory is the `openmls_memory_storage` 0.5.0 crate published from
OpenMLS commit `6b85f0edc560b4fe0f5b9266092947a774614f3f`. The original crates.io archive
has SHA-256 checksum
`1a52c927ddb9940acb96d51aebd54b8b9c601c7119e6609622fb3f2cbe16abe3`.

Pillowfort's WASM adapter patches the in-memory backend to wipe serialized keys,
values, replaced records, deleted records, and temporary serialized lists before
their allocations are released. The upstream backend drops those `Vec<u8>`
allocations without clearing them, which leaves prior MLS epoch/message secrets
recoverable by scanning reusable WebAssembly linear memory after a key update.
Erasure uses `zeroize` so release-mode dead-store elimination cannot remove the
clears, and secret-bearing JSON growth wipes each predecessor allocation.

The patch deliberately does not change the storage schema or OpenMLS trait
behavior. `crypto/openmls-wasm/tests` and the browser-level linear-memory
regression verify ciphersuite behavior and the erasure boundary.
