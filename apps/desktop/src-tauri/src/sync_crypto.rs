use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use unicode_normalization::UnicodeNormalization;

pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const GCM_TAG_LEN: usize = 16;
pub const KEY_LEN: usize = 32;
pub const HEADER_LEN: usize = 54;

const MAGIC: &[u8; 6] = b"MWENC1";
const FORMAT_VERSION: u8 = 0x02;
const KDF_ID_ARGON2ID: u8 = 0x01;
const CIPHER_ID_AES_256_GCM: u8 = 0x01;

const KDF_COST_CEILING_M_KIB: u32 = 262144;
const KDF_COST_CEILING_T: u32 = 16;
const KDF_COST_CEILING_P: u8 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncCryptoKdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u8,
}

pub const SYNC_CRYPTO_DEFAULT_KDF_PARAMS: SyncCryptoKdfParams = SyncCryptoKdfParams {
    m_kib: 19456,
    t: 2,
    p: 1,
};

#[derive(Debug, Clone)]
pub struct SyncKeyMaterial {
    pub key: [u8; KEY_LEN],
    pub salt: [u8; SALT_LEN],
    pub params: SyncCryptoKdfParams,
}

#[derive(Debug)]
pub enum SyncCryptoError {
    Auth,
    Unsupported(String),
}

impl std::fmt::Display for SyncCryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncCryptoError::Auth => write!(f, "wrong passphrase or corrupted data"),
            SyncCryptoError::Unsupported(reason) => write!(f, "{reason}"),
        }
    }
}

impl std::error::Error for SyncCryptoError {}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

fn check_kdf_cost_ceiling(params: SyncCryptoKdfParams) -> Result<(), SyncCryptoError> {
    if params.m_kib > KDF_COST_CEILING_M_KIB || params.t > KDF_COST_CEILING_T || params.p > KDF_COST_CEILING_P {
        return Err(SyncCryptoError::Unsupported(format!(
            "MWENC1 KDF cost exceeds accepted ceiling (m_kib<={KDF_COST_CEILING_M_KIB}, t<={KDF_COST_CEILING_T}, p<={KDF_COST_CEILING_P})"
        )));
    }
    Ok(())
}

