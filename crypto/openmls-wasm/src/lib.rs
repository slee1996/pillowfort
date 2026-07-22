use std::collections::HashMap;

use js_sys::{Array, Uint8Array};
use openmls::{
    credentials::{BasicCredential, CredentialWithKey},
    framing::{
        MlsMessageBodyIn, MlsMessageIn, MlsMessageOut, ProcessedMessageContent, ProtocolMessage,
        Sender,
    },
    group::{GroupId, MlsGroup, MlsGroupJoinConfig, StagedWelcome},
    key_packages::{KeyPackage, KeyPackageIn},
    prelude::{
        LeafNodeIndex, LeafNodeParameters, ProtocolVersion, RatchetTreeIn,
        SenderRatchetConfiguration,
    },
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    signatures::Signer,
    storage::CURRENT_VERSION,
    types::{Ciphersuite, SignatureScheme},
    OpenMlsProvider,
};
use tls_codec::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

/// WebAssembly linear memory remains readable for the lifetime of the module,
/// including allocator free lists. Crypto and serialization dependencies can
/// create opaque temporary allocations that are outside this adapter's object
/// graph, so per-type `Drop` implementations alone cannot provide an erasure
/// boundary. On WASM, scrub every allocation before it is released and perform
/// reallocations as allocate/copy/scrub/free so a resizing predecessor is never
/// handed back to the allocator with plaintext or key material intact.
#[cfg(target_arch = "wasm32")]
struct WipingAllocator;

