"""Per-user UI preferences for the FreeRouter Admin GUI.

NOT the runtime config. This file persists small operator-side state
(most importantly: the last pricing-source URL and the most recently
fetched manifest) alongside the admin-key hash, so the GUI doesn't pull
operator-specific bookkeeping into ``freerouter.config.json`` (which the
runtime validator would warn about).

Failure modes are non-fatal: if the file can't be read or written the GUI
falls back to defaults rather than blocking the operator.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import auth

PREFS_FILE: Path = auth.KEY_DIR / "settings.json"


def load() -> dict[str, Any]:
    if not PREFS_FILE.is_file():
        return {}
    try:
        data = json.loads(PREFS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save(prefs: dict[str, Any]) -> None:
    try:
        PREFS_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        tmp = PREFS_FILE.with_name(PREFS_FILE.name + ".tmp")
        tmp.write_text(json.dumps(prefs, indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, PREFS_FILE)
    except OSError:
        pass


def update(patch: dict[str, Any]) -> dict[str, Any]:
    """Merge `patch` into the saved prefs and return the merged dict."""
    merged = {**load(), **patch}
    save(merged)
    return merged