pub fn derive_sync_key_material(
    passphrase: &str,
    salt: [u8; SALT_LEN],
    params: SyncCryptoKdfParams,
) -> Result<SyncKeyMaterial, SyncCryptoError> {
    check_kdf_cost_ceiling(params)?;

    let normalized: String = passphrase.nfc().collect();
    let argon2_params = Params::new(params.m_kib, params.t, u32::from(params.p), Some(KEY_LEN))
        .map_err(|err| SyncCryptoError::Unsupported(format!("invalid Argon2id params: {err}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2_params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(normalized.as_bytes(), &salt, &mut key)
        .map_err(|err| SyncCryptoError::Unsupported(format!("Argon2id derivation failed: {err}")))?;
    Ok(SyncKeyMaterial { key, salt, params })
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn write_u32_le(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u64_le(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn write_u64_le(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn has_magic(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

#[derive(Debug, Clone)]
pub struct ParsedHeaderFields {
    pub format_version: u8,
    pub kdf_id: u8,
    pub params: SyncCryptoKdfParams,
    pub cipher_id: u8,
    pub salt: [u8; SALT_LEN],
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext_len: u64,
}

fn parse_header(bytes: &[u8]) -> Result<ParsedHeaderFields, SyncCryptoError> {
    if bytes.len() < HEADER_LEN {
        return Err(SyncCryptoError::Unsupported("MWENC1 header truncated".into()));
    }
    let format_version = bytes[6];
    let kdf_id = bytes[7];
    let cipher_id = bytes[17];
    if format_version != FORMAT_VERSION && format_version != 1 {
        return Err(SyncCryptoError::Unsupported(format!("unsupported MWENC1 format_version {format_version}")));
    }
    if kdf_id != KDF_ID_ARGON2ID {
        return Err(SyncCryptoError::Unsupported(format!("unsupported MWENC1 kdf_id {kdf_id}")));
    }
    if cipher_id != CIPHER_ID_AES_256_GCM {
        return Err(SyncCryptoError::Unsupported(format!("unsupported MWENC1 cipher_id {cipher_id}")));
    }
    let m_kib = read_u32_le(bytes, 8);
    let t = read_u32_le(bytes, 12);
    let p = bytes[16];
    check_kdf_cost_ceiling(SyncCryptoKdfParams { m_kib, t, p })?;
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&bytes[18..34]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[34..46]);
    let ciphertext_len = read_u64_le(bytes, 46);
    let remaining = (bytes.len() - HEADER_LEN) as u64;
    if ciphertext_len > remaining {
        return Err(SyncCryptoError::Unsupported("MWENC1 ciphertext_len exceeds available bytes".into()));
    }
    Ok(ParsedHeaderFields {
        format_version,
        kdf_id,
        params: SyncCryptoKdfParams { m_kib, t, p },
        cipher_id,
        salt,
        nonce,
        ciphertext_len,
    })
}

#[derive(Debug, Clone)]
pub enum SyncArtifactInspection {
    Encrypted(ParsedHeaderFields),
    Unsupported(String),
    Plaintext,
}

pub fn inspect_sync_artifact(bytes: &[u8]) -> SyncArtifactInspection {
    if !has_magic(bytes) {
        return SyncArtifactInspection::Plaintext;
    }
    match parse_header(bytes) {
        Ok(header) => SyncArtifactInspection::Encrypted(header),
        Err(SyncCryptoError::Unsupported(reason)) => SyncArtifactInspection::Unsupported(reason),
        Err(SyncCryptoError::Auth) => unreachable!("parse_header never returns Auth"),
    }
}

pub fn encrypt_sync_document(
    plaintext: &[u8],
    material: &SyncKeyMaterial,
) -> Result<Vec<u8>, SyncCryptoError> {
    if material.params.p == 0 {
        return Err(SyncCryptoError::Unsupported("sync key material params.p must be >= 1".into()));
    }
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    encrypt_context_artifact_with_nonce(plaintext, material, nonce_bytes, ArtifactContext::Document)
}

fn encrypt_context_artifact_with_nonce(
    plaintext: &[u8],
    material: &SyncKeyMaterial,
    nonce_bytes: [u8; NONCE_LEN],
    context: ArtifactContext<'_>,
) -> Result<Vec<u8>, SyncCryptoError> {
    let ciphertext_len = (plaintext.len() + GCM_TAG_LEN) as u64;
    let mut header = [0u8; HEADER_LEN];
    header[..6].copy_from_slice(MAGIC);
    header[6] = FORMAT_VERSION;
    header[7] = KDF_ID_ARGON2ID;
    write_u32_le(&mut header, 8, material.params.m_kib);
    write_u32_le(&mut header, 12, material.params.t);
    header[16] = material.params.p;
    header[17] = CIPHER_ID_AES_256_GCM;
    header[18..34].copy_from_slice(&material.salt);
    header[34..46].copy_from_slice(&nonce_bytes);
    write_u64_le(&mut header, 46, ciphertext_len);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&material.key));
    let nonce = Nonce::from_slice(&nonce_bytes);
    let aad = artifact_authenticated_data(&header, context)?;
    let ct_and_tag = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::Auth)?;

    let mut out = Vec::with_capacity(HEADER_LEN + ct_and_tag.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ct_and_tag);
    Ok(out)
}

pub fn decrypt_sync_document(
    bytes: &[u8],
    key: &[u8; KEY_LEN],
) -> Result<Vec<u8>, SyncCryptoError> {
    decrypt_context_artifact(bytes, key, ArtifactContext::Document)
}

fn decrypt_context_artifact(
    bytes: &[u8],
    key: &[u8; KEY_LEN],
    context: ArtifactContext<'_>,
) -> Result<Vec<u8>, SyncCryptoError> {
    if !has_magic(bytes) {
        return Err(SyncCryptoError::Unsupported("missing MWENC1 magic".into()));
    }
    let header = parse_header(bytes)?;
    if header.format_version != FORMAT_VERSION {
        return Err(SyncCryptoError::Unsupported(
            "SYNC_ENCRYPTION_LEGACY: upgrade sync encryption from a trusted local library".into(),
        ));
    }
    let aad = artifact_authenticated_data(&bytes[..HEADER_LEN], context)?;
    let ct_and_tag = &bytes[HEADER_LEN..HEADER_LEN + header.ciphertext_len as usize];

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&header.nonce);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ct_and_tag,
                aad: &aad,
            },
        )
        .map_err(|_| SyncCryptoError::Auth)
}

#[derive(Clone, Copy)]
enum ArtifactContext<'a> {
    Document,
    Attachment(&'a str),
    Recovery(&'a str),
}

fn artifact_authenticated_data(
    header: &[u8],
    context: ArtifactContext<'_>,
) -> Result<Vec<u8>, SyncCryptoError> {
    let identity = match context {
        ArtifactContext::Document => "mindwtr-sync:2\0document\0data.json".to_string(),
        ArtifactContext::Attachment(name)
            if name.starts_with("attachments/") && name.len() > 12 =>
        {
            format!("mindwtr-sync:2\0attachment\0{name}")
        }
        ArtifactContext::Recovery(name) if !name.is_empty() => {
            format!("mindwtr-sync:2\0recovery\0{name}")
        }
        _ => {
            return Err(SyncCryptoError::Unsupported(
                "Missing canonical artifact identity".into(),
            ))
        }
    };
    if header.len() + identity.len() > 65536 {
        return Err(SyncCryptoError::Unsupported(
            "Sync artifact identity exceeds authenticated-data capacity".into(),
        ));
    }
    let mut aad = header.to_vec();
    aad.extend_from_slice(identity.as_bytes());
    Ok(aad)
}

pub fn encrypt_sync_attachment(
    plaintext: &[u8],
    material: &SyncKeyMaterial,
    cloud_key: &str,
) -> Result<Vec<u8>, SyncCryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    encrypt_context_artifact_with_nonce(
        plaintext,
        material,
        nonce,
        ArtifactContext::Attachment(cloud_key),
    )
}

pub fn decrypt_sync_attachment(
    bytes: &[u8],
    key: &[u8; KEY_LEN],
    cloud_key: &str,
) -> Result<Vec<u8>, SyncCryptoError> {
    decrypt_context_artifact(bytes, key, ArtifactContext::Attachment(cloud_key))
}

pub fn encrypt_sync_recovery(
    plaintext: &[u8],
    material: &SyncKeyMaterial,
    identity: &str,
) -> Result<Vec<u8>, SyncCryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    encrypt_context_artifact_with_nonce(
        plaintext,
        material,
        nonce,
        ArtifactContext::Recovery(identity),
    )
}