#[cfg(target_arch = "wasm32")]
fn wipe_allocation(pointer: *mut u8, length: usize) {
    for offset in 0..length {
        // SAFETY: GlobalAlloc's deallocation contract gives exclusive access to
        // every byte in the allocation for the supplied layout.
        unsafe { pointer.add(offset).write_volatile(0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

#[cfg(target_arch = "wasm32")]
unsafe impl std::alloc::GlobalAlloc for WipingAllocator {
    unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
        // SAFETY: Delegates the unchanged valid layout to the system allocator.
        unsafe { std::alloc::System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: std::alloc::Layout) -> *mut u8 {
        // SAFETY: Delegates the unchanged valid layout to the system allocator.
        unsafe { std::alloc::System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: std::alloc::Layout) {
        wipe_allocation(pointer, layout.size());
        // SAFETY: `pointer` and `layout` are the allocation supplied by the
        // caller, and the scrub above does not change either one.
        unsafe { std::alloc::System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(
        &self,
        pointer: *mut u8,
        layout: std::alloc::Layout,
        new_size: usize,
    ) -> *mut u8 {
        let Ok(new_layout) = std::alloc::Layout::from_size_align(new_size, layout.align()) else {
            return std::ptr::null_mut();
        };
        // SAFETY: `new_layout` is valid and independent of the old allocation.
        let replacement = unsafe { std::alloc::System.alloc(new_layout) };
        if replacement.is_null() {
            return replacement;
        }
        // SAFETY: Both allocations are valid and disjoint, and the copy is
        // bounded by the smaller allocation size.
        unsafe {
            std::ptr::copy_nonoverlapping(pointer, replacement, layout.size().min(new_size));
        }
        wipe_allocation(pointer, layout.size());
        // SAFETY: The old allocation is released only after its preserved bytes
        // have been copied and its complete extent scrubbed.
        unsafe { std::alloc::System.dealloc(pointer, layout) };
        replacement
    }
}

#[cfg(target_arch = "wasm32")]
#[global_allocator]
static GLOBAL_ALLOCATOR: WipingAllocator = WipingAllocator;

const CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const SNAPSHOT_MAGIC: &[u8; 8] = b"PFMLS\0\0\x01";
const SNAPSHOT_VERSION: u16 = 1;
const CIPHERSUITE_ID: u16 = 1;
const ROOM_BINDING_BYTES: usize = 16;
const IDENTITY_BYTES: usize = 16;
const ED25519_PUBLIC_KEY_BYTES: usize = 32;
const ED25519_SIGNATURE_BYTES: usize = 64;
const MAX_KEY_PACKAGE_BYTES: usize = 16 * 1024;
const MAX_MLS_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_SIGNATURE_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_APPLICATION_BYTES: usize = 60 * 1024;
const MAX_RATCHET_TREE_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STORAGE_RECORDS: usize = 4_096;
const MAX_STORAGE_KEY_BYTES: usize = 64 * 1024;
const MAX_STORAGE_VALUE_BYTES: usize = 2 * 1024 * 1024;
// Application messages are padded by OpenMLS before encryption so the relay
// observes coarse 1 KiB buckets instead of near-exact chat/game payload sizes.
// This is traffic-analysis mitigation, not a claim that timing or size is
// completely hidden.
const APPLICATION_PADDING_BLOCK_BYTES: usize = 1024;
// The relay imposes a single total order, so receivers never need to retain
// already-consumed sender generations.  A bounded forward window still lets a
// receiver skip ciphertexts that were locally burned after host rejection.
const SENDER_RATCHET_MAX_FORWARD_DISTANCE: u32 = 1_000;

const STORAGE_LABELS: [&[u8]; 17] = [
    b"KeyPackage",
    b"Psk",
    b"EncryptionKeyPair",
    b"SignatureKeyPair",
    b"EpochKeyPairs",
    b"Tree",
    b"GroupContext",
    b"InterimTranscriptHash",
    b"ConfirmationTag",
    b"MlsGroupJoinConfig",
    b"OwnLeafNodes",
    b"GroupState",
    b"QueuedProposal",
    b"ProposalQueueRefs",
    b"OwnLeafNodeIndex",
    b"EpochSecrets",
    b"ResumptionPsk",
];

const EXTRA_STORAGE_LABELS: [&[u8]; 1] = [b"MessageSecrets"];

type AdapterResult<T> = Result<T, String>;

fn message_error(context: &str, error: impl std::fmt::Debug) -> String {
    format!("{context}: {error:?}")
}

fn js_error(error: String) -> JsError {
    JsError::new(&error)
}

fn validate_fixed(value: &[u8], expected: usize, label: &str) -> AdapterResult<()> {
    if value.len() != expected {
        return Err(format!("{label} must be exactly {expected} bytes"));
    }
    Ok(())
}

fn validate_bounded(value: &[u8], maximum: usize, label: &str) -> AdapterResult<()> {
    if value.is_empty() || value.len() > maximum {
        return Err(format!(
            "{label} must contain between 1 and {maximum} bytes"
        ));
    }
    Ok(())
}

/// Copy adapter-owned bytes directly into a JavaScript array.
///
/// Returning `Vec<u8>` through wasm-bindgen creates an additional temporary
/// allocation in WebAssembly linear memory. wasm-bindgen frees that allocation
/// after copying it to JavaScript, but does not scrub it first. Snapshot and
/// decrypted-plaintext getters therefore return a JS-owned array directly so
/// the only Rust allocation remains under our explicit Drop/zeroization path.
fn copy_to_js(value: &[u8]) -> Uint8Array {
    let output = Uint8Array::new_with_length(value.len() as u32);
    output.copy_from(value);
    output
}

/// JS `Uint8Array` arguments are accepted as externrefs and copied into one
/// adapter-owned allocation that is scrubbed on every return path. Accepting
/// `&[u8]` directly makes wasm-bindgen allocate and later free an implicit
/// linear-memory copy that Rust cannot zeroize first.
struct WipedBytes(Vec<u8>);

impl std::ops::Deref for WipedBytes {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.0.as_slice()
    }
}

impl Drop for WipedBytes {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

fn copy_fixed_from_js(
    value: &Uint8Array,
    expected: usize,
    label: &str,
) -> AdapterResult<WipedBytes> {
    if value.length() as usize != expected {
        return Err(format!("{label} must be exactly {expected} bytes"));
    }
    Ok(WipedBytes(value.to_vec()))
}

fn copy_bounded_from_js(
    value: &Uint8Array,
    maximum: usize,
    label: &str,
) -> AdapterResult<WipedBytes> {
    let length = value.length() as usize;
    if length == 0 || length > maximum {
        return Err(format!(
            "{label} must contain between 1 and {maximum} bytes"
        ));
    }
    Ok(WipedBytes(value.to_vec()))
}

fn copy_at_most_from_js(
    value: &Uint8Array,
    maximum: usize,
    label: &str,
) -> AdapterResult<WipedBytes> {
    if value.length() as usize > maximum {
        return Err(format!("{label} exceeds its {maximum}-byte limit"));
    }
    Ok(WipedBytes(value.to_vec()))
}

fn serialize_message(message: &MlsMessageOut) -> AdapterResult<Vec<u8>> {
    let encoded = message
        .tls_serialize_detached()
        .map_err(|error| message_error("MLS message serialization failed", error))?;
    if encoded.len() > MAX_MLS_MESSAGE_BYTES {
        return Err("MLS message exceeds the 64 KiB relay limit".to_string());
    }
    Ok(encoded)
}

fn parse_key_package(provider: &OpenMlsRustCrypto, bytes: &[u8]) -> AdapterResult<KeyPackage> {
    validate_bounded(bytes, MAX_KEY_PACKAGE_BYTES, "key package")?;
    let mut remaining = bytes;
    let incoming = KeyPackageIn::tls_deserialize(&mut remaining)
        .map_err(|error| message_error("key package decoding failed", error))?;
    if !remaining.is_empty() {
        return Err("key package contains trailing bytes".to_string());
    }
    let key_package = incoming
        .validate(provider.crypto(), ProtocolVersion::Mls10)
        .map_err(|error| message_error("key package validation failed", error))?;
    if key_package.ciphersuite() != CIPHERSUITE {
        return Err("key package uses the wrong ciphersuite".to_string());
    }
    Ok(key_package)
}

fn parse_ratchet_tree(bytes: &[u8]) -> AdapterResult<RatchetTreeIn> {
    validate_bounded(bytes, MAX_RATCHET_TREE_BYTES, "ratchet tree")?;
    let mut remaining = bytes;
    let tree = RatchetTreeIn::tls_deserialize(&mut remaining)
        .map_err(|error| message_error("ratchet tree decoding failed", error))?;
    if !remaining.is_empty() {
        return Err("ratchet tree contains trailing bytes".to_string());
    }
    Ok(tree)
}

fn parse_mls_message(bytes: &[u8]) -> AdapterResult<MlsMessageBodyIn> {
    validate_bounded(bytes, MAX_MLS_MESSAGE_BYTES, "MLS message")?;
    let mut remaining = bytes;
    let message = MlsMessageIn::tls_deserialize(&mut remaining)
        .map_err(|error| message_error("MLS message decoding failed", error))?;
    if !remaining.is_empty() {
        return Err("MLS message contains trailing bytes".to_string());
    }
    Ok(message.extract())
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}

fn push_bytes(output: &mut Vec<u8>, value: &[u8], label: &str) -> AdapterResult<()> {
    let length = u32::try_from(value.len()).map_err(|_| format!("{label} is too large"))?;
    push_u32(output, length);
    output.extend_from_slice(value);
    if output.len() > MAX_SNAPSHOT_BYTES {
        return Err("snapshot exceeds the 8 MiB persistence limit".to_string());
    }
    Ok(())
}

fn storage_label(key: &[u8]) -> Option<&'static [u8]> {
    STORAGE_LABELS
        .iter()
        .chain(EXTRA_STORAGE_LABELS.iter())
        .copied()
        .find(|label| key.starts_with(label))
}

fn validate_storage_record(key: &[u8], value: &[u8]) -> AdapterResult<()> {
    if key.len() < 3 || key.len() > MAX_STORAGE_KEY_BYTES {
        return Err("snapshot contains an invalid storage key length".to_string());
    }
    if value.is_empty() || value.len() > MAX_STORAGE_VALUE_BYTES {
        return Err("snapshot contains an invalid storage value length".to_string());
    }
    let version_offset = key.len() - 2;
    let version = u16::from_be_bytes([key[version_offset], key[version_offset + 1]]);
    if version != CURRENT_VERSION {
        return Err("snapshot contains an unsupported OpenMLS storage version".to_string());
    }
    let label = storage_label(key)
        .ok_or_else(|| "snapshot contains an unknown OpenMLS storage record".to_string())?;

    serde_json::from_slice::<serde_json::Value>(value)
        .map_err(|error| message_error("snapshot storage JSON is invalid", error))?;

    if label == b"SignatureKeyPair" {
        serde_json::from_slice::<SignatureKeyPair>(value)
            .map_err(|error| message_error("snapshot signature-key record is invalid", error))?;
    }
    if label == b"ProposalQueueRefs" || label == b"OwnLeafNodes" {
        serde_json::from_slice::<Vec<Vec<u8>>>(value)
            .map_err(|error| message_error("snapshot storage-list record is invalid", error))?;
    }
    if label == b"EpochKeyPairs"
        && !matches!(
            serde_json::from_slice::<serde_json::Value>(value),
            Ok(serde_json::Value::Array(_))
        )
    {
        return Err("snapshot epoch-key record is not an array".to_string());
    }
    Ok(())
}

struct SnapshotData {
    signed_payload: Vec<u8>,
    room_binding: Vec<u8>,
    identity: Vec<u8>,
    signature_public_key: Vec<u8>,
    group_id: Vec<u8>,
    records: HashMap<Vec<u8>, Vec<u8>>,
    signature: Vec<u8>,
}

impl Drop for SnapshotData {
    fn drop(&mut self) {
        self.signed_payload.zeroize();
        self.room_binding.zeroize();
        self.identity.zeroize();
        self.signature_public_key.zeroize();
        self.group_id.zeroize();
        self.signature.zeroize();
        for (mut key, mut value) in self.records.drain() {
            key.zeroize();
            value.zeroize();
        }
    }
}

struct SnapshotReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> SnapshotReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn take(&mut self, length: usize, label: &str) -> AdapterResult<&'a [u8]> {
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| format!("{label} length overflow"))?;
        if end > self.bytes.len() {
            return Err(format!("snapshot ended while reading {label}"));
        }
        let value = &self.bytes[self.position..end];
        self.position = end;
        Ok(value)
    }

    fn u16(&mut self, label: &str) -> AdapterResult<u16> {
        let value = self.take(2, label)?;
        Ok(u16::from_be_bytes([value[0], value[1]]))
    }

    fn u32(&mut self, label: &str) -> AdapterResult<u32> {
        let value = self.take(4, label)?;
        Ok(u32::from_be_bytes([value[0], value[1], value[2], value[3]]))
    }

    fn bytes(&mut self, maximum: usize, label: &str) -> AdapterResult<Vec<u8>> {
        let length = usize::try_from(self.u32(label)?)
            .map_err(|_| format!("{label} length cannot be represented"))?;
        if length > maximum {
            return Err(format!("{label} exceeds its size limit"));
        }
        Ok(self.take(length, label)?.to_vec())
    }
}

fn decode_snapshot(bytes: &[u8]) -> AdapterResult<SnapshotData> {
    validate_bounded(bytes, MAX_SNAPSHOT_BYTES, "snapshot")?;
    let mut reader = SnapshotReader::new(bytes);
    if reader.take(SNAPSHOT_MAGIC.len(), "snapshot magic")? != SNAPSHOT_MAGIC {
        return Err("snapshot magic is invalid".to_string());
    }
    if reader.u16("snapshot version")? != SNAPSHOT_VERSION {
        return Err("snapshot version is unsupported".to_string());
    }
    if reader.u16("ciphersuite")? != CIPHERSUITE_ID {
        return Err("snapshot ciphersuite is unsupported".to_string());
    }
    let room_binding = reader.bytes(ROOM_BINDING_BYTES, "room binding")?;
    validate_fixed(&room_binding, ROOM_BINDING_BYTES, "room binding")?;
    let identity = reader.bytes(IDENTITY_BYTES, "identity")?;
    validate_fixed(&identity, IDENTITY_BYTES, "identity")?;
    let signature_public_key = reader.bytes(ED25519_PUBLIC_KEY_BYTES, "signature public key")?;
    validate_fixed(
        &signature_public_key,
        ED25519_PUBLIC_KEY_BYTES,
        "signature public key",
    )?;
    let group_id = reader.bytes(ROOM_BINDING_BYTES, "group ID")?;
    if !group_id.is_empty() {
        validate_fixed(&group_id, ROOM_BINDING_BYTES, "group ID")?;
    }

    let record_count = usize::try_from(reader.u32("storage record count")?)
        .map_err(|_| "storage record count cannot be represented".to_string())?;
    if record_count > MAX_STORAGE_RECORDS {
        return Err("snapshot contains too many storage records".to_string());
    }
    let mut records = HashMap::with_capacity(record_count);
    for _ in 0..record_count {
        let key = reader.bytes(MAX_STORAGE_KEY_BYTES, "storage key")?;
        let value = reader.bytes(MAX_STORAGE_VALUE_BYTES, "storage value")?;
        validate_storage_record(&key, &value)?;
        if records.insert(key, value).is_some() {
            return Err("snapshot contains a duplicate storage key".to_string());
        }
    }

    let signed_length = reader.position;
    let signature_length = usize::from(reader.u16("snapshot signature length")?);
    if signature_length != ED25519_SIGNATURE_BYTES {
        return Err("snapshot signature has the wrong length".to_string());
    }
    let signature = reader
        .take(signature_length, "snapshot signature")?
        .to_vec();
    if reader.position != bytes.len() {
        return Err("snapshot contains trailing bytes".to_string());
    }

    Ok(SnapshotData {
        signed_payload: bytes[..signed_length].to_vec(),
        room_binding,
        identity,
        signature_public_key,
        group_id,
        records,
        signature,
    })
}

#[wasm_bindgen]
pub struct MlsTransition {
    kind: u8,
    outbound: Vec<u8>,
    welcome: Vec<u8>,
    ratchet_tree: Vec<u8>,
    plaintext: Vec<u8>,
    sender_identity: Vec<u8>,
    sender_leaf_index: u32,
    snapshot: Vec<u8>,
    epoch: u64,
    commit_add_count: u32,
    commit_remove_count: u32,
    commit_update_count: u32,
    commit_other_count: u32,
    commit_has_update_path: bool,
}

impl Drop for MlsTransition {
    fn drop(&mut self) {
        // wasm-bindgen getters copy these buffers into JavaScript.  Scrub the
        // adapter-owned copies when the transition handle is freed so rejected
        // plaintext and superseded serialized key state are not left in the
        // reusable WASM allocator merely because the JS wrapper was dropped.
        self.outbound.zeroize();
        self.welcome.zeroize();
        self.ratchet_tree.zeroize();
        self.plaintext.zeroize();
        self.sender_identity.zeroize();
        self.snapshot.zeroize();
    }
}

#[derive(Clone, Copy, Default)]
struct CommitSummary {
    add_count: u32,
    remove_count: u32,
    update_count: u32,
    other_count: u32,
    has_update_path: bool,
}

#[wasm_bindgen]
impl MlsTransition {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> u8 {
        self.kind
    }

    #[wasm_bindgen(getter)]
    pub fn outbound(&self) -> Uint8Array {
        copy_to_js(&self.outbound)
    }

    #[wasm_bindgen(getter)]
    pub fn welcome(&self) -> Uint8Array {
        copy_to_js(&self.welcome)
    }

    #[wasm_bindgen(getter)]
    pub fn ratchet_tree(&self) -> Uint8Array {
        copy_to_js(&self.ratchet_tree)
    }

    #[wasm_bindgen(getter)]
    pub fn plaintext(&self) -> Uint8Array {
        copy_to_js(&self.plaintext)
    }

    #[wasm_bindgen(getter)]
    pub fn sender_identity(&self) -> Uint8Array {
        copy_to_js(&self.sender_identity)
    }

    #[wasm_bindgen(getter)]
    pub fn sender_leaf_index(&self) -> u32 {
        self.sender_leaf_index
    }

    #[wasm_bindgen(getter)]
    pub fn snapshot(&self) -> Uint8Array {
        copy_to_js(&self.snapshot)
    }

    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    #[wasm_bindgen(getter)]
    pub fn commit_add_count(&self) -> u32 {
        self.commit_add_count
    }

    #[wasm_bindgen(getter)]
    pub fn commit_remove_count(&self) -> u32 {
        self.commit_remove_count
    }

    #[wasm_bindgen(getter)]
    pub fn commit_update_count(&self) -> u32 {
        self.commit_update_count
    }

    #[wasm_bindgen(getter)]
    pub fn commit_other_count(&self) -> u32 {
        self.commit_other_count
    }

    #[wasm_bindgen(getter)]
    pub fn commit_has_update_path(&self) -> bool {
        self.commit_has_update_path
    }
}

#[wasm_bindgen]
pub struct RosterEntry {
    index: u32,
    identity: Vec<u8>,
    signature_key: Vec<u8>,
}

#[wasm_bindgen]
impl RosterEntry {
    #[wasm_bindgen(getter)]
    pub fn index(&self) -> u32 {
        self.index
    }

    #[wasm_bindgen(getter)]
    pub fn identity(&self) -> Uint8Array {
        copy_to_js(&self.identity)
    }

    #[wasm_bindgen(getter)]
    pub fn signature_key(&self) -> Uint8Array {
        copy_to_js(&self.signature_key)
    }
}

#[wasm_bindgen]
pub struct MlsSession {
    provider: OpenMlsRustCrypto,
    signer: SignatureKeyPair,
    credential_with_key: CredentialWithKey,
    identity: Vec<u8>,
    room_binding: Vec<u8>,
    group: Option<MlsGroup>,
    poisoned: bool,
}

#[wasm_bindgen]
impl MlsSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        room_binding: Uint8Array,
        identity: Uint8Array,
        founder: bool,
    ) -> Result<MlsSession, JsError> {
        let room_binding = copy_fixed_from_js(&room_binding, ROOM_BINDING_BYTES, "room binding")
            .map_err(js_error)?;
        let identity =
            copy_fixed_from_js(&identity, IDENTITY_BYTES, "identity").map_err(js_error)?;

        let provider = OpenMlsRustCrypto::default();
        let signer = SignatureKeyPair::new(SignatureScheme::ED25519)
            .map_err(|error| js_error(message_error("identity generation failed", error)))?;
        signer
            .store(provider.storage())
            .map_err(|error| js_error(message_error("identity persistence failed", error)))?;
        let credential_with_key = CredentialWithKey {
            credential: BasicCredential::new(identity.0.clone()).into(),
            signature_key: signer.public().into(),
        };
        let group = if founder {
            Some(
                MlsGroup::builder()
                    .ciphersuite(CIPHERSUITE)
                    .padding_size(APPLICATION_PADDING_BLOCK_BYTES)
                    // Forward secrecy is a protocol invariant, not an
                    // incidental library default.  Pillowfort's relay orders
                    // each epoch, so retaining decryptors for prior epochs is
                    // unnecessary and would make a later state compromise
                    // expose already-erased traffic.
                    .max_past_epochs(0)
                    .number_of_resumption_psks(0)
                    .sender_ratchet_configuration(SenderRatchetConfiguration::new(
                        0,
                        SENDER_RATCHET_MAX_FORWARD_DISTANCE,
                    ))
                    .with_group_id(GroupId::from_slice(&room_binding))
                    .build(&provider, &signer, credential_with_key.clone())
                    .map_err(|error| js_error(message_error("group creation failed", error)))?,
            )
        } else {
            None
        };

        let session = MlsSession {
            provider,
            signer,
            credential_with_key,
            identity: identity.0.clone(),
            room_binding: room_binding.0.clone(),
            group,
            poisoned: false,
        };
        let mut validation_snapshot = session.snapshot_inner().map_err(js_error)?;
        validation_snapshot.zeroize();
        Ok(session)
    }

    pub fn key_package(&mut self) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            let bundle = KeyPackage::builder()
                .build(
                    CIPHERSUITE,
                    &self.provider,
                    &self.signer,
                    self.credential_with_key.clone(),
                )
                .map_err(|error| message_error("key package creation failed", error))?;
            let outbound = bundle
                .key_package()
                .tls_serialize_detached()
                .map_err(|error| message_error("key package serialization failed", error))?;
            if outbound.len() > MAX_KEY_PACKAGE_BYTES {
                return Err("generated key package exceeds the 16 KiB limit".to_string());
            }
            self.transition(
                1,
                outbound,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn add(&mut self, key_package: Uint8Array) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let key_package = copy_bounded_from_js(&key_package, MAX_KEY_PACKAGE_BYTES, "key package")
            .map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            let key_package = parse_key_package(&self.provider, &key_package)?;
            let provider = &self.provider;
            let signer = &self.signer;
            let group = self
                .group
                .as_mut()
                .ok_or_else(|| "session has not joined or created an MLS group".to_string())?;
            let (commit, welcome, _) = group
                .add_members(provider, signer, &[key_package])
                .map_err(|error| message_error("add commit creation failed", error))?;
            let outbound = serialize_message(&commit)?;
            let welcome = serialize_message(&welcome)?;
            group
                .merge_pending_commit(provider)
                .map_err(|error| message_error("local add commit merge failed", error))?;
            let ratchet_tree = group
                .export_ratchet_tree()
                .tls_serialize_detached()
                .map_err(|error| message_error("ratchet tree serialization failed", error))?;
            if ratchet_tree.len() > MAX_RATCHET_TREE_BYTES {
                return Err("ratchet tree exceeds the 64 KiB limit".to_string());
            }
            self.transition(
                2,
                outbound,
                welcome,
                ratchet_tree,
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn join(
        &mut self,
        welcome: Uint8Array,
        ratchet_tree: Uint8Array,
    ) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let welcome =
            copy_bounded_from_js(&welcome, MAX_MLS_MESSAGE_BYTES, "Welcome").map_err(js_error)?;
        let ratchet_tree =
            copy_bounded_from_js(&ratchet_tree, MAX_RATCHET_TREE_BYTES, "ratchet tree")
                .map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            if self.group.is_some() {
                return Err("session already has an MLS group".to_string());
            }
            let welcome = match parse_mls_message(&welcome)? {
                MlsMessageBodyIn::Welcome(welcome) => welcome,
                _ => return Err("join requires an MLS Welcome message".to_string()),
            };
            let tree = parse_ratchet_tree(&ratchet_tree)?;
            let config = MlsGroupJoinConfig::builder()
                .padding_size(APPLICATION_PADDING_BLOCK_BYTES)
                // Keep this in lock-step with founder configuration.  Do not
                // retain old epoch message secrets or unused resumption PSKs.
                .max_past_epochs(0)
                .number_of_resumption_psks(0)
                .sender_ratchet_configuration(SenderRatchetConfiguration::new(
                    0,
                    SENDER_RATCHET_MAX_FORWARD_DISTANCE,
                ))
                .build();
            let staged =
                StagedWelcome::new_from_welcome(&self.provider, &config, welcome, Some(tree))
                    .map_err(|error| message_error("Welcome processing failed", error))?;
            if staged.group_context().group_id().as_slice() != self.room_binding.as_slice() {
                return Err("Welcome belongs to a different room".to_string());
            }
            let group = staged
                .into_group(&self.provider)
                .map_err(|error| message_error("Welcome merge failed", error))?;
            self.group = Some(group);
            self.transition(
                3,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn remove(&mut self, leaf_index: u32) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            if self
                .group()?
                .member_at(LeafNodeIndex::new(leaf_index))
                .is_none()
            {
                return Err("remove target is not a current member".to_string());
            }
            let provider = &self.provider;
            let signer = &self.signer;
            let group = self
                .group
                .as_mut()
                .ok_or_else(|| "session has not joined or created an MLS group".to_string())?;
            let (commit, _, _) = group
                .remove_members(provider, signer, &[LeafNodeIndex::new(leaf_index)])
                .map_err(|error| message_error("remove commit creation failed", error))?;
            let outbound = serialize_message(&commit)?;
            group
                .merge_pending_commit(provider)
                .map_err(|error| message_error("local remove commit merge failed", error))?;
            self.transition(
                4,
                outbound,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn self_update(&mut self) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            let provider = &self.provider;
            let signer = &self.signer;
            let group = self
                .group
                .as_mut()
                .ok_or_else(|| "session has not joined or created an MLS group".to_string())?;
            let bundle = group
                .self_update(provider, signer, LeafNodeParameters::default())
                .map_err(|error| message_error("self-update creation failed", error))?;
            let (commit, _, _) = bundle.into_contents();
            let outbound = serialize_message(&commit)?;
            group
                .merge_pending_commit(provider)
                .map_err(|error| message_error("local self-update merge failed", error))?;
            self.transition(
                5,
                outbound,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn encrypt(&mut self, plaintext: Uint8Array) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let plaintext =
            copy_bounded_from_js(&plaintext, MAX_APPLICATION_BYTES, "application plaintext")
                .map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            let provider = &self.provider;
            let signer = &self.signer;
            let group = self
                .group
                .as_mut()
                .ok_or_else(|| "session has not joined or created an MLS group".to_string())?;
            let message = group
                .create_message(provider, signer, &plaintext)
                .map_err(|error| message_error("application encryption failed", error))?;
            let outbound = serialize_message(&message)?;
            self.transition(
                6,
                outbound,
                Vec::new(),
                Vec::new(),
                Vec::new(),
                Vec::new(),
                u32::MAX,
                CommitSummary::default(),
            )
        })();
        self.finish(result)
    }

    pub fn receive(&mut self, message: Uint8Array) -> Result<MlsTransition, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let message = copy_bounded_from_js(&message, MAX_MLS_MESSAGE_BYTES, "MLS message")
            .map_err(js_error)?;
        let result = (|| -> AdapterResult<MlsTransition> {
            let protocol_message: ProtocolMessage = match parse_mls_message(&message)? {
                MlsMessageBodyIn::PublicMessage(message) => message.into(),
                MlsMessageBodyIn::PrivateMessage(message) => message.into(),
                _ => return Err("receive accepts only MLS group messages".to_string()),
            };
            let provider = &self.provider;
            let group = self
                .group
                .as_mut()
                .ok_or_else(|| "session has not joined or created an MLS group".to_string())?;
            let processed = group
                .process_message(provider, protocol_message)
                .map_err(|error| message_error("MLS message processing failed", error))?;
            if processed.group_id().as_slice() != self.room_binding.as_slice() {
                return Err("MLS message belongs to a different room".to_string());
            }
            let sender_leaf_index = match processed.sender() {
                Sender::Member(index) => index.u32(),
                _ => u32::MAX,
            };
            let sender_identity = processed.credential().serialized_content().to_vec();
            match processed.into_content() {
                ProcessedMessageContent::ApplicationMessage(application) => self.transition(
                    7,
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    application.into_bytes(),
                    sender_identity,
                    sender_leaf_index,
                    CommitSummary::default(),
                ),
                ProcessedMessageContent::ProposalMessage(proposal)
                | ProcessedMessageContent::ExternalJoinProposalMessage(proposal) => {
                    group
                        .store_pending_proposal(provider.storage(), *proposal)
                        .map_err(|error| message_error("proposal persistence failed", error))?;
                    self.transition(
                        8,
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        sender_identity,
                        sender_leaf_index,
                        CommitSummary::default(),
                    )
                }
                ProcessedMessageContent::StagedCommitMessage(commit) => {
                    let add_count = u32::try_from(commit.add_proposals().count())
                        .map_err(|_| "commit contains too many Add proposals".to_string())?;
                    let remove_count = u32::try_from(commit.remove_proposals().count())
                        .map_err(|_| "commit contains too many Remove proposals".to_string())?;
                    let update_count = u32::try_from(commit.update_proposals().count())
                        .map_err(|_| "commit contains too many Update proposals".to_string())?;
                    let queued_count = u32::try_from(commit.queued_proposals().count())
                        .map_err(|_| "commit contains too many proposals".to_string())?;
                    let known_count = add_count
                        .checked_add(remove_count)
                        .and_then(|count| count.checked_add(update_count))
                        .ok_or_else(|| "commit proposal count overflowed".to_string())?;
                    let other_count = queued_count
                        .checked_sub(known_count)
                        .ok_or_else(|| "commit proposal summary is inconsistent".to_string())?;
                    let summary = CommitSummary {
                        add_count,
                        remove_count,
                        update_count,
                        other_count,
                        has_update_path: commit.update_path_leaf_node().is_some(),
                    };
                    group
                        .merge_staged_commit(provider, *commit)
                        .map_err(|error| message_error("commit merge failed", error))?;
                    self.transition(
                        9,
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        sender_identity,
                        sender_leaf_index,
                        summary,
                    )
                }
            }
        })();
        self.finish(result)
    }

    pub fn snapshot(&self) -> Result<Uint8Array, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let mut snapshot = self.snapshot_inner().map_err(js_error)?;
        let exported = copy_to_js(&snapshot);
        snapshot.zeroize();
        Ok(exported)
    }

    pub fn sign(&self, data: Uint8Array) -> Result<Vec<u8>, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let data = copy_at_most_from_js(&data, MAX_SIGNATURE_PAYLOAD_BYTES, "signature payload")
            .map_err(js_error)?;
        let signature = self
            .signer
            .sign(&data)
            .map_err(|error| js_error(message_error("signature generation failed", error)))?;
        if signature.len() != ED25519_SIGNATURE_BYTES {
            return Err(JsError::new(
                "Ed25519 signer returned the wrong signature length",
            ));
        }
        Ok(signature)
    }

    pub fn restore(
        expected_room_binding: Uint8Array,
        snapshot: Uint8Array,
    ) -> Result<MlsSession, JsError> {
        let expected_room_binding = copy_fixed_from_js(
            &expected_room_binding,
            ROOM_BINDING_BYTES,
            "expected room binding",
        )
        .map_err(js_error)?;
        let snapshot =
            copy_bounded_from_js(&snapshot, MAX_SNAPSHOT_BYTES, "snapshot").map_err(js_error)?;
        let mut decoded = decode_snapshot(&snapshot).map_err(js_error)?;
        if decoded.room_binding.as_slice() != expected_room_binding.as_ref() {
            return Err(JsError::new("snapshot room binding does not match"));
        }
        let provider = OpenMlsRustCrypto::default();
        provider
            .crypto()
            .verify_signature(
                SignatureScheme::ED25519,
                &decoded.signed_payload,
                &decoded.signature_public_key,
                &decoded.signature,
            )
            .map_err(|error| {
                js_error(message_error(
                    "snapshot signature verification failed",
                    error,
                ))
            })?;

        {
            let mut values = provider
                .storage()
                .values
                .write()
                .map_err(|_| JsError::new("OpenMLS storage lock is unavailable"))?;
            *values = std::mem::take(&mut decoded.records);
        }
        let signer = SignatureKeyPair::read(
            provider.storage(),
            &decoded.signature_public_key,
            SignatureScheme::ED25519,
        )
        .ok_or_else(|| JsError::new("snapshot does not contain its signing identity"))?;
        if signer.public() != decoded.signature_public_key.as_slice() {
            return Err(JsError::new("snapshot signing identity is inconsistent"));
        }
        let credential_with_key = CredentialWithKey {
            credential: BasicCredential::new(decoded.identity.clone()).into(),
            signature_key: signer.public().into(),
        };
        let group = if decoded.group_id.is_empty() {
            None
        } else {
            if decoded.group_id != decoded.room_binding {
                return Err(JsError::new("snapshot group ID is not room-bound"));
            }
            let group_id = GroupId::from_slice(&decoded.group_id);
            let loaded = MlsGroup::load(provider.storage(), &group_id)
                .map_err(|error| js_error(message_error("snapshot group load failed", error)))?
                .ok_or_else(|| JsError::new("snapshot is missing complete MLS group state"))?;
            if loaded.group_id().as_slice() != decoded.room_binding.as_slice() {
                return Err(JsError::new(
                    "restored MLS group belongs to a different room",
                ));
            }
            if loaded.is_active() {
                let own_leaf = loaded
                    .own_leaf()
                    .ok_or_else(|| JsError::new("active snapshot has no local MLS leaf"))?;
                if own_leaf.credential().serialized_content() != decoded.identity.as_slice()
                    || own_leaf.signature_key().as_slice() != signer.public()
                {
                    return Err(JsError::new(
                        "snapshot identity does not match its MLS leaf",
                    ));
                }
            }
            Some(loaded)
        };

        let session = MlsSession {
            provider,
            signer,
            credential_with_key,
            identity: std::mem::take(&mut decoded.identity),
            room_binding: std::mem::take(&mut decoded.room_binding),
            group,
            poisoned: false,
        };
        let mut validation_snapshot = session.snapshot_inner().map_err(js_error)?;
        validation_snapshot.zeroize();
        Ok(session)
    }

    pub fn is_active(&self) -> bool {
        !self.poisoned && self.group.as_ref().is_some_and(MlsGroup::is_active)
    }

    pub fn roster(&self) -> Result<Array, JsError> {
        self.ensure_usable().map_err(js_error)?;
        let entries = Array::new();
        if let Some(group) = &self.group {
            for member in group.members() {
                let entry = RosterEntry {
                    index: member.index.u32(),
                    identity: member.credential.serialized_content().to_vec(),
                    signature_key: member.signature_key,
                };
                entries.push(&JsValue::from(entry));
            }
        }
        Ok(entries)
    }
}

