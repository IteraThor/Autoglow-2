"""
AutoGlow 2 - Chrome Extension Packager
Packs chrome_extension/ into a signed CRX3 file so Chrome can install it automatically through
the ExtensionInstallForcelist policy that setup.sh writes on Linux. Pure Python (no openssl).

The signing key is created once per installation and determines the extension ID, so the
policy written by setup.sh and the CRX served by AutoGlow always match.

Usage: python -m core.extension_packager id    (creates the key if needed, prints the extension ID)
"""

import hashlib
import io
import json
import os
import secrets
import struct
import sys
import zipfile
from typing import Dict, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTENSION_DIR = os.path.join(ROOT, "chrome_extension")
KEY_PATH = os.path.join(ROOT, "chrome_extension.key")

RSA_BITS = 2048
RSA_E = 65537
_SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")
_RSA_ALGORITHM_ID = bytes.fromhex("300d06092a864886f70d0101010500")


# -----------------------------------------------------------------------------
# RSA (key generation + PKCS#1 v1.5 SHA-256 signatures)
# -----------------------------------------------------------------------------
def _is_probable_prime(n: int, rounds: int = 40) -> bool:
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        x = pow(secrets.randbelow(n - 3) + 2, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _random_prime(bits: int) -> int:
    while True:
        candidate = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if candidate % RSA_E != 1 and _is_probable_prime(candidate):
            return candidate


def generate_key() -> Dict[str, int]:
    while True:
        p, q = _random_prime(RSA_BITS // 2), _random_prime(RSA_BITS // 2)
        n = p * q
        if p != q and n.bit_length() == RSA_BITS:
            return {"n": n, "e": RSA_E, "d": pow(RSA_E, -1, (p - 1) * (q - 1))}


def rsa_sign(key: Dict[str, int], message: bytes) -> bytes:
    size = (key["n"].bit_length() + 7) // 8
    digest_info = _SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    padded = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(padded, "big"), key["d"], key["n"]).to_bytes(size, "big")


def rsa_verify(key: Dict[str, int], message: bytes, signature: bytes) -> bool:
    size = (key["n"].bit_length() + 7) // 8
    digest_info = _SHA256_DIGEST_INFO + hashlib.sha256(message).digest()
    expected = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(signature, "big"), key["e"], key["n"]).to_bytes(size, "big") == expected


# -----------------------------------------------------------------------------
# DER / protobuf encoding
# -----------------------------------------------------------------------------
def _der_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _der(tag: int, body: bytes) -> bytes:
    return bytes([tag]) + _der_len(len(body)) + body


def _der_int(value: int) -> bytes:
    raw = value.to_bytes((value.bit_length() + 8) // 8, "big")  # leading 0 keeps it positive
    return _der(0x02, raw)


def public_key_der(key: Dict[str, int]) -> bytes:
    """SubjectPublicKeyInfo, the form Chrome hashes into the extension ID."""
    rsa_public_key = _der(0x30, _der_int(key["n"]) + _der_int(key["e"]))
    return _der(0x30, _RSA_ALGORITHM_ID + _der(0x03, b"\x00" + rsa_public_key))


def _varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _pb_bytes(field: int, data: bytes) -> bytes:
    return _varint((field << 3) | 2) + _varint(len(data)) + data


# -----------------------------------------------------------------------------
# Key storage, extension ID, CRX3
# -----------------------------------------------------------------------------
def load_or_create_key(path: str = KEY_PATH) -> Dict[str, int]:
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return {k: int(v) for k, v in json.load(f).items()}
    key = generate_key()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({k: str(v) for k, v in key.items()}, f)
    return key


def _crx_id(key: Dict[str, int]) -> bytes:
    return hashlib.sha256(public_key_der(key)).digest()[:16]


def extension_id(key: Dict[str, int]) -> str:
    # Chrome writes the first 16 bytes of the key hash as hex using the letters a-p
    return "".join(chr(ord("a") + int(c, 16)) for c in _crx_id(key).hex())


def extension_version(ext_dir: str = EXTENSION_DIR) -> str:
    with open(os.path.join(ext_dir, "manifest.json"), "r", encoding="utf-8") as f:
        return str(json.load(f)["version"])


def _zip_extension(ext_dir: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for folder, dirs, files in os.walk(ext_dir):
            dirs.sort()
            for name in sorted(files):
                full = os.path.join(folder, name)
                arcname = os.path.relpath(full, ext_dir).replace(os.sep, "/")
                info = zipfile.ZipInfo(arcname, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as f:
                    zf.writestr(info, f.read())
    return buf.getvalue()


def build_crx(key: Dict[str, int], ext_dir: str = EXTENSION_DIR) -> bytes:
    archive = _zip_extension(ext_dir)
    signed_header_data = _pb_bytes(1, _crx_id(key))
    signed_payload = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_header_data)) + signed_header_data + archive
    proof = _pb_bytes(1, public_key_der(key)) + _pb_bytes(2, rsa_sign(key, signed_payload))
    header = _pb_bytes(2, proof) + _pb_bytes(10000, signed_header_data)
    return b"Cr24" + struct.pack("<II", 3, len(header)) + header + archive


def package() -> Tuple[str, str, bytes]:
    """Return (extension_id, version, crx_bytes) for the bundled extension."""
    key = load_or_create_key()
    return extension_id(key), extension_version(), build_crx(key)


if __name__ == "__main__":
    if sys.argv[1:] == ["id"]:
        print(extension_id(load_or_create_key()))
    else:
        print(__doc__.strip())
        sys.exit(2)
