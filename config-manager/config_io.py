"""Atomic file I/O for FreeRouter config artifacts.

All paths are interpreted relative to the caller's CWD (or absolute if given)
and are normalised through ``pathlib.Path`` so the same code handles
POSIX (Linux/macOS) and Windows path conventions:

  * forward and back slashes are accepted on Windows
  * ``./`` and ``..`` are resolved against the current working directory
  * we never call ``Path.resolve()`` — keeping the user-supplied form lets
    relative paths stay relative across hosts (e.g. when the project is
    checked out under different absolute prefixes on each machine)

Writes are atomic: write a sibling ``*.tmp`` file in the same directory
(so ``os.replace`` is a same-filesystem rename), ``fsync``, then
``os.replace`` — which is documented atomic on Linux, macOS, and
Windows from Python 3.3 onward.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

_FSYNC_AVAILABLE = hasattr(os, "fsync")


def _resolve(path: str | os.PathLike[str]) -> Path:
    if not str(path):
        raise ValueError("path must not be empty")
    return Path(path)


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text atomically. Sibling .tmp keeps src+dst on one filesystem
    so the final rename is atomic on every supported OS.
    """
    parent = path.parent if str(path.parent) else Path(".")
    parent.mkdir(parents=True, exist_ok=True)
    # `with_name` (vs `with_suffix`) sidesteps edge cases like dotfiles or
    # extensionless filenames where suffix arithmetic produces wrong results.
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
        fh.flush()
        if _FSYNC_AVAILABLE:
            try:
                os.fsync(fh.fileno())
            except OSError:
                # Some Windows filesystems (e.g. network shares) reject fsync.
                # Loss-of-power durability isn't worth aborting the save.
                pass
    os.replace(tmp, path)


# ── JSON config (freerouter.config.json) ─────────────────────────────────

def load_json(path: str) -> dict[str, Any]:
    p = _resolve(path)
    if not p.is_file():
        return {}
    with open(p, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError(f"{path}: top-level value must be a JSON object")
    return data


def save_json(path: str, data: dict[str, Any]) -> None:
    serialized = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    _atomic_write_text(_resolve(path), serialized)


# ── Rules file (JSON array of Rule objects) ──────────────────────────────

def load_rules(path: str) -> list[dict[str, Any]]:
    p = _resolve(path)
    if not p.is_file():
        return []
    with open(p, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, list):
        raise ValueError(f"{path}: rules file must be a JSON array")
    return data


def save_rules(path: str, rules: list[dict[str, Any]]) -> None:
    serialized = json.dumps(rules, indent=2, ensure_ascii=False) + "\n"
    _atomic_write_text(_resolve(path), serialized)


# ── .env file (KEY=VALUE lines, with quoting) ────────────────────────────

def load_env(path: str) -> dict[str, str]:
    p = _resolve(path)
    if not p.is_file():
        return {}
    out: dict[str, str] = {}
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        out[key] = value
    return out


def save_env(path: str, env: dict[str, str]) -> None:
    lines: list[str] = []
    for key, value in env.items():
        if not key:
            continue
        # Quote values that contain spaces, quotes, or shell-meaningful chars.
        needs_quote = any(c in value for c in ' \t"\'#$`\\') or value == ""
        if needs_quote:
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{key}="{escaped}"')
        else:
            lines.append(f"{key}={value}")
    _atomic_write_text(_resolve(path), "\n".join(lines) + "\n")
