"""Key-based admin authentication.

The admin generates a random 32-byte key on first run. Only its PBKDF2-HMAC-SHA256
hash (with a per-install random salt) is persisted, in ~/.freerouter-admin/key.hash.
The plain key is printed once to stdout and never written anywhere.

Subsequent runs require the operator to supply that key; comparison is
constant-time. Storage is per-user (home directory), not per-project.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

KEY_DIR = Path.home() / ".freerouter-admin"
KEY_FILE = KEY_DIR / "key.hash"

_PBKDF2_ITERATIONS = 200_000
_SALT_BYTES = 16
_KEY_BYTES = 32
_HASH_BYTES = 32


@dataclass(frozen=True)
class AuthRecord:
    salt: bytes
    digest: bytes

    def serialize(self) -> str:
        return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${self.salt.hex()}${self.digest.hex()}"

    @classmethod
    def parse(cls, raw: str) -> "AuthRecord":
        parts = raw.strip().split("$")
        if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
            raise ValueError("malformed key.hash file")
        return cls(salt=bytes.fromhex(parts[2]), digest=bytes.fromhex(parts[3]))


def _hash(key: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", key.encode("utf-8"), salt, _PBKDF2_ITERATIONS, dklen=_HASH_BYTES
    )


def key_file_exists() -> bool:
    return KEY_FILE.is_file()


def generate_and_store_key() -> str:
    """Generate a fresh admin key, persist its hash, return the plaintext key once.

    The hash file lives in the per-user home directory so the same logic
    works on Linux, macOS, and Windows. ``Path.home()`` resolves to
    ``$HOME`` on POSIX and ``%USERPROFILE%`` on Windows. ``os.chmod`` on
    Windows only honours the user-write bit; that's a best-effort
    hardening, not a correctness requirement.
    """
    KEY_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = secrets.token_urlsafe(_KEY_BYTES)
    salt = secrets.token_bytes(_SALT_BYTES)
    record = AuthRecord(salt=salt, digest=_hash(key, salt))
    tmp = KEY_FILE.with_name(KEY_FILE.name + ".tmp")
    tmp.write_text(record.serialize(), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass  # Some Windows filesystems disallow chmod; not critical.
    os.replace(tmp, KEY_FILE)
    return key


def verify_key(key: str) -> bool:
    if not KEY_FILE.is_file():
        return False
    record = AuthRecord.parse(KEY_FILE.read_text(encoding="utf-8"))
    return hmac.compare_digest(_hash(key, record.salt), record.digest)


def reset_key() -> None:
    if KEY_FILE.is_file():
        KEY_FILE.unlink()
