//! Chrome extension packager: packs chrome_extension/ into a signed CRX3 so Chrome installs it through
//! the ExtensionInstallForcelist policy that setup.sh writes on Linux. The signing key is created once per
//! installation (chrome_extension.key) and determines the extension ID, so policy and CRX always match.

use crate::storage::project_root;
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::BigUint;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

const RSA_BITS: usize = 2048;
const SHA256_DIGEST_INFO: [u8; 19] = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
const RSA_ALGORITHM_ID: [u8; 15] = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

pub struct Key {
    n: BigUint,
    e: BigUint,
    d: BigUint,
}

pub fn extension_dir() -> PathBuf {
    project_root().join("chrome_extension")
}

pub fn key_path() -> PathBuf {
    project_root().join("chrome_extension.key")
}

fn generate_key() -> Key {
    let k = rsa::RsaPrivateKey::new(&mut rand::thread_rng(), RSA_BITS).expect("RSA key generation");
    Key { n: k.n().clone(), e: k.e().clone(), d: k.d().clone() }
}

fn rsa_sign(key: &Key, message: &[u8]) -> Vec<u8> {
    let size = (key.n.bits() + 7) / 8;
    let mut di = SHA256_DIGEST_INFO.to_vec();
    di.extend_from_slice(&Sha256::digest(message));
    let mut padded = vec![0x00, 0x01];
    padded.extend(std::iter::repeat(0xff).take(size - di.len() - 3));
    padded.push(0x00);
    padded.extend(di);
    let sig = BigUint::from_bytes_be(&padded).modpow(&key.d, &key.n).to_bytes_be();
    let mut out = vec![0u8; size - sig.len()];
    out.extend(sig);
    out
}

fn der_len(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![n as u8];
    }
    let raw: Vec<u8> = n.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
    let mut v = vec![0x80 | raw.len() as u8];
    v.extend(raw);
    v
}

fn der(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![tag];
    v.extend(der_len(body.len()));
    v.extend_from_slice(body);
    v
}

/// A positive DER INTEGER: (bit_length + 8) // 8 bytes, so a leading 0 keeps it positive
fn der_int(v: &BigUint) -> Vec<u8> {
    let bits = v.bits();
    let len = (bits + 8) / 8;
    let raw = v.to_bytes_be();
    let mut b = vec![0u8; len.saturating_sub(raw.len())];
    b.extend(raw);
    der(0x02, &b)
}

/// SubjectPublicKeyInfo, the form Chrome hashes into the extension ID
fn public_key_der(k: &Key) -> Vec<u8> {
    let mut seq = der_int(&k.n);
    seq.extend(der_int(&k.e));
    let rsa_pub = der(0x30, &seq);
    let mut bit = vec![0u8];
    bit.extend(rsa_pub);
    let mut body = RSA_ALGORITHM_ID.to_vec();
    body.extend(der(0x03, &bit));
    der(0x30, &body)
}

fn varint(mut v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            out.push(b | 0x80);
        } else {
            out.push(b);
            return out;
        }
    }
}

fn pb_bytes(field: u64, data: &[u8]) -> Vec<u8> {
    let mut v = varint((field << 3) | 2);
    v.extend(varint(data.len() as u64));
    v.extend_from_slice(data);
    v
}

pub fn load_or_create_key(path: &Path) -> Result<Key, String> {
    if path.exists() {
        let t = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
        let get = |k: &str| -> Result<BigUint, String> {
            let s = match v.get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(n) => n.to_string(),
                None => return Err(format!("key file lacks {}", k)),
            };
            BigUint::parse_bytes(s.trim().as_bytes(), 10).ok_or_else(|| format!("bad {} in key file", k))
        };
        return Ok(Key { n: get("n")?, e: get("e")?, d: get("d")? });
    }
    let key = generate_key();
    let body = json!({"n": key.n.to_str_radix(10), "e": key.e.to_str_radix(10), "d": key.d.to_str_radix(10)}).to_string();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut f = opts.open(path).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

fn crx_id(k: &Key) -> Vec<u8> {
    Sha256::digest(public_key_der(k))[..16].to_vec()
}

/// Chrome writes the first 16 bytes of the key hash as hex using the letters a-p
pub fn extension_id(k: &Key) -> String {
    hex::encode(crx_id(k)).chars().map(|c| (b'a' + c.to_digit(16).unwrap_or(0) as u8) as char).collect()
}

pub fn extension_version(dir: &Path) -> Result<String, String> {
    let t = std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&t).map_err(|e| e.to_string())?;
    Ok(v.get("version").map(crate::py::py_str).unwrap_or_default())
}

fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    entries.sort();
    let (dirs, files): (Vec<PathBuf>, Vec<PathBuf>) = entries.into_iter().partition(|p| p.is_dir());
    for f in files {
        let rel = f.strip_prefix(base).unwrap_or(&f).to_string_lossy().replace('\\', "/");
        out.push((rel, f));
    }
    for d in dirs {
        walk(&d, base, out);
    }
}

fn zip_extension(dir: &Path) -> Result<Vec<u8>, String> {
    let mut files = Vec::new();
    walk(dir, dir, &mut files);
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let dt = zip::DateTime::from_date_and_time(2026, 1, 1, 0, 0, 0).map_err(|_| "date".to_string())?;
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).last_modified_time(dt);
        for (name, path) in files {
            let data = std::fs::read(&path).map_err(|e| e.to_string())?;
            z.start_file(name, opts).map_err(|e| e.to_string())?;
            z.write_all(&data).map_err(|e| e.to_string())?;
        }
        z.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

pub fn build_crx(k: &Key, dir: &Path) -> Result<Vec<u8>, String> {
    let archive = zip_extension(dir)?;
    let shd = pb_bytes(1, &crx_id(k));
    let mut signed = b"CRX3 SignedData\x00".to_vec();
    signed.extend((shd.len() as u32).to_le_bytes());
    signed.extend(&shd);
    signed.extend(&archive);
    let mut proof = pb_bytes(1, &public_key_der(k));
    proof.extend(pb_bytes(2, &rsa_sign(k, &signed)));
    let mut header = pb_bytes(2, &proof);
    header.extend(pb_bytes(10000, &shd));
    let mut out = b"Cr24".to_vec();
    out.extend(3u32.to_le_bytes());
    out.extend((header.len() as u32).to_le_bytes());
    out.extend(header);
    out.extend(archive);
    Ok(out)
}

/// (extension_id, version, crx bytes) for the bundled extension
pub fn package() -> Result<(String, String, Vec<u8>), String> {
    let k = load_or_create_key(&key_path())?;
    let dir = extension_dir();
    Ok((extension_id(&k), extension_version(&dir)?, build_crx(&k, &dir)?))
}
