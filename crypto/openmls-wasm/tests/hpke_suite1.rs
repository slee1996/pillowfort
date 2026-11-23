use hpke_rs::{
    hpke_types::{AeadAlgorithm, KdfAlgorithm, KemAlgorithm},
    Hpke, Mode,
};
use hpke_rs_rust_crypto::HpkeRustCrypto;
use hpke_rs_crypto::HpkeCrypto;
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    crypto::OpenMlsCrypto,
    signatures::Signer,
    types::{
        Ciphersuite, CryptoError, HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType,
        HpkeKemType, SignatureScheme,
    },
};

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

fn suite_one_hpke_config() -> HpkeConfig {
    HpkeConfig(
        HpkeKemType::DhKem25519,
        HpkeKdfType::HkdfSha256,
        HpkeAeadType::AesGcm128,
    )
}

#[test]
fn suite_one_provider_signatures_hpke_and_exporters_round_trip() {
    let crypto = RustCrypto::default();
    let suite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    assert_eq!(crypto.supported_ciphersuites(), vec![suite]);
    assert_eq!(crypto.supports(suite), Ok(()));

    let message = b"Pillowfort suite-1 provider regression";
    let (private, public) = crypto.signature_key_gen(SignatureScheme::ED25519).unwrap();
    let signature = crypto.sign(SignatureScheme::ED25519, message, &private).unwrap();
    crypto.verify_signature(SignatureScheme::ED25519, message, &public, &signature).unwrap();
    assert!(crypto.verify_signature(SignatureScheme::ED25519, b"tampered", &public, &signature).is_err());

    let signer = SignatureKeyPair::new(SignatureScheme::ED25519).unwrap();
    let signature = signer.sign(message).unwrap();
    crypto.verify_signature(SignatureScheme::ED25519, message, signer.public(), &signature).unwrap();
    let persisted = serde_json::to_vec(&signer).unwrap();
    let restored: SignatureKeyPair = serde_json::from_slice(&persisted).unwrap();
    assert_eq!(restored.public(), signer.public());
    crypto.verify_signature(
        SignatureScheme::ED25519, message, restored.public(), &restored.sign(message).unwrap(),
    ).unwrap();

    let keys = crypto.derive_hpke_keypair(suite_one_hpke_config(), &[7; 32]).unwrap();
    let repeated = crypto.derive_hpke_keypair(suite_one_hpke_config(), &[7; 32]).unwrap();
    assert_eq!(keys.public, repeated.public);
    assert_eq!(&*keys.private, &*repeated.private);
    let info = b"MLS provider info";
    let aad = b"MLS authenticated metadata";
    let sealed = crypto.hpke_seal(suite_one_hpke_config(), &keys.public, info, aad, message).unwrap();
    assert_eq!(
        crypto.hpke_open(suite_one_hpke_config(), &sealed, &keys.private, info, aad).unwrap(),
        message,
    );
    assert!(crypto.hpke_open(suite_one_hpke_config(), &sealed, &keys.private, info, b"tampered").is_err());

    let context = b"MLS exporter";
    let (enc, sender_secret) = crypto.hpke_setup_sender_and_export(
        suite_one_hpke_config(), &keys.public, info, context, 32,
    ).unwrap();
    let receiver_secret = crypto.hpke_setup_receiver_and_export(
        suite_one_hpke_config(), &enc, &keys.private, info, context, 32,
    ).unwrap();
    assert_eq!(&*sender_secret, &*receiver_secret);
}

#[test]
fn provider_rejects_every_non_suite_one_ciphersuite_and_signature() {
    let crypto = RustCrypto::default();
    for id in [2_u16, 3, 4, 5, 6, 7, 0x004d] {
        assert_eq!(
            crypto.supports(Ciphersuite::try_from(id).unwrap()),
            Err(CryptoError::UnsupportedCiphersuite),
        );
    }
    for scheme in [
        SignatureScheme::ECDSA_SECP256R1_SHA256,
        SignatureScheme::ECDSA_SECP384R1_SHA384,
        SignatureScheme::ECDSA_SECP521R1_SHA512,
        SignatureScheme::ED448,
    ] {
        assert_eq!(crypto.signature_key_gen(scheme), Err(CryptoError::UnsupportedSignatureScheme));
        assert_eq!(crypto.sign(scheme, b"message", &[]), Err(CryptoError::UnsupportedSignatureScheme));
        assert_eq!(
            crypto.verify_signature(scheme, b"message", &[], &[]),
            Err(CryptoError::UnsupportedSignatureScheme),
        );
        assert!(matches!(SignatureKeyPair::new(scheme), Err(CryptoError::UnsupportedSignatureScheme)));
        // Loading raw/persisted unsupported keys must not bypass signing rejection.
        assert!(SignatureKeyPair::from_raw(scheme, vec![], vec![]).sign(b"message").is_err());
    }
}

