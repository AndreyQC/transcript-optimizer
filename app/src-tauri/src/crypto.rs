//! Шифрование/расшифровка значений в формате `crypto__<ENV>__<ciphertext>`.
//!
//! Реализация основана на спецификации Fernet (AES-128-CBC + HMAC-SHA256) и
//! совместима с Python `cryptography.fernet` из `db-project-manager`.
//! Ключ Fernet берётся из переменной окружения, указанной в токене.
//!
//! Используются только чистые Rust-крейты (без системного OpenSSL), чтобы
//! сборка работала на Windows/Linux/macOS без дополнительных зависимостей ОС.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::{engine::general_purpose::URL_SAFE, Engine as _};
use cbc::cipher::generic_array::GenericArray;
use cbc::{Decryptor, Encryptor};
use hmac::{Hmac, Mac};
use rand::Rng;
use sha2::Sha256;

pub const CIPHER_PREFIX: &str = "crypto";
const VERSION: u8 = 0x80;

type HmacSha256 = Hmac<Sha256>;

/// Проверяет, что строка имеет вид `crypto__<ENV>__<ciphertext>`.
pub fn is_crypto_token(s: &str) -> bool {
    let parts: Vec<&str> = s.trim().split("__").collect();
    parts.len() == 3 && parts[0] == CIPHER_PREFIX
}

/// Расшифровывает строку формата `crypto__<ENV>__<ciphertext>`.
/// Ключ Fernet берётся из `std::env::var(env)`.
pub fn decrypt_crypto_token(encrypted_data: &str) -> Result<String, String> {
    let trimmed = encrypted_data.trim();
    if !is_crypto_token(trimmed) {
        return Err(format!(
            "Строка не в ожидаемом crypto-формате: {}",
            encrypted_data
        ));
    }

    let parts: Vec<&str> = trimmed.split("__").collect();
    let key_env_variable = parts[1];
    let token = parts[2];

    let raw_key = std::env::var(key_env_variable)
        .map_err(|_| format!("Для расшифровки нужна переменная окружения {key_env_variable}"))?;

    let key_material = raw_key.trim();
    let plaintext = fernet_decrypt(token, key_material)?;

    String::from_utf8(plaintext)
        .map_err(|_| "Расшифрованные данные не являются валидным UTF-8".to_string())
}

/// Если строка — crypto-токен, расшифровывает; иначе возвращает как есть.
pub fn resolve_value(s: &str) -> Result<String, String> {
    if is_crypto_token(s) {
        decrypt_crypto_token(s)
    } else {
        Ok(s.to_string())
    }
}

/// Генерирует новый Fernet-ключ (base64-url, 32 bytes).
pub fn generate_fernet_key() -> String {
    let mut key = [0u8; 32];
    rand::thread_rng().fill(&mut key);
    URL_SAFE.encode(&key)
}

/// Зашифровывает plaintext с ключом из переменной окружения `env_var` и
/// возвращает строку формата `crypto__<ENV>__<ciphertext>`.
pub fn encrypt_text(plaintext: &str, env_var: &str) -> Result<String, String> {
    let raw_key = std::env::var(env_var)
        .map_err(|_| format!("Для шифрования нужна переменная окружения {env_var}"))?;

    let key_material = raw_key.trim();
    let ciphertext = fernet_encrypt(plaintext.as_bytes(), key_material)?;
    Ok(format!("{}__{}__{}" , CIPHER_PREFIX, env_var, ciphertext))
}

/// Fernet-encrypt: base64url(VERSION || timestamp || iv || ciphertext || hmac).
fn fernet_encrypt(plaintext: &[u8], key_b64: &str) -> Result<String, String> {
    let key = decode_key(key_b64)?;
    // Python cryptography.fernet: key[:16] = signing_key, key[16:] = encryption_key.
    let sign_key = &key[0..16];
    let enc_key = &key[16..32];

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Системное время до эпохи Unix".to_string())?
        .as_secs();

    let mut iv = [0u8; 16];
    rand::thread_rng().fill(&mut iv);

    let enc_key_ga = GenericArray::from_slice(enc_key);
    let iv_ga = GenericArray::from_slice(&iv);
    let cipher = Encryptor::<aes::Aes128>::new(enc_key_ga, iv_ga);
    let ciphertext = cipher.encrypt_padded_vec_mut::<Pkcs7>(plaintext);

    // payload = VERSION || timestamp || iv || ciphertext
    let mut payload = Vec::with_capacity(1 + 8 + 16 + ciphertext.len() + 32);
    payload.push(VERSION);
    payload.extend_from_slice(&timestamp.to_be_bytes());
    payload.extend_from_slice(&iv);
    payload.extend_from_slice(&ciphertext);

    let mut mac = HmacSha256::new_from_slice(sign_key)
        .map_err(|_| "Ошибка инициализации HMAC".to_string())?;
    mac.update(&payload);
    let hmac = mac.finalize().into_bytes();
    payload.extend_from_slice(&hmac);

    Ok(URL_SAFE.encode(&payload))
}

