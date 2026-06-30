//! Payload encryption at rest (P7.15).
//!
//! Opt-in via an `encryptionKey` passphrase. When enabled, the durable payload
//! columns (job payload, run input/output, step result, event payload) are
//! AES-256-GCM encrypted before they touch storage and decrypted on read — the
//! engine only ever holds plaintext in memory, ciphertext only at rest. A
//! durable engine persists every input/output, so this is load-bearing for any
//! team handling PII.
//!
//! Wire format of an encrypted value: `enc:1:<base64(nonce ‖ ciphertext‖tag)>`.
//! The `enc:1:` prefix lets reads tell ciphertext from legacy plaintext, so
//! enabling encryption on an existing database is transparent — old rows stay
//! readable, new writes are encrypted. GCM is authenticated, so tampering or a
//! wrong key fails the decrypt (we then return the stored value unchanged
//! rather than crash the engine on a single bad row).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

const PREFIX: &str = "enc:1:";
const NONCE_LEN: usize = 12;

/// Payload cipher. `None` key = passthrough (encryption disabled).
#[derive(Clone)]
pub struct Crypto {
    key: Option<[u8; 32]>,
}

impl Crypto {
    /// Build from an optional passphrase. The 256-bit key is the SHA-256 of the
    /// passphrase, so any-length operator secret maps to a valid AES-256 key.
    pub fn new(passphrase: Option<&str>) -> Self {
        let key = passphrase.filter(|p| !p.is_empty()).map(|p| {
            let mut h = Sha256::new();
            h.update(p.as_bytes());
            let digest = h.finalize();
            let mut k = [0u8; 32];
            k.copy_from_slice(&digest);
            k
        });
        Self { key }
    }

    /// Disabled cipher (passthrough) — for stores opened without a key.
    pub fn disabled() -> Self {
        Self { key: None }
    }

    pub fn enabled(&self) -> bool {
        self.key.is_some()
    }

    /// Encrypt for storage. Passthrough when disabled. Infallible in practice
    /// (GCM only errors past 64 GiB of plaintext), so a failure is a bug — we
    /// must never silently store plaintext when a key is set.
    pub fn enc(&self, plaintext: &str) -> String {
        let Some(key) = self.key else {
            return plaintext.to_string();
        };
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .expect("aes-256-gcm encrypt");
        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        format!("{PREFIX}{}", B64.encode(blob))
    }

    /// Decrypt a stored value. Returns legacy plaintext (no prefix) unchanged.
    /// If a value is encrypted but the key is absent/wrong or the blob is
    /// corrupt, the stored value is returned as-is rather than panicking — the
    /// failure surfaces to the caller instead of taking down the engine.
    pub fn dec(&self, stored: &str) -> String {
        let Some(rest) = stored.strip_prefix(PREFIX) else {
            return stored.to_string();
        };
        let Some(key) = self.key else {
            return stored.to_string();
        };
        let Ok(blob) = B64.decode(rest) else {
            return stored.to_string();
        };
        if blob.len() <= NONCE_LEN {
            return stored.to_string();
        }
        let (nonce, ct) = blob.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        match cipher.decrypt(Nonce::from_slice(nonce), ct) {
            Ok(pt) => String::from_utf8(pt).unwrap_or_else(|_| stored.to_string()),
            Err(_) => stored.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_is_ciphertext_at_rest() {
        let c = Crypto::new(Some("hunter2"));
        let pt = r#"{"ssn":"123-45-6789"}"#;
        let blob = c.enc(pt);
        assert!(blob.starts_with("enc:1:"));
        assert!(
            !blob.contains("123-45-6789"),
            "plaintext must not appear at rest"
        );
        assert_eq!(c.dec(&blob), pt);
    }

    #[test]
    fn disabled_is_passthrough() {
        let c = Crypto::disabled();
        assert_eq!(c.enc("x"), "x");
        assert_eq!(c.dec("x"), "x");
    }

    #[test]
    fn legacy_plaintext_reads_through_when_enabled() {
        let c = Crypto::new(Some("k"));
        assert_eq!(c.dec("legacy-plaintext"), "legacy-plaintext");
    }

    #[test]
    fn wrong_key_does_not_panic() {
        let blob = Crypto::new(Some("right")).enc("secret");
        // Wrong key → returns the stored ciphertext rather than crashing.
        assert_eq!(Crypto::new(Some("wrong")).dec(&blob), blob);
    }

    #[test]
    fn nonce_randomized_per_call() {
        let c = Crypto::new(Some("k"));
        assert_ne!(c.enc("same"), c.enc("same"), "fresh nonce per encrypt");
    }
}
