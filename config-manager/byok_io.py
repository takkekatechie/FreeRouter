"""BYOK (Bring-Your-Own-Key) storage for the FreeRouter Admin GUI.

Persists per-(userId, provider) API keys to a 0600-mode JSON file in the
operator's per-user state directory (``~/.freerouter-admin/byok-keys.json``)
— the same trust boundary as the admin-key hash. Plaintext on disk: the
runtime will encrypt them with ``ROUTER_MASTER_KEY`` once it loads them
into its in-memory ``KeyManager``.

Why not the runtime's AES-256-GCM at rest here?
    The runtime uses Node's ``createCipheriv('aes-256-gcm', ...)``. Python's
    standard library lacks AES-GCM (it lives in the third-party ``cryptography``
    package), and the admin tool is intentionally stdlib-only. Storing under a
    0600 file in the operator's home directory matches the trust model of the
    other secrets the GUI handles (admin-key hash, ``.env`` contents).

File format::

    {
      "version": 1,
      "keys": [
        { "userId": "alice", "provider": "openai",   "apiKey": "sk-…", "createdAt": 1730000000000 },
        { "userId": "alice", "provider": "anthropic", "apiKey": "sk-ant-…", "createdAt": 1730000005000 }
      ]
    }

Failures to read/write are surfaced to the caller (unlike :mod:`prefs`,
which silently degrades). BYOK is load-bearing — the operator should
notice if it didn't save.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import auth

BYOK_FILE: Path = auth.KEY_DIR / "byok-keys.json"
SCHEMA_VERSION = 1


@dataclass
class BYOKEntry:
    user_id: str
    provider: str
    api_key: str
    created_at: int  # epoch ms

    def to_dict(self) -> dict[str, Any]:
        return {
            "userId": self.user_id,
            "provider": self.provider,
            "apiKey": self.api_key,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "BYOKEntry | None":
        if not isinstance(raw, dict):
            return None
        user_id = raw.get("userId")
        provider = raw.get("provider")
        api_key = raw.get("apiKey")
        created = raw.get("createdAt")
        if not (isinstance(user_id, str) and user_id):
            return None
        if not (isinstance(provider, str) and provider):
            return None
        if not (isinstance(api_key, str) and api_key):
            return None
        created_at = int(created) if isinstance(created, (int, float)) else int(time.time() * 1000)
        return cls(user_id=user_id, provider=provider, api_key=api_key, created_at=created_at)

    @classmethod
    def new(cls, user_id: str, provider: str, api_key: str) -> "BYOKEntry":
        return cls(
            user_id=user_id, provider=provider, api_key=api_key,
            created_at=int(time.time() * 1000),
        )


def load() -> list[BYOKEntry]:
    """Return the saved entries, or an empty list if the file doesn't exist.

    Raises :class:`OSError` for unreadable / malformed files so the operator
    sees the failure rather than silently losing keys.
    """
    if not BYOK_FILE.is_file():
        return []
    try:
        raw = json.loads(BYOK_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise OSError(f"failed to read {BYOK_FILE}: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("keys"), list):
        raise OSError(f"{BYOK_FILE} is not a BYOK keys file")
    out: list[BYOKEntry] = []
    for item in raw["keys"]:
        entry = BYOKEntry.from_dict(item)
        if entry is not None:
            out.append(entry)
    return out


def save(entries: list[BYOKEntry]) -> None:
    """Atomically write the keys file with 0600 permissions."""
    BYOK_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = {
        "version": SCHEMA_VERSION,
        "keys": [e.to_dict() for e in entries],
    }
    serialized = json.dumps(payload, indent=2) + "\n"
    tmp = BYOK_FILE.with_name(BYOK_FILE.name + ".tmp")
    tmp.write_text(serialized, encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        # Some filesystems (e.g. Windows network shares) reject chmod;
        # not critical — atomic replace below is what matters.
        pass
    os.replace(tmp, BYOK_FILE)


def delete_all() -> None:
    """Remove the keys file. Used by tests and reset flows."""
    if BYOK_FILE.is_file():
        BYOK_FILE.unlink()