/// Fernet-decrypt: проверяет HMAC, затем AES-CBC-PKCS7.
fn fernet_decrypt(token: &str, key_b64: &str) -> Result<Vec<u8>, String> {
    let key = decode_key(key_b64)?;
    // Python cryptography.fernet: key[:16] = signing_key, key[16:] = encryption_key.
    let sign_key = &key[0..16];
    let enc_key = &key[16..32];

    let data = URL_SAFE
        .decode(token)
        .map_err(|_| "Невалидный base64 токена".to_string())?;

    if data.len() < 33 {
        return Err("Токен слишком короткий".to_string());
    }

    if data[0] != VERSION {
        return Err("Неподдерживаемая версия Fernet-токена".to_string());
    }

    let hmac_offset = data.len() - 32;
    let payload = &data[0..hmac_offset];
    let hmac = &data[hmac_offset..];

    let mut mac = HmacSha256::new_from_slice(sign_key)
        .map_err(|_| "Ошибка инициализации HMAC".to_string())?;
    mac.update(payload);
    let expected = mac.finalize().into_bytes();
    if hmac != expected.as_slice() {
        return Err("HMAC Fernet-токена не совпадает: невалидный ключ или токен".to_string());
    }

    // iv = data[9..25], ciphertext = data[25..hmac_offset]
    let iv = &data[9..25];
    let ciphertext = &data[25..hmac_offset];

    let enc_key_ga = GenericArray::from_slice(enc_key);
    let iv_ga = GenericArray::from_slice(iv);
    let cipher = Decryptor::<aes::Aes128>::new(enc_key_ga, iv_ga);
    let plaintext = cipher
        .decrypt_padded_vec_mut::<Pkcs7>(ciphertext)
        .map_err(|_| "Ошибка AES-расшифровки".to_string())?;

    Ok(plaintext)
}

fn decode_key(key_b64: &str) -> Result<Vec<u8>, String> {
    let key = URL_SAFE
        .decode(key_b64.trim())
        .map_err(|_| "Fernet-ключ не является валидным base64".to_string())?;
    if key.len() != 32 {
        return Err(format!(
            "Fernet-ключ должен быть 32 bytes после декодирования, получено {}",
            key.len()
        ));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_crypto_token() {
        assert!(is_crypto_token("crypto__TEST_KEY__abc123"));
        assert!(!is_crypto_token("plain-text"));
        assert!(!is_crypto_token("crypto__missing_part"));
    }

    #[test]
    fn test_resolve_plain_value() {
        assert_eq!(
            resolve_value("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn test_roundtrip() {
        let key = generate_fernet_key();
        std::env::set_var("TEST_FERNET_KEY", &key);

        let plaintext = "sk-abc123";
        let encrypted = encrypt_text(plaintext, "TEST_FERNET_KEY").unwrap();
        assert!(is_crypto_token(&encrypted));

        let decrypted = decrypt_crypto_token(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);

        let resolved = resolve_value(&encrypted).unwrap();
        assert_eq!(resolved, plaintext);
    }

    #[test]
    fn test_decrypt_python_token() {
        // Генерируем ключ и токен вручную, чтобы проверить совместимость с
        // Python-образцом. В реальном тесте можно подставить токен, созданный
        // Python `cryptography.fernet`.
        let key = generate_fernet_key();
        std::env::set_var("PY_COMPAT_KEY", &key);

        let plaintext = "https://api.openai.com/v1";
        let encrypted = encrypt_text(plaintext, "PY_COMPAT_KEY").unwrap();
        let decrypted = decrypt_crypto_token(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_real_python_token() {
        // Токен, сгенерированный Python cryptography.fernet:
        // KEY: 0MemqdrH9H_zImU1u0IrDjRighe-D1rUSN3r3cJJJMY=
        // TOKEN: gAAAAABqXFdc8d8sh8VYEj-zzvaOcP7XKWk9CNDD4Sv7xPCa-eUCleRQJKSn6lHzU8TblxVvkJ5EgqHMmGhu8FxMBJye02XmAdcZOlp5pWjytMfmsqB_Qzc=
        std::env::set_var("PY_REAL_KEY", "0MemqdrH9H_zImU1u0IrDjRighe-D1rUSN3r3cJJJMY=");
        let encrypted = "crypto__PY_REAL_KEY__gAAAAABqXFdc8d8sh8VYEj-zzvaOcP7XKWk9CNDD4Sv7xPCa-eUCleRQJKSn6lHzU8TblxVvkJ5EgqHMmGhu8FxMBJye02XmAdcZOlp5pWjytMfmsqB_Qzc=";
        let decrypted = decrypt_crypto_token(encrypted).unwrap();
        assert_eq!(decrypted, "https://api.openai.com/v1");
    }
}