impl Drop for MlsSession {
    fn drop(&mut self) {
        // OpenMLS' in-memory provider owns serialized secret material in byte
        // vectors.  Clear those allocations before the map is released.  The
        // upstream basic-credential type does not currently expose its private
        // vector for zeroization, so this is best-effort rather than a claim of
        // perfect physical erasure of every allocator copy.
        if let Ok(mut values) = self.provider.storage().values.write() {
            for (mut key, mut value) in values.drain() {
                key.zeroize();
                value.zeroize();
            }
        }
        self.identity.zeroize();
        self.room_binding.zeroize();
    }
}

impl MlsSession {
    fn ensure_usable(&self) -> AdapterResult<()> {
        if self.poisoned {
            return Err(
                "MLS session is poisoned; discard it and restore the last durable snapshot"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn group(&self) -> AdapterResult<&MlsGroup> {
        self.group
            .as_ref()
            .ok_or_else(|| "session has not joined or created an MLS group".to_string())
    }

    fn finish(&mut self, result: AdapterResult<MlsTransition>) -> Result<MlsTransition, JsError> {
        match result {
            Ok(transition) => Ok(transition),
            Err(error) => {
                self.poisoned = true;
                Err(js_error(error))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn transition(
        &self,
        kind: u8,
        outbound: Vec<u8>,
        welcome: Vec<u8>,
        ratchet_tree: Vec<u8>,
        plaintext: Vec<u8>,
        sender_identity: Vec<u8>,
        sender_leaf_index: u32,
        commit_summary: CommitSummary,
    ) -> AdapterResult<MlsTransition> {
        let snapshot = self.snapshot_inner()?;
        let epoch = self
            .group
            .as_ref()
            .map_or(0, |group| group.epoch().as_u64());
        Ok(MlsTransition {
            kind,
            outbound,
            welcome,
            ratchet_tree,
            plaintext,
            sender_identity,
            sender_leaf_index,
            snapshot,
            epoch,
            commit_add_count: commit_summary.add_count,
            commit_remove_count: commit_summary.remove_count,
            commit_update_count: commit_summary.update_count,
            commit_other_count: commit_summary.other_count,
            commit_has_update_path: commit_summary.has_update_path,
        })
    }

    fn snapshot_inner(&self) -> AdapterResult<Vec<u8>> {
        let values = self
            .provider
            .storage()
            .values
            .read()
            .map_err(|_| "OpenMLS storage lock is unavailable".to_string())?;
        if values.len() > MAX_STORAGE_RECORDS {
            return Err("OpenMLS storage contains too many records".to_string());
        }
        let mut records: Vec<_> = values.iter().collect();
        records.sort_by(|left, right| left.0.cmp(right.0));

        // Reserve the exact final size before writing secret-bearing JSON
        // records. Ordinary Vec growth frees unsanitized predecessor buffers,
        // leaving fragments of a prior epoch in linear memory even when the
        // final snapshot is later wiped.
        let mut output_capacity = SNAPSHOT_MAGIC
            .len()
            .checked_add(2 + 2)
            .and_then(|size| size.checked_add(4 + self.room_binding.len()))
            .and_then(|size| size.checked_add(4 + self.identity.len()))
            .and_then(|size| size.checked_add(4 + self.signer.public().len()))
            .and_then(|size| {
                size.checked_add(
                    4 + self
                        .group
                        .as_ref()
                        .map_or(0, |group| group.group_id().as_slice().len()),
                )
            })
            .and_then(|size| size.checked_add(4))
            .ok_or_else(|| "snapshot size overflowed".to_string())?;
        for (key, value) in &records {
            output_capacity = output_capacity
                .checked_add(4 + key.len())
                .and_then(|size| size.checked_add(4 + value.len()))
                .ok_or_else(|| "snapshot size overflowed".to_string())?;
        }
        output_capacity = output_capacity
            .checked_add(2 + ED25519_SIGNATURE_BYTES)
            .ok_or_else(|| "snapshot size overflowed".to_string())?;
        if output_capacity > MAX_SNAPSHOT_BYTES {
            return Err("snapshot exceeds the 8 MiB persistence limit".to_string());
        }
        let mut output = Vec::with_capacity(output_capacity);
        output.extend_from_slice(SNAPSHOT_MAGIC);
        push_u16(&mut output, SNAPSHOT_VERSION);
        push_u16(&mut output, CIPHERSUITE_ID);
        push_bytes(&mut output, &self.room_binding, "room binding")?;
        push_bytes(&mut output, &self.identity, "identity")?;
        push_bytes(&mut output, self.signer.public(), "signature public key")?;
        if let Some(group) = &self.group {
            push_bytes(&mut output, group.group_id().as_slice(), "group ID")?;
        } else {
            push_bytes(&mut output, &[], "group ID")?;
        }
        let record_count = u32::try_from(records.len())
            .map_err(|_| "OpenMLS storage record count is too large".to_string())?;
        push_u32(&mut output, record_count);
        for (key, value) in records {
            validate_storage_record(key, value)?;
            push_bytes(&mut output, key, "storage key")?;
            push_bytes(&mut output, value, "storage value")?;
        }
        drop(values);

        let signature = self
            .signer
            .sign(&output)
            .map_err(|error| message_error("snapshot signing failed", error))?;
        if signature.len() != ED25519_SIGNATURE_BYTES {
            return Err("snapshot signer returned the wrong signature length".to_string());
        }
        push_u16(&mut output, ED25519_SIGNATURE_BYTES as u16);
        output.extend_from_slice(&signature);
        if output.len() > MAX_SNAPSHOT_BYTES {
            return Err("snapshot exceeds the 8 MiB persistence limit".to_string());
        }
        Ok(output)
    }
}