#[test]
fn every_provider_hpke_entrypoint_rejects_non_suite_one_configuration() {
    let crypto = RustCrypto::default();
    let mut unsupported = Vec::new();
    for kem in [
        HpkeKemType::DhKemP256,
        HpkeKemType::DhKemP384,
        HpkeKemType::DhKemP521,
        HpkeKemType::DhKem448,
        HpkeKemType::XWingKemDraft6,
    ] {
        unsupported.push((kem, HpkeKdfType::HkdfSha256, HpkeAeadType::AesGcm128));
    }
    for kdf in [HpkeKdfType::HkdfSha384, HpkeKdfType::HkdfSha512] {
        unsupported.push((HpkeKemType::DhKem25519, kdf, HpkeAeadType::AesGcm128));
    }
    for aead in [HpkeAeadType::AesGcm256, HpkeAeadType::ChaCha20Poly1305, HpkeAeadType::Export] {
        unsupported.push((HpkeKemType::DhKem25519, HpkeKdfType::HkdfSha256, aead));
    }
    let ciphertext = HpkeCiphertext { kem_output: vec![].into(), ciphertext: vec![].into() };
    for (kem, kdf, aead) in unsupported {
        let config = || HpkeConfig(kem, kdf, aead);
        assert!(matches!(
            crypto.derive_hpke_keypair(config(), &[]),
            Err(CryptoError::UnsupportedCiphersuite),
        ));
        assert!(matches!(
            crypto.hpke_seal(config(), &[], &[], &[], &[]),
            Err(CryptoError::UnsupportedCiphersuite),
        ));
        assert_eq!(
            crypto.hpke_open(config(), &ciphertext, &[], &[], &[]),
            Err(CryptoError::UnsupportedCiphersuite),
        );
        assert!(matches!(
            crypto.hpke_setup_sender_and_export(config(), &[], &[], &[], 32),
            Err(CryptoError::UnsupportedCiphersuite),
        ));
        assert!(matches!(
            crypto.hpke_setup_receiver_and_export(config(), &[], &[], &[], &[], 32),
            Err(CryptoError::UnsupportedCiphersuite),
        ));
    }
}

#[test]
fn hpke_backend_rejects_removed_kems_without_fallback() {
    assert!(HpkeRustCrypto::supports_kem(KemAlgorithm::DhKem25519).is_ok());
    let mut rng = HpkeRustCrypto::prng();
    for kem in [
        KemAlgorithm::DhKemP256,
        KemAlgorithm::DhKemP384,
        KemAlgorithm::DhKemP521,
        KemAlgorithm::DhKemK256,
        KemAlgorithm::DhKem448,
        KemAlgorithm::XWingDraft06,
        KemAlgorithm::try_from(0x004d_u16).unwrap(),
        KemAlgorithm::MlKem768,
        KemAlgorithm::MlKem1024,
    ] {
        assert!(HpkeRustCrypto::supports_kem(kem).is_err());
        assert!(HpkeRustCrypto::dh(kem, &[0; 32], &[1; 32]).is_err());
        assert!(HpkeRustCrypto::secret_to_public(kem, &[1; 32]).is_err());
        assert!(HpkeRustCrypto::kem_key_gen(kem, &mut rng).is_err());
        assert!(HpkeRustCrypto::dh_validate_sk(kem, &[1; 32]).is_err());
        assert!(HpkeRustCrypto::kem_key_gen_derand(kem, &[1; 32]).is_err());
        assert!(HpkeRustCrypto::kem_encaps(kem, &[0; 32], &mut rng).is_err());
        assert!(HpkeRustCrypto::kem_decaps(kem, &[0; 32], &[1; 32]).is_err());
    }
    // Keep upstream's X25519 low-order/all-zero shared-secret rejection.
    assert!(HpkeRustCrypto::dh(KemAlgorithm::DhKem25519, &[0; 32], &[1; 32]).is_err());
}

// RFC 9180 Appendix A.1.1, Base setup. These public inputs and expected outputs
// are not generated by the provider under test. https://www.rfc-editor.org/rfc/rfc9180#appendix-A.1.1
#[test]
fn provider_matches_rfc9180_appendix_a_1_1() {
    fn hex(s: &str) -> Vec<u8> {
        assert!(s.len().is_multiple_of(2));
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    let crypto = RustCrypto::default();
    let ikm = hex("6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037");
    let keys = crypto.derive_hpke_keypair(suite_one_hpke_config(), &ikm).unwrap();
    assert_eq!(keys.public.as_slice(), hex("3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d"));
    assert_eq!(&*keys.private, hex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"));
    let enc = hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431");
    let info = b"Ode on a Grecian Urn";
    let ct = HpkeCiphertext { kem_output: enc.clone().into(), ciphertext: hex(concat!(
        "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a9", "6d8770ac83d07bea87e13c512a")).into() };
    assert_eq!(crypto.hpke_open(suite_one_hpke_config(), &ct, &keys.private, info, b"Count-0").unwrap(),
        b"Beauty is truth, truth beauty");
    for (context, expected) in [
        (&b""[..], "3853fe2b4035195a573ffc53856e77058e15d9ea064de3e59f4961d0095250ee"),
        (&[0][..], "2e8f0b54673c7029649d4eb9d5e33bf1872cf76d623ff164ac185da9e88c21a5"),
        (&b"TestContext"[..], "e9e43065102c3836401bed8c3c3c75ae46be1639869391d62c61f1ec7af54931"),
    ] {
        let secret = crypto.hpke_setup_receiver_and_export(suite_one_hpke_config(), &enc, &keys.private, info, context, 32).unwrap();
        assert_eq!(&*secret, hex(expected));
    }
}
