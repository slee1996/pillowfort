use hpke_rs::{
    hpke_types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm},
    Hpke, Mode,
};
use hpke_rs_rust_crypto::HpkeRustCrypto;

#[test]
fn mls_ciphersuite_one_hpke_round_trip() {
    let mut hpke = Hpke::<HpkeRustCrypto>::new(
        Mode::Base,
        KemAlgorithm::DhKem25519,
        KdfAlgorithm::HkdfSha256,
        AeadAlgorithm::Aes128Gcm,
    );
    let (receiver_private, receiver_public) = hpke
        .generate_key_pair()
        .expect("suite-1 X25519 key generation must remain available")
        .into_keys();
    let info = b"Pillowfort MLS ciphersuite 1 HPKE test";
    let aad = b"authenticated test metadata";
    let plaintext = b"application event";

    let (encapsulated, ciphertext) = hpke
        .seal(&receiver_public, info, aad, plaintext, None, None, None)
        .expect("suite-1 HPKE sealing must remain available");
    let opened = hpke
        .open(
            &encapsulated,
            &receiver_private,
            info,
            aad,
            &ciphertext,
            None,
            None,
            None,
        )
        .expect("suite-1 HPKE opening must remain available");

    assert_eq!(opened, plaintext);
}