pub fn decrypt_sync_recovery(
    bytes: &[u8],
    key: &[u8; KEY_LEN],
    identity: &str,
) -> Result<Vec<u8>, SyncCryptoError> {
    decrypt_context_artifact(bytes, key, ArtifactContext::Recovery(identity))
}

#[cfg(test)]
fn decrypt_legacy_artifact_for_upgrade(
    bytes: &[u8],
    key: &[u8; KEY_LEN],
) -> Result<Vec<u8>, SyncCryptoError> {
    if !has_magic(bytes) {
        return Err(SyncCryptoError::Unsupported(
            "Missing legacy encrypted artifact".into(),
        ));
    }
    let header = parse_header(bytes)?;
    if header.format_version != 1 {
        return Err(SyncCryptoError::Unsupported(
            "Expected a legacy encrypted artifact".into(),
        ));
    }
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(
            Nonce::from_slice(&header.nonce),
            Payload {
                msg: &bytes[HEADER_LEN..HEADER_LEN + header.ciphertext_len as usize],
                aad: &bytes[..HEADER_LEN],
            },
        )
        .map_err(|_| SyncCryptoError::Auth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Vector {
        name: String,
        passphrase: String,
        #[serde(rename = "saltB64")]
        salt_b64: String,
        params: VectorParams,
        #[serde(rename = "nonceB64")]
        nonce_b64: String,
        #[serde(rename = "plaintextB64")]
        plaintext_b64: String,
        #[serde(rename = "encryptedB64")]
        encrypted_b64: String,
    }

    #[derive(Deserialize)]
    struct VectorParams {
        #[serde(rename = "mKib")]
        m_kib: u32,
        t: u32,
        p: u8,
    }

    const VECTORS_JSON: &str =
        include_str!("../../../../packages/core/src/__fixtures__/sync-crypto/vectors.json");

    fn load_vectors() -> Vec<Vector> {
        serde_json::from_str(VECTORS_JSON).expect("vectors.json must parse")
    }

    fn b64_decode(s: &str) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(s).expect("valid base64 fixture")
    }

    fn array16(bytes: &[u8]) -> [u8; SALT_LEN] {
        bytes.try_into().expect("16-byte salt")
    }

    fn array12(bytes: &[u8]) -> [u8; NONCE_LEN] {
        bytes.try_into().expect("12-byte nonce")
    }

    #[test]
    fn attachment_context_refuses_document_and_other_attachment_identity() {
        let material = derive_sync_key_material(
            "phrase",
            [1; SALT_LEN],
            SyncCryptoKdfParams {
                m_kib: 64,
                t: 1,
                p: 1,
            },
        )
        .unwrap();
        let sealed =
            encrypt_sync_attachment(b"{\"tasks\":[]}", &material, "attachments/a.json").unwrap();
        assert_eq!(
            decrypt_sync_attachment(&sealed, &material.key, "attachments/a.json").unwrap(),
            b"{\"tasks\":[]}"
        );
        assert!(matches!(
            decrypt_sync_document(&sealed, &material.key),
            Err(SyncCryptoError::Auth)
        ));
        assert!(matches!(
            decrypt_sync_attachment(&sealed, &material.key, "attachments/b.json"),
            Err(SyncCryptoError::Auth)
        ));
    }

    #[test]
    fn document_and_attachment_context_vectors_match_shared_core() {
        #[derive(Deserialize)]
        struct ContextVector {
            #[serde(flatten)]
            vector: Vector,
            #[serde(rename = "cloudKey")]
            cloud_key: Option<String>,
        }
        let fixtures: Vec<ContextVector> = serde_json::from_str(include_str!(
            "../../../../packages/core/src/__fixtures__/sync-crypto/context-vectors.json"
        ))
        .unwrap();
        for fixture in fixtures {
            let vector = fixture.vector;
            let material = derive_sync_key_material(
                &vector.passphrase,
                array16(&b64_decode(&vector.salt_b64)),
                SyncCryptoKdfParams {
                    m_kib: vector.params.m_kib,
                    t: vector.params.t,
                    p: vector.params.p,
                },
            )
            .unwrap();
            let sealed = encrypt_context_artifact_with_nonce(
                &b64_decode(&vector.plaintext_b64),
                &material,
                array12(&b64_decode(&vector.nonce_b64)),
                fixture
                    .cloud_key
                    .as_deref()
                    .map(ArtifactContext::Attachment)
                    .unwrap_or(ArtifactContext::Document),
            )
            .unwrap();
            assert_eq!(sealed, b64_decode(&vector.encrypted_b64));
            assert_eq!(
                decrypt_context_artifact(
                    &sealed,
                    &material.key,
                    fixture
                        .cloud_key
                        .as_deref()
                        .map(ArtifactContext::Attachment)
                        .unwrap_or(ArtifactContext::Document)
                )
                .unwrap(),
                b64_decode(&vector.plaintext_b64)
            );
        }
    }

    #[test]
    fn legacy_vectors_are_not_ordinary_sync_documents() {
        let fixtures: Vec<Vector> = serde_json::from_str(include_str!(
            "../../../../packages/core/src/__fixtures__/sync-crypto/legacy-vectors.json"
        ))
        .unwrap();
        for vector in fixtures {
            let material = derive_sync_key_material(
                &vector.passphrase,
                array16(&b64_decode(&vector.salt_b64)),
                SyncCryptoKdfParams {
                    m_kib: vector.params.m_kib,
                    t: vector.params.t,
                    p: vector.params.p,
                },
            )
            .unwrap();
            let sealed = b64_decode(&vector.encrypted_b64);
            assert!(matches!(
                decrypt_sync_document(&sealed, &material.key),
                Err(SyncCryptoError::Unsupported(_))
            ));
            assert_eq!(
                decrypt_legacy_artifact_for_upgrade(&sealed, &material.key).unwrap(),
                b64_decode(&vector.plaintext_b64)
            );
        }
    }

    #[test]
    fn default_kdf_params_are_pinned() {
        assert_eq!(SYNC_CRYPTO_DEFAULT_KDF_PARAMS, SyncCryptoKdfParams { m_kib: 19456, t: 2, p: 1 });
    }

    #[test]
    fn round_trips_a_fresh_encrypt_decrypt() {
        let salt = [9u8; SALT_LEN];
        let params = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 1 };
        let material = derive_sync_key_material("a fresh passphrase", salt, params).unwrap();
        let plaintext = b"round trip payload";
        let encrypted = encrypt_sync_document(plaintext, &material).unwrap();
        let decrypted = decrypt_sync_document(&encrypted, &material.key).unwrap();
        assert_eq!(decrypted, plaintext);

        match inspect_sync_artifact(&encrypted) {
            SyncArtifactInspection::Encrypted(header) => {
                assert_eq!(header.params, params);
                assert_eq!(header.format_version, 2);
                assert_eq!(header.kdf_id, 1);
                assert_eq!(header.cipher_id, 1);
            }
            other => panic!("expected Encrypted, got {other:?}"),
        }
    }

    #[test]
    fn decrypts_every_fixture_vector() {
        for vector in load_vectors() {
            let salt = array16(&b64_decode(&vector.salt_b64));
            let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
            let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();
            let encrypted = b64_decode(&vector.encrypted_b64);
            let decrypted = decrypt_sync_document(&encrypted, &material.key)
                .unwrap_or_else(|err| panic!("fixture {} failed to decrypt: {err}", vector.name));
            assert_eq!(decrypted, b64_decode(&vector.plaintext_b64), "fixture {} plaintext mismatch", vector.name);
        }
    }

    #[test]
    fn re_encrypts_every_fixture_vector_byte_exactly() {
        for vector in load_vectors() {
            let salt = array16(&b64_decode(&vector.salt_b64));
            let nonce = array12(&b64_decode(&vector.nonce_b64));
            let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
            let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();
            let plaintext = b64_decode(&vector.plaintext_b64);
            let re_encrypted = encrypt_context_artifact_with_nonce(
                &plaintext,
                &material,
                nonce,
                ArtifactContext::Document,
            )
            .unwrap();
            assert_eq!(
                re_encrypted,
                b64_decode(&vector.encrypted_b64),
                "fixture {} re-encrypt mismatch",
                vector.name
            );
        }
    }

    #[test]
    fn ignores_trailing_garbage_bytes() {
        let vector = load_vectors().into_iter().find(|v| v.name == "small-json-default-params").unwrap();
        let salt = array16(&b64_decode(&vector.salt_b64));
        let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
        let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();
        let mut padded = b64_decode(&vector.encrypted_b64);
        padded.extend_from_slice(&[0x20, 0x20, 0x00, 0x00, 0x20]);

        let decrypted = decrypt_sync_document(&padded, &material.key).unwrap();
        assert_eq!(decrypted, b64_decode(&vector.plaintext_b64));
    }

    #[test]
    fn rejects_wrong_key_with_auth_error() {
        let vector = load_vectors().into_iter().find(|v| v.name == "small-json-default-params").unwrap();
        let salt = array16(&b64_decode(&vector.salt_b64));
        let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
        let wrong_material = derive_sync_key_material("not the right passphrase", salt, params).unwrap();
        let encrypted = b64_decode(&vector.encrypted_b64);
        match decrypt_sync_document(&encrypted, &wrong_material.key) {
            Err(SyncCryptoError::Auth) => {}
            other => panic!("expected Auth error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_tampered_header_byte_via_aad_binding() {
        let vector = load_vectors().into_iter().find(|v| v.name == "small-json-default-params").unwrap();
        let salt = array16(&b64_decode(&vector.salt_b64));
        let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
        let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();
        let mut tampered = b64_decode(&vector.encrypted_b64);
        tampered[20] ^= 0xff;

        match decrypt_sync_document(&tampered, &material.key) {
            Err(SyncCryptoError::Auth) => {}
            other => panic!("expected Auth error, got {other:?}"),
        }
    }

    #[test]
    fn reports_truncated_file_as_unsupported() {
        let vector = load_vectors().into_iter().find(|v| v.name == "small-json-default-params").unwrap();
        let encrypted = b64_decode(&vector.encrypted_b64);
        let truncated = &encrypted[..encrypted.len() - 4];
        let salt = array16(&b64_decode(&vector.salt_b64));
        let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
        let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();

        match decrypt_sync_document(truncated, &material.key) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }
        match inspect_sync_artifact(truncated) {
            SyncArtifactInspection::Unsupported(_) => {}
            other => panic!("expected Unsupported inspection, got {other:?}"),
        }
    }

    #[test]
    fn reports_header_shorter_than_54_bytes_as_unsupported() {
        let mut tiny = MAGIC.to_vec();
        tiny.extend_from_slice(&[0x01, 0x01]);
        match inspect_sync_artifact(&tiny) {
            SyncArtifactInspection::Unsupported(_) => {}
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    #[test]
    fn classifies_plaintext_json_as_plaintext() {
        let plain_json = br#"{"tasks":[]}"#;
        assert!(matches!(inspect_sync_artifact(plain_json), SyncArtifactInspection::Plaintext));
        assert!(matches!(inspect_sync_artifact(&[]), SyncArtifactInspection::Plaintext));
    }

    #[test]
    fn rejects_unknown_version_kdf_or_cipher_as_unsupported() {
        let vector = load_vectors().into_iter().find(|v| v.name == "small-json-default-params").unwrap();
        let encrypted = b64_decode(&vector.encrypted_b64);
        let salt = array16(&b64_decode(&vector.salt_b64));
        let params = SyncCryptoKdfParams { m_kib: vector.params.m_kib, t: vector.params.t, p: vector.params.p };
        let material = derive_sync_key_material(&vector.passphrase, salt, params).unwrap();

        let mut bad_version = encrypted.clone();
        bad_version[6] = 0x03;
        assert!(matches!(
            inspect_sync_artifact(&bad_version),
            SyncArtifactInspection::Unsupported(_)
        ));
        assert!(matches!(
            decrypt_sync_document(&bad_version, &material.key),
            Err(SyncCryptoError::Unsupported(_))
        ));

        let mut bad_kdf = encrypted.clone();
        bad_kdf[7] = 0x02;
        assert!(matches!(
            inspect_sync_artifact(&bad_kdf),
            SyncArtifactInspection::Unsupported(_)
        ));
        assert!(matches!(
            decrypt_sync_document(&bad_kdf, &material.key),
            Err(SyncCryptoError::Unsupported(_))
        ));

        let mut bad_cipher = encrypted.clone();
        bad_cipher[17] = 0x02;
        assert!(matches!(
            inspect_sync_artifact(&bad_cipher),
            SyncArtifactInspection::Unsupported(_)
        ));
        assert!(matches!(
            decrypt_sync_document(&bad_cipher, &material.key),
            Err(SyncCryptoError::Unsupported(_))
        ));
    }

    #[test]
    fn nfc_composed_and_decomposed_passphrases_derive_the_same_key() {
        let salt = [7u8; SALT_LEN];
        let params = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 1 };
        let composed = "caf\u{00e9}";
        let decomposed = "cafe\u{0301}";
        assert_ne!(composed, decomposed);
        let composed_material = derive_sync_key_material(composed, salt, params).unwrap();
        let decomposed_material = derive_sync_key_material(decomposed, salt, params).unwrap();
        assert_eq!(composed_material.key, decomposed_material.key);
    }

    #[test]
    fn nfc_fixture_actually_exercises_normalization() {
        let vector = load_vectors()
            .into_iter()
            .find(|v| v.name == "nfc-normalization-cafe")
            .unwrap();
        assert_eq!(vector.passphrase, "cafe\u{0301}");
    }

    #[test]
    fn rejects_p_zero_on_the_write_path() {
        let salt = [2u8; SALT_LEN];
        let valid_params = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 1 };
        let material = derive_sync_key_material("x", salt, valid_params).unwrap();
        let bogus_material = SyncKeyMaterial { params: SyncCryptoKdfParams { p: 0, ..valid_params }, ..material };
        match encrypt_sync_document(b"x", &bogus_material) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }
    }

    #[test]
    fn draws_a_fresh_nonce_per_encrypt_call_never_reused() {
        let salt = [3u8; SALT_LEN];
        let params = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 1 };
        let material = derive_sync_key_material("nonce pin test", salt, params).unwrap();
        let plaintext = b"same plaintext both times";

        let first = encrypt_sync_document(plaintext, &material).unwrap();
        let second = encrypt_sync_document(plaintext, &material).unwrap();

        assert_ne!(&first[34..46], &second[34..46], "nonces must differ between encrypt calls");
        assert_ne!(first, second, "GCM nonce reuse would otherwise be silent");
    }

    fn hostile_header(m_kib: u32, t: u32, p: u8) -> Vec<u8> {
        let mut header = vec![0u8; HEADER_LEN];
        header[..6].copy_from_slice(MAGIC);
        header[6] = FORMAT_VERSION;
        header[7] = KDF_ID_ARGON2ID;
        header[17] = CIPHER_ID_AES_256_GCM;
        write_u32_le(&mut header, 8, m_kib);
        write_u32_le(&mut header, 12, t);
        header[16] = p;
        header
    }

    #[test]
    fn accepts_a_header_at_the_kdf_cost_ceiling() {
        let at_ceiling = hostile_header(262144, 16, 8);
        assert!(matches!(inspect_sync_artifact(&at_ceiling), SyncArtifactInspection::Encrypted(_)));
    }

    #[test]
    fn rejects_m_kib_over_the_kdf_cost_ceiling() {
        let hostile = hostile_header(262145, 1, 1);
        assert!(matches!(inspect_sync_artifact(&hostile), SyncArtifactInspection::Unsupported(_)));
    }

    #[test]
    fn rejects_t_over_the_kdf_cost_ceiling() {
        let hostile = hostile_header(64, 17, 1);
        assert!(matches!(inspect_sync_artifact(&hostile), SyncArtifactInspection::Unsupported(_)));
    }

    #[test]
    fn rejects_p_over_the_kdf_cost_ceiling() {
        let hostile = hostile_header(64, 1, 9);
        assert!(matches!(inspect_sync_artifact(&hostile), SyncArtifactInspection::Unsupported(_)));
    }

    #[test]
    fn rejects_over_ceiling_header_via_decrypt_too() {
        let hostile = hostile_header(999_999_999, 1, 1);
        let key = [0u8; KEY_LEN];
        match decrypt_sync_document(&hostile, &key) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }
    }

    #[test]
    fn derive_sync_key_material_rejects_params_over_the_kdf_cost_ceiling() {
        let salt = [0u8; SALT_LEN];
        let over_m_kib = SyncCryptoKdfParams { m_kib: 262145, t: 1, p: 1 };
        match derive_sync_key_material("x", salt, over_m_kib) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }

        let over_t = SyncCryptoKdfParams { m_kib: 64, t: 17, p: 1 };
        match derive_sync_key_material("x", salt, over_t) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }

        let over_p = SyncCryptoKdfParams { m_kib: 64, t: 1, p: 9 };
        match derive_sync_key_material("x", salt, over_p) {
            Err(SyncCryptoError::Unsupported(_)) => {}
            other => panic!("expected Unsupported error, got {other:?}"),
        }
    }
}
