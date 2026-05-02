"""FreeRouter Admin Configuration Manager — CLI entry point.

Standalone, optional companion to FreeRouter. This tool is *not* shipped
with the npm package (``package.json`` only publishes ``dist/``); it lives
beside the source for operators who prefer a GUI over hand-editing JSON.

Usage:
    python config-manager/freerouter_admin.py
    python config-manager/freerouter_admin.py --config ./freerouter.config.json
    python config-manager/freerouter_admin.py --reset-key
    python config-manager/freerouter_admin.py --print-key-path

All file paths are interpreted relative to the operator's current working
directory. The same arguments work identically on Linux, macOS, and
Windows; ``pathlib`` normalises slash conventions on every platform.

Auth: a 32-byte admin key is generated on first run; only its
PBKDF2-HMAC-SHA256 digest is persisted (in ~/.freerouter-admin/key.hash).
The plaintext key is printed once and must be supplied on every later run.
"""
from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

THIS_DIR = Path(__file__).resolve().parent
if str(THIS_DIR) not in sys.path:
    sys.path.insert(0, str(THIS_DIR))

import auth  # noqa: E402


DEFAULT_CONFIG_PATH = "freerouter.config.json"
DEFAULT_RULES_PATH = "freerouter.rules.json"
DEFAULT_ENV_PATH = ".env"


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="freerouter-admin",
        description="Admin GUI for editing FreeRouter configuration, rules, and env vars.",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help=f"Path to FreeRouter config JSON (default: {DEFAULT_CONFIG_PATH}; relative to CWD).",
    )
    parser.add_argument(
        "--rules",
        default=DEFAULT_RULES_PATH,
        help=f"Path to rules JSON for FileRulesSource (default: {DEFAULT_RULES_PATH}; relative to CWD).",
    )
    parser.add_argument(
        "--env",
        default=DEFAULT_ENV_PATH,
        help=f"Path to .env file (default: {DEFAULT_ENV_PATH}; relative to CWD).",
    )
    parser.add_argument(
        "--reset-key",
        action="store_true",
        help="Delete the stored admin key hash and re-generate one on next launch.",
    )
    parser.add_argument(
        "--print-key-path",
        action="store_true",
        help="Print the location of the admin-key hash file and exit.",
    )
    return parser.parse_args(argv)


def _interactive_auth() -> bool:
    """Run the first-launch / subsequent-launch auth flow on stdin/stdout.

    Returns True iff the operator presented a valid key (or just generated
    a fresh one). Returns False on bad key or empty stdin (e.g. piped tty).
    """
    if not auth.key_file_exists():
        print("FreeRouter Admin — first-run setup.")
        print(f"Generating a new admin key (stored as a salted hash at: {auth.KEY_FILE})")
        key = auth.generate_and_store_key()
        print()
        print("  ADMIN KEY (save this; it is shown only once):")
        print(f"  {key}")
        print()
        print("Press Enter to launch the admin app.")
        try:
            input()
        except EOFError:
            pass
        return True

    try:
        provided = getpass.getpass("Admin key: ")
    except (EOFError, KeyboardInterrupt):
        print("Aborted.", file=sys.stderr)
        return False
    if not provided:
        print("No key supplied. Exiting.", file=sys.stderr)
        return False
    if not auth.verify_key(provided):
        print("Invalid admin key. Exiting.", file=sys.stderr)
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(sys.argv[1:] if argv is None else argv))

    if args.print_key_path:
        print(auth.KEY_FILE)
        return 0

    if args.reset_key:
        auth.reset_key()
        print(f"Admin key reset. Re-run without --reset-key to generate a new one.")
        return 0

    if not _interactive_auth():
        return 1

    # Import the GUI after auth so a failed login doesn't open a Tk window.
    try:
        import tkinter as tk
    except ImportError as exc:
        print(
            "Tkinter is not available in this Python build. "
            "On Linux: `apt install python3-tk` or equivalent. "
            "On macOS: install python.org Python or `brew install python-tk`.",
            file=sys.stderr,
        )
        print(f"  ({exc})", file=sys.stderr)
        return 1

    from app import AdminApp  # local import keeps startup fast on `--help`

    root = tk.Tk()
    AdminApp(
        root,
        config_path=args.config,
        rules_path=args.rules,
        env_path=args.env,
    )
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
