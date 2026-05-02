"""Tkinter desktop app for editing FreeRouter configuration files.

The app reads and writes three artifacts in the operator's CWD by default:
  - freerouter.config.json  (main router config)
  - rules.json              (admin rules; FileRulesSource-compatible)
  - .env                    (FreeRouter-related environment variables)

Paths are taken from CLI flags. All writes are atomic and pre-validated.
The app never opens a network port; every operation is a local file write.
"""
from __future__ import annotations

import datetime
import tkinter as tk
from copy import deepcopy
from tkinter import messagebox, simpledialog, ttk
from typing import Any, Callable

import byok_io
import config_io
import prefs
import pricing_fetcher
from validators import validate_config, validate_rules

KNOWN_PROVIDERS = ["google", "openai", "anthropic", "mistral", "groq"]
KNOWN_ENV_VARS: list[tuple[str, str]] = [
    ("FREEROUTER_CONFIG", "Path to the FreeRouter config file"),
    ("ROUTER_MASTER_KEY", "64-char hex AES-256-GCM master key (BYOK store)"),
    ("FREEROUTER_NEW_KEY", "Replacement API key for `rotate-key` CLI"),
    ("PRICING_TOKEN", "Bearer token used by the pricing-refresh source"),
]
BUDGET_WINDOWS = ["hourly", "daily", "weekly", "monthly", "quarterly", "total"]
LIMIT_ACTIONS = ["block", "warn", "downgrade", "notify", "throttle"]
SCOPE_TYPES = ["global", "org", "department", "team", "user"]
RULE_ACTION_TYPES = ["pin", "strategy", "block"]
COST_STRATEGIES = ["cheapest", "balanced", "fastest"]


# ── Tiny form helpers ────────────────────────────────────────────────────

def _grid_label(parent: tk.Widget, text: str, row: int, col: int = 0, sticky: str = "w") -> ttk.Label:
    label = ttk.Label(parent, text=text)
    label.grid(row=row, column=col, sticky=sticky, padx=8, pady=4)
    return label


def _grid_entry(parent: tk.Widget, var: tk.Variable, row: int, col: int = 1, width: int = 36) -> ttk.Entry:
    entry = ttk.Entry(parent, textvariable=var, width=width)
    entry.grid(row=row, column=col, sticky="ew", padx=8, pady=4)
    return entry


def _grid_check(parent: tk.Widget, text: str, var: tk.BooleanVar, row: int, col: int = 1) -> ttk.Checkbutton:
    chk = ttk.Checkbutton(parent, text=text, variable=var)
    chk.grid(row=row, column=col, sticky="w", padx=8, pady=4)
    return chk


def _grid_combo(parent: tk.Widget, var: tk.StringVar, values: list[str], row: int, col: int = 1) -> ttk.Combobox:
    combo = ttk.Combobox(parent, textvariable=var, values=values, state="readonly", width=24)
    combo.grid(row=row, column=col, sticky="w", padx=8, pady=4)
    return combo


def _grid_combo_editable(
    parent: tk.Widget, var: tk.StringVar, values: list[str], row: int, col: int = 1, width: int = 36
) -> ttk.Combobox:
    """Combobox that allows free-form typing AND picking from a values list.

    Used for ID-like fields (orgId, userId, model id) where the operator
    may either reuse a value already present in the config or enter a
    brand-new one.
    """
    combo = ttk.Combobox(parent, textvariable=var, values=values, width=width)
    combo.grid(row=row, column=col, sticky="ew", padx=8, pady=4)
    return combo


def _empty_to_none(value: str) -> str | None:
    return value if value.strip() else None


def _safe_int(value: str) -> int | None:
    value = value.strip()
    if not value:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _safe_float(value: str) -> float | None:
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


# ── Modal dialogs ────────────────────────────────────────────────────────

class _ModalDialog(tk.Toplevel):
    def __init__(self, parent: tk.Widget, title: str):
        super().__init__(parent)
        self.transient(parent)
        self.title(title)
        self.resizable(False, False)
        self.result: dict[str, Any] | None = None
        self.body_frame = ttk.Frame(self, padding=12)
        self.body_frame.grid(row=0, column=0, sticky="nsew")
        self.button_frame = ttk.Frame(self, padding=(12, 0, 12, 12))
        self.button_frame.grid(row=1, column=0, sticky="e")
        ttk.Button(self.button_frame, text="Cancel", command=self.destroy).pack(side="right", padx=4)
        ttk.Button(self.button_frame, text="OK", command=self._on_ok).pack(side="right")
        self.bind("<Return>", lambda _e: self._on_ok())
        self.bind("<Escape>", lambda _e: self.destroy())

    def _on_ok(self) -> None:
        try:
            self.result = self.collect()
        except ValueError as exc:
            messagebox.showerror("Invalid input", str(exc), parent=self)
            return
        self.destroy()

    def collect(self) -> dict[str, Any]:  # pragma: no cover — overridden
        raise NotImplementedError


class BudgetDialog(_ModalDialog):
    def __init__(
        self,
        parent: tk.Widget,
        initial: dict[str, Any] | None = None,
        known_ids: dict[str, list[str]] | None = None,
        known_models: list[str] | None = None,
    ):
        super().__init__(parent, title="Budget Policy")
        b = initial or {}
        ids = known_ids or {}
        models = known_models or []
        scope = b.get("scope") or {"type": "global"}

        self.id_var = tk.StringVar(value=b.get("id", ""))
        self.window_var = tk.StringVar(value=b.get("window", "monthly"))
        self.scope_type_var = tk.StringVar(value=scope.get("type", "global"))
        self.org_var = tk.StringVar(value=scope.get("orgId", ""))
        self.dept_var = tk.StringVar(value=scope.get("departmentId", ""))
        self.team_var = tk.StringVar(value=scope.get("teamId", ""))
        self.user_var = tk.StringVar(value=scope.get("userId", ""))
        self.max_spend_var = tk.StringVar(value=str(b.get("maxSpendUsd", "")))
        self.max_tokens_var = tk.StringVar(value=str(b.get("maxTokens", "") or ""))
        self.max_requests_var = tk.StringVar(value=str(b.get("maxRequests", "") or ""))
        self.action_var = tk.StringVar(value=b.get("onLimitReached", "warn"))
        self.fallback_var = tk.StringVar(value=b.get("fallbackModel", ""))
        self.priority_var = tk.StringVar(value=str(b.get("priority", "") or ""))
        self.alerts_var = tk.StringVar(value=", ".join(str(t) for t in (b.get("alertThresholds") or [])))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        rows = [
            ("ID", self.id_var, "entry"),
            ("Window", self.window_var, ("combo", BUDGET_WINDOWS)),
            ("Scope type", self.scope_type_var, ("combo", SCOPE_TYPES)),
            ("orgId", self.org_var, ("combo_editable", ids.get("orgId", []))),
            ("departmentId", self.dept_var, ("combo_editable", ids.get("departmentId", []))),
            ("teamId", self.team_var, ("combo_editable", ids.get("teamId", []))),
            ("userId", self.user_var, ("combo_editable", ids.get("userId", []))),
            ("maxSpendUsd", self.max_spend_var, "entry"),
            ("maxTokens (optional)", self.max_tokens_var, "entry"),
            ("maxRequests (optional)", self.max_requests_var, "entry"),
            ("onLimitReached", self.action_var, ("combo", LIMIT_ACTIONS)),
            ("fallbackModel (downgrade only)", self.fallback_var, ("combo_editable", models)),
            ("priority (optional)", self.priority_var, "entry"),
            ("alertThresholds (CSV %)", self.alerts_var, "entry"),
        ]
        for r, (label, var, kind) in enumerate(rows):
            _grid_label(f, label, r)
            if kind == "entry":
                _grid_entry(f, var, r)
            elif isinstance(kind, tuple) and kind[0] == "combo":
                _grid_combo(f, var, kind[1], r)
            elif isinstance(kind, tuple) and kind[0] == "combo_editable":
                _grid_combo_editable(f, var, kind[1], r)

    def collect(self) -> dict[str, Any]:
        budget_id = self.id_var.get().strip()
        if not budget_id:
            raise ValueError("ID is required")
        max_spend = _safe_float(self.max_spend_var.get())
        if max_spend is None or max_spend < 0:
            raise ValueError("maxSpendUsd must be a non-negative number")
        scope_type = self.scope_type_var.get()
        scope: dict[str, Any] = {"type": scope_type}
        if scope_type == "org":
            if not self.org_var.get().strip():
                raise ValueError("orgId is required for org scope")
            scope["orgId"] = self.org_var.get().strip()
        elif scope_type == "department":
            if not (self.org_var.get().strip() and self.dept_var.get().strip()):
                raise ValueError("orgId and departmentId required for department scope")
            scope["orgId"] = self.org_var.get().strip()
            scope["departmentId"] = self.dept_var.get().strip()
        elif scope_type == "team":
            if not (self.org_var.get().strip() and self.team_var.get().strip()):
                raise ValueError("orgId and teamId required for team scope")
            scope["orgId"] = self.org_var.get().strip()
            scope["teamId"] = self.team_var.get().strip()
        elif scope_type == "user":
            if not self.user_var.get().strip():
                raise ValueError("userId required for user scope")
            scope["userId"] = self.user_var.get().strip()

        action = self.action_var.get()
        result: dict[str, Any] = {
            "id": budget_id,
            "scope": scope,
            "window": self.window_var.get(),
            "maxSpendUsd": max_spend,
            "onLimitReached": action,
        }
        max_tokens = _safe_int(self.max_tokens_var.get())
        if max_tokens is not None:
            result["maxTokens"] = max_tokens
        max_requests = _safe_int(self.max_requests_var.get())
        if max_requests is not None:
            result["maxRequests"] = max_requests
        if action == "downgrade":
            fallback = self.fallback_var.get().strip()
            if not fallback:
                raise ValueError("fallbackModel is required when onLimitReached='downgrade'")
            result["fallbackModel"] = fallback
        priority = _safe_int(self.priority_var.get())
        if priority is not None:
            result["priority"] = priority
        alerts_raw = self.alerts_var.get().strip()
        if alerts_raw:
            try:
                result["alertThresholds"] = [int(x.strip()) for x in alerts_raw.split(",") if x.strip()]
            except ValueError as exc:
                raise ValueError("alertThresholds must be a CSV of integers") from exc
        return result


class RuleDialog(_ModalDialog):
    def __init__(
        self,
        parent: tk.Widget,
        initial: dict[str, Any] | None = None,
        known_ids: dict[str, list[str]] | None = None,
        known_models: list[str] | None = None,
    ):
        super().__init__(parent, title="Admin Rule")
        r = initial or {}
        ids = known_ids or {}
        models = known_models or []
        match = r.get("match") or {}
        action = r.get("action") or {"type": "pin"}

        self.id_var = tk.StringVar(value=r.get("id", ""))
        self.priority_var = tk.StringVar(value=str(r.get("priority", "") or ""))
        self.user_var = tk.StringVar(value=self._csv(match.get("userId")))
        self.org_var = tk.StringVar(value=self._csv(match.get("orgId")))
        self.team_var = tk.StringVar(value=self._csv(match.get("teamId")))
        self.dept_var = tk.StringVar(value=self._csv(match.get("departmentId")))
        self.model_pattern_var = tk.StringVar(value=match.get("modelPattern", ""))
        self.req_priority_var = tk.StringVar(value=match.get("priority", ""))
        self.action_type_var = tk.StringVar(value=action.get("type", "pin"))
        self.pin_model_var = tk.StringVar(value=action.get("model", ""))
        self.strategy_var = tk.StringVar(value=action.get("strategy", "cheapest"))
        self.candidates_var = tk.StringVar(value=", ".join(action.get("candidateModels") or []))
        self.block_reason_var = tk.StringVar(value=action.get("reason", ""))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        rows = [
            ("Rule ID", self.id_var, "entry"),
            ("Priority (optional)", self.priority_var, "entry"),
            ("Match: userId (CSV)", self.user_var, ("combo_editable", ids.get("userId", []))),
            ("Match: orgId (CSV)", self.org_var, ("combo_editable", ids.get("orgId", []))),
            ("Match: teamId (CSV)", self.team_var, ("combo_editable", ids.get("teamId", []))),
            ("Match: departmentId (CSV)", self.dept_var, ("combo_editable", ids.get("departmentId", []))),
            ("Match: modelPattern (glob)", self.model_pattern_var, "entry"),
            ("Match: request priority", self.req_priority_var, ("combo", ["", "realtime", "batch"])),
            ("Action type", self.action_type_var, ("combo", RULE_ACTION_TYPES)),
            ("Pin: model", self.pin_model_var, ("combo_editable", models)),
            ("Strategy: name", self.strategy_var, ("combo", COST_STRATEGIES)),
            ("Strategy: candidate models (CSV)", self.candidates_var, "entry"),
            ("Block: reason", self.block_reason_var, "entry"),
        ]
        for idx, (label, var, kind) in enumerate(rows):
            _grid_label(f, label, idx)
            if kind == "entry":
                _grid_entry(f, var, idx)
            elif isinstance(kind, tuple) and kind[0] == "combo":
                _grid_combo(f, var, kind[1], idx)
            elif isinstance(kind, tuple) and kind[0] == "combo_editable":
                _grid_combo_editable(f, var, kind[1], idx)

    @staticmethod
    def _csv(value: Any) -> str:
        if value is None:
            return ""
        if isinstance(value, list):
            return ", ".join(str(x) for x in value)
        return str(value)

    @staticmethod
    def _csv_to_list(raw: str) -> str | list[str] | None:
        items = [x.strip() for x in raw.split(",") if x.strip()]
        if not items:
            return None
        return items if len(items) > 1 else items[0]

    def collect(self) -> dict[str, Any]:
        rule_id = self.id_var.get().strip()
        if not rule_id:
            raise ValueError("Rule ID is required")
        match: dict[str, Any] = {}
        for key, var in [
            ("userId", self.user_var), ("orgId", self.org_var),
            ("teamId", self.team_var), ("departmentId", self.dept_var),
        ]:
            parsed = self._csv_to_list(var.get())
            if parsed is not None:
                match[key] = parsed
        if self.model_pattern_var.get().strip():
            match["modelPattern"] = self.model_pattern_var.get().strip()
        if self.req_priority_var.get().strip():
            match["priority"] = self.req_priority_var.get().strip()

        atype = self.action_type_var.get()
        if atype == "pin":
            if not self.pin_model_var.get().strip():
                raise ValueError("Pin action requires a model")
            action: dict[str, Any] = {"type": "pin", "model": self.pin_model_var.get().strip()}
        elif atype == "strategy":
            action = {"type": "strategy", "strategy": self.strategy_var.get()}
            candidates = [x.strip() for x in self.candidates_var.get().split(",") if x.strip()]
            if candidates:
                action["candidateModels"] = candidates
        elif atype == "block":
            if not self.block_reason_var.get().strip():
                raise ValueError("Block action requires a reason")
            action = {"type": "block", "reason": self.block_reason_var.get().strip()}
        else:
            raise ValueError(f"Unknown action type: {atype}")

        rule: dict[str, Any] = {"id": rule_id, "match": match, "action": action}
        priority = _safe_int(self.priority_var.get())
        if priority is not None:
            rule["priority"] = priority
        return rule


class PricingDialog(_ModalDialog):
    def __init__(
        self,
        parent: tk.Widget,
        initial: tuple[str, dict[str, float]] | None = None,
        known_models: list[str] | None = None,
    ):
        super().__init__(parent, title="Pricing Override")
        model, pricing = initial or ("", {})
        models = known_models or []
        self.model_var = tk.StringVar(value=model)
        self.input_var = tk.StringVar(value=str(pricing.get("input", "")))
        self.output_var = tk.StringVar(value=str(pricing.get("output", "")))
        self.cached_var = tk.StringVar(value=str(pricing.get("cachedInput", "") or ""))

        f = self.body_frame
        f.columnconfigure(1, weight=1)
        _grid_label(f, "Model ID", 0); _grid_combo_editable(f, self.model_var, models, 0)
        _grid_label(f, "input (USD/1M tokens)", 1); _grid_entry(f, self.input_var, 1)
        _grid_label(f, "output (USD/1M tokens)", 2); _grid_entry(f, self.output_var, 2)
        _grid_label(f, "cachedInput (optional)", 3); _grid_entry(f, self.cached_var, 3)

    def collect(self) -> dict[str, Any]:
        model = self.model_var.get().strip()
        if not model:
            raise ValueError("Model ID is required")
        input_price = _safe_float(self.input_var.get())
        output_price = _safe_float(self.output_var.get())
        if input_price is None or output_price is None or input_price < 0 or output_price < 0:
            raise ValueError("input and output prices must be non-negative numbers")
        pricing: dict[str, Any] = {"input": input_price, "output": output_price}
        cached = _safe_float(self.cached_var.get())
        if cached is not None:
            pricing["cachedInput"] = cached
        return {"model": model, "pricing": pricing}


class BYOKDialog(_ModalDialog):
    """Capture a single BYOK entry: (userId, provider, apiKey)."""

    def __init__(
        self,
        parent: tk.Widget,
        initial: byok_io.BYOKEntry | None = None,
        known_user_ids: list[str] | None = None,
    ):
        super().__init__(parent, title="BYOK API Key")
        users = known_user_ids or []
        self.user_var = tk.StringVar(value=initial.user_id if initial else "")
        self.provider_var = tk.StringVar(value=initial.provider if initial else KNOWN_PROVIDERS[0])
        # Edits are key-rotation: do not pre-fill the existing secret. The
        # operator always types the new key explicitly.
        self.key_var = tk.StringVar(value="")
        self._reveal_var = tk.BooleanVar(value=False)
        self._is_edit = initial is not None

        f = self.body_frame
        f.columnconfigure(1, weight=1)

        _grid_label(f, "userId", 0)
        _grid_combo_editable(f, self.user_var, users, 0)

        _grid_label(f, "provider", 1)
        _grid_combo(f, self.provider_var, KNOWN_PROVIDERS, 1)

        _grid_label(f, "API key", 2)
        self.key_entry = ttk.Entry(f, textvariable=self.key_var, width=36, show="•")
        self.key_entry.grid(row=2, column=1, sticky="ew", padx=8, pady=4)
        ttk.Checkbutton(
            f, text="Show", variable=self._reveal_var, command=self._toggle_reveal,
        ).grid(row=2, column=2, sticky="w", padx=4)

        if self._is_edit:
            ttk.Label(
                f,
                text=(
                    "Editing rotates the key. The previously stored value is not\n"
                    "revealed — type the replacement key here."
                ),
                foreground="#666", justify="left",
            ).grid(row=3, column=0, columnspan=3, sticky="w", padx=8, pady=(4, 0))

    def _toggle_reveal(self) -> None:
        self.key_entry.configure(show="" if self._reveal_var.get() else "•")

    def collect(self) -> dict[str, Any]:
        user_id = self.user_var.get().strip()
        provider = self.provider_var.get().strip()
        api_key = self.key_var.get()
        if not user_id:
            raise ValueError("userId is required")
        if not provider:
            raise ValueError("provider is required")
        if not api_key.strip():
            raise ValueError("API key is required")
        return {"userId": user_id, "provider": provider, "apiKey": api_key}


class FetchPricingDialog(tk.Toplevel):
    """Fetch a pricing manifest from an HTTP/HTTPS URL and import selected rows.

    Persists the URL (and the most recent successful manifest) into the
    per-user prefs file so subsequent launches pre-fill the field. The
    bearer token defaults to the .env's ``PRICING_TOKEN`` value if loaded.
    """

    def __init__(self, parent: tk.Widget, app: "AdminApp"):
        super().__init__(parent)
        self.transient(parent)
        self.title("Fetch Models & Pricing")
        self.app = app
        self._manifest: pricing_fetcher.Manifest = dict(app._cached_manifest)

        saved = prefs.load()
        token_default = ""
        token_var = app.env_vars.get("PRICING_TOKEN") if hasattr(app, "env_vars") else None
        if token_var is not None:
            token_default = token_var.get() or ""

        self._sources = pricing_fetcher.KNOWN_SOURCES
        self._source_labels = {meta["label"]: key for key, meta in self._sources.items()}
        saved_source = saved.get("pricingFetchSource")
        if saved_source not in self._sources:
            saved_source = "litellm"
        saved_url = saved.get("pricingFetchUrl") or self._sources[saved_source]["url"]
        self._custom_url_memory = (
            saved.get("pricingFetchUrl") if saved_source == "custom" else ""
        )

        self.source_label_var = tk.StringVar(value=self._sources[saved_source]["label"])
        self.url_var = tk.StringVar(value=str(saved_url or ""))
        self.token_var = tk.StringVar(value=token_default)
        self._reveal_var = tk.BooleanVar(value=False)
        # Session-only — never persisted, must be re-enabled each launch so the
        # operator stays deliberate about it.
        self._skip_tls_var = tk.BooleanVar(value=False)

        self.columnconfigure(0, weight=1)
        self.rowconfigure(1, weight=1)

        # Top: source picker + URL + token + Fetch button
        top = ttk.Frame(self, padding=12)
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Source").grid(row=0, column=0, sticky="w", padx=(0, 8), pady=4)
        self.source_combo = ttk.Combobox(
            top,
            textvariable=self.source_label_var,
            state="readonly",
            values=[meta["label"] for meta in self._sources.values()],
            width=42,
        )
        self.source_combo.grid(row=0, column=1, columnspan=2, sticky="w", padx=4, pady=4)
        self.source_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_source_changed())
        ttk.Button(top, text="Fetch", command=self._on_fetch).grid(row=0, column=3, padx=4, pady=4)

        ttk.Label(top, text="Manifest URL").grid(row=1, column=0, sticky="w", padx=(0, 8), pady=4)
        ttk.Entry(top, textvariable=self.url_var, width=64).grid(
            row=1, column=1, columnspan=3, sticky="ew", padx=4, pady=4
        )

        ttk.Label(top, text="Bearer token (optional)").grid(row=2, column=0, sticky="w", padx=(0, 8), pady=4)
        self.token_entry = ttk.Entry(top, textvariable=self.token_var, width=64, show="•")
        self.token_entry.grid(row=2, column=1, sticky="ew", padx=4, pady=4)
        ttk.Checkbutton(
            top, text="Show", variable=self._reveal_var, command=self._toggle_reveal
        ).grid(row=2, column=2, sticky="w", padx=4)

        ttk.Checkbutton(
            top,
            text="Skip TLS verification (insecure — session only)",
            variable=self._skip_tls_var,
            command=self._on_skip_tls_toggle,
        ).grid(row=3, column=0, columnspan=3, sticky="w", padx=(0, 4), pady=(4, 0))

        self.source_help_var = tk.StringVar()
        ttk.Label(
            top, textvariable=self.source_help_var, foreground="#666",
            justify="left", wraplength=720,
        ).grid(row=4, column=0, columnspan=4, sticky="w", padx=(0, 4), pady=(8, 0))
        self._on_source_changed(initial=True)

        # Mid: results tree
        mid = ttk.Frame(self, padding=(12, 0, 12, 0))
        mid.grid(row=1, column=0, sticky="nsew")
        mid.rowconfigure(0, weight=1)
        mid.columnconfigure(0, weight=1)

        self.tree = ttk.Treeview(
            mid,
            columns=("input", "output", "cachedInput", "rpm", "tpm"),
            selectmode="extended",
            height=18,
        )
        self.tree.heading("#0", text="provider / model")
        self.tree.heading("input", text="input ($/1M)")
        self.tree.heading("output", text="output ($/1M)")
        self.tree.heading("cachedInput", text="cached")
        self.tree.heading("rpm", text="rpmLimit")
        self.tree.heading("tpm", text="tpmLimit")
        self.tree.column("#0", width=320)
        for col, anchor in (("input", "e"), ("output", "e"), ("cachedInput", "e"), ("rpm", "e"), ("tpm", "e")):
            self.tree.column(col, width=90, anchor=anchor)
        self.tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(mid, orient="vertical", command=self.tree.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=sb.set)

        self.status_var = tk.StringVar(
            value=(
                f"Loaded {sum(len(m) for m in self._manifest.values())} cached entries. "
                "Click Fetch to refresh."
            )
            if self._manifest
            else "Enter a URL and click Fetch."
        )
        ttk.Label(mid, textvariable=self.status_var, foreground="#555").grid(
            row=1, column=0, columnspan=2, sticky="w", padx=4, pady=(4, 0)
        )

        # Bottom: actions
        bot = ttk.Frame(self, padding=12)
        bot.grid(row=2, column=0, sticky="ew")
        ttk.Button(bot, text="Select all", command=lambda: self._set_all(True)).pack(side="left")
        ttk.Button(bot, text="Select none", command=lambda: self._set_all(False)).pack(side="left", padx=4)
        ttk.Button(bot, text="Close", command=self.destroy).pack(side="right")
        ttk.Button(bot, text="Import selected", command=self._on_import).pack(side="right", padx=4)

        self.bind("<Escape>", lambda _e: self.destroy())
        self.geometry("820x560")
        self._populate_tree()

    def _toggle_reveal(self) -> None:
        self.token_entry.configure(show="" if self._reveal_var.get() else "•")

    def _resolved_source_key(self) -> str:
        return self._source_labels.get(self.source_label_var.get(), "custom")

    def _on_source_changed(self, *, initial: bool = False) -> None:
        key = self._resolved_source_key()
        meta = self._sources[key]
        if not initial:
            # Stash whatever the user had if they were on custom; restore on return
            current_key = key
            if current_key != "custom":
                self.url_var.set(meta["url"])
            else:
                self.url_var.set(self._custom_url_memory or "")
        self.source_help_var.set(str(meta.get("description", "")))

    def _on_skip_tls_toggle(self) -> None:
        if not self._skip_tls_var.get():
            return
        confirmed = messagebox.askyesno(
            "Skip TLS verification?",
            "Disabling TLS verification means the bearer token (if any) and the "
            "fetched manifest can be intercepted or tampered with by anyone "
            "between you and the endpoint.\n\n"
            "Only enable this for trusted self-signed / corporate-MITM setups.\n\n"
            "Continue with verification disabled for this session?",
            parent=self,
            icon="warning",
            default="no",
        )
        if not confirmed:
            self._skip_tls_var.set(False)

    def _populate_tree(self) -> None:
        self.tree.delete(*self.tree.get_children())
        for provider in sorted(self._manifest):
            parent = self.tree.insert("", "end", text=provider, open=True)
            for model_id, pricing in sorted(self._manifest[provider].items()):
                self.tree.insert(
                    parent, "end", iid=f"{provider}::{model_id}", text=model_id,
                    values=(
                        pricing.get("input", ""),
                        pricing.get("output", ""),
                        pricing.get("cachedInput", ""),
                        pricing.get("rpmLimit", ""),
                        pricing.get("tpmLimit", ""),
                    ),
                )

    def _set_all(self, on: bool) -> None:
        leaves = []
        for parent in self.tree.get_children(""):
            for child in self.tree.get_children(parent):
                leaves.append(child)
        if on:
            self.tree.selection_set(leaves)
        else:
            self.tree.selection_remove(leaves)

    def _on_fetch(self) -> None:
        url = self.url_var.get().strip()
        token = self.token_var.get().strip() or None
        source_key = self._resolved_source_key()
        transformer = self._sources[source_key]["transformer"]
        self.status_var.set("Fetching…")
        self.update_idletasks()
        try:
            manifest = pricing_fetcher.fetch(
                url,
                bearer_token=token,
                verify_tls=not self._skip_tls_var.get(),
                transformer=transformer,
            )
        except pricing_fetcher.PricingFetchError as exc:
            self.status_var.set("Fetch failed.")
            messagebox.showerror("Fetch failed", str(exc), parent=self)
            return
        if source_key == "custom":
            self._custom_url_memory = url
        self._manifest = manifest
        self.app._cached_manifest = manifest
        prefs.update({
            "pricingFetchSource": source_key,
            "pricingFetchUrl": url,
            "cachedManifest": manifest,
        })
        self._populate_tree()
        total = sum(len(inner) for inner in manifest.values())
        self.status_var.set(
            f"Fetched {total} model(s) across {len(manifest)} provider(s) via "
            f"{self._sources[source_key]['label']}. Select rows and click Import."
        )
        self.app._refresh_default_model_options()

    def _on_import(self) -> None:
        if not self._manifest:
            messagebox.showinfo("Nothing fetched", "Run Fetch first.", parent=self)
            return
        sel = self.tree.selection()
        # Filter out provider (parent) rows; only leaves carry "::"
        leaves = [iid for iid in sel if "::" in iid]
        if not leaves:
            messagebox.showinfo("Nothing selected", "Select model rows to import.", parent=self)
            return
        overrides = self.app._pricing_dict()
        imported = 0
        skipped: list[str] = []
        for iid in leaves:
            provider, model_id = iid.split("::", 1)
            entry = self._manifest.get(provider, {}).get(model_id)
            if not entry:
                continue
            pricing: dict[str, Any] = {}
            for key in ("input", "output", "cachedInput"):
                v = entry.get(key)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    pricing[key] = float(v)
            if "input" not in pricing or "output" not in pricing:
                skipped.append(model_id)
                continue
            overrides[model_id] = pricing
            imported += 1
        self.app._refresh_pricing_tree()
        self.app._refresh_default_model_options()
        if imported:
            self.app._mark_dirty()
        msg = f"Imported {imported} pricing override(s)."
        if skipped:
            msg += f"\n\nSkipped (missing input/output): {', '.join(skipped)}"
        messagebox.showinfo("Import complete", msg, parent=self)


# ── Main app ─────────────────────────────────────────────────────────────

class AdminApp:
    def __init__(
        self,
        root: tk.Tk,
        config_path: str,
        rules_path: str,
        env_path: str,
    ):
        self.root = root
        self.config_path = config_path
        self.rules_path = rules_path
        self.env_path = env_path

        self.config: dict[str, Any] = config_io.load_json(config_path)
        self.rules: list[dict[str, Any]] = config_io.load_rules(rules_path)
        self.env: dict[str, str] = config_io.load_env(env_path)
        self.byok: list[byok_io.BYOKEntry] = self._load_byok_safe()

        self.dirty = False
        self._suspend_dirty = False
        self._reveal_secrets = tk.BooleanVar(value=False)
        self._reveal_byok = tk.BooleanVar(value=False)
        self._cached_manifest: pricing_fetcher.Manifest = self._load_cached_manifest()

        root.title(self._title())
        root.geometry("960x680")
        root.minsize(820, 580)

        self._build_menu()
        self._build_notebook()
        self._build_statusbar()
        self._refresh_all()

    # ── chrome ─────────────────────────────────────────────────

    def _title(self) -> str:
        marker = "*" if self.dirty else ""
        return f"FreeRouter Config Manager — {self.config_path}{marker}"

    def _mark_dirty(self, *_args: Any) -> None:
        if self._suspend_dirty:
            return
        self.dirty = True
        self.root.title(self._title())
        self.status_var.set("Unsaved changes")

    def _build_menu(self) -> None:
        menubar = tk.Menu(self.root)
        filemenu = tk.Menu(menubar, tearoff=0)
        filemenu.add_command(label="Save", accelerator="Cmd+S", command=self.save_all)
        filemenu.add_command(label="Reload from disk", command=self.reload)
        filemenu.add_separator()
        filemenu.add_command(label="Quit", command=self._on_quit)
        menubar.add_cascade(label="File", menu=filemenu)
        self.root.config(menu=menubar)
        self.root.bind_all("<Command-s>", lambda _e: self.save_all())
        self.root.bind_all("<Control-s>", lambda _e: self.save_all())
        self.root.protocol("WM_DELETE_WINDOW", self._on_quit)

    def _build_notebook(self) -> None:
        nb = ttk.Notebook(self.root)
        nb.pack(fill="both", expand=True, padx=8, pady=(8, 0))
        self.nb = nb
        self._build_general_tab()
        self._build_providers_tab()
        self._build_rate_limit_tab()
        self._build_budgets_tab()
        self._build_rules_tab()
        self._build_pricing_tab()
        self._build_byok_tab()
        self._build_audit_tab()
        self._build_env_tab()

    def _build_statusbar(self) -> None:
        bar = ttk.Frame(self.root, padding=(8, 4))
        bar.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(bar, textvariable=self.status_var).pack(side="left")
        ttk.Button(bar, text="Save", command=self.save_all).pack(side="right")
        ttk.Button(bar, text="Validate", command=self.validate_only).pack(side="right", padx=4)

    # ── tabs ───────────────────────────────────────────────────

    def _build_general_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="General")
        f.columnconfigure(1, weight=1)

        self.default_provider_var = tk.StringVar()
        self.default_model_var = tk.StringVar()
        self.master_key_var = tk.StringVar()
        self.max_input_var = tk.StringVar()
        self.key_expiry_var = tk.StringVar()
        self.guard_var = tk.BooleanVar()
        self.signing_var = tk.BooleanVar()

        for var in (
            self.default_provider_var, self.default_model_var, self.master_key_var,
            self.max_input_var, self.key_expiry_var,
        ):
            var.trace_add("write", self._mark_dirty)
        for bvar in (self.guard_var, self.signing_var):
            bvar.trace_add("write", self._mark_dirty)

        _grid_label(f, "Default provider", 0)
        self.default_provider_combo = ttk.Combobox(
            f, textvariable=self.default_provider_var,
            values=[""] + KNOWN_PROVIDERS, state="readonly", width=24,
        )
        self.default_provider_combo.grid(row=0, column=1, sticky="w", padx=8, pady=4)

        _grid_label(f, "Default model", 1)
        self.default_model_combo = _grid_combo_editable(f, self.default_model_var, [], 1)

        rows = [
            ("Master key (64-char hex)", self.master_key_var),
            ("Max input length (chars)", self.max_input_var),
            ("Key expiry (ms; blank = never)", self.key_expiry_var),
        ]
        for r, (label, var) in enumerate(rows, start=2):
            _grid_label(f, label, r)
            _grid_entry(f, var, r)

        next_row = 2 + len(rows)
        _grid_check(f, "Prompt injection guard", self.guard_var, next_row)
        _grid_check(f, "Outbound request signing (HMAC-SHA256)", self.signing_var, next_row + 1)

    def _build_providers_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Providers")
        f.columnconfigure(1, weight=1)

        self.provider_enabled: dict[str, tk.BooleanVar] = {}
        self.provider_prefixes: dict[str, tk.StringVar] = {}
        ttk.Label(f, text="Enable", width=8).grid(row=0, column=0, padx=8)
        ttk.Label(f, text="Provider").grid(row=0, column=1, sticky="w", padx=8)
        ttk.Label(f, text="Routing prefixes (CSV; blank = defaults)").grid(row=0, column=2, sticky="w", padx=8)
        for r, name in enumerate(KNOWN_PROVIDERS, start=1):
            enabled = tk.BooleanVar(value=True)
            prefixes = tk.StringVar()
            enabled.trace_add("write", self._mark_dirty)
            prefixes.trace_add("write", self._mark_dirty)
            self.provider_enabled[name] = enabled
            self.provider_prefixes[name] = prefixes
            ttk.Checkbutton(f, variable=enabled).grid(row=r, column=0, padx=8, pady=2)
            ttk.Label(f, text=name).grid(row=r, column=1, sticky="w", padx=8)
            ttk.Entry(f, textvariable=prefixes, width=48).grid(row=r, column=2, sticky="ew", padx=8)

        sep_row = len(KNOWN_PROVIDERS) + 2
        ttk.Separator(f, orient="horizontal").grid(row=sep_row, columnspan=3, sticky="ew", pady=12)
        ttk.Label(f, text="Blocked providers (CSV)").grid(row=sep_row + 1, column=0, columnspan=2, sticky="w", padx=8)
        self.blocked_providers_var = tk.StringVar()
        self.blocked_providers_var.trace_add("write", self._mark_dirty)
        ttk.Entry(f, textvariable=self.blocked_providers_var, width=60).grid(
            row=sep_row + 1, column=2, sticky="ew", padx=8
        )
        ttk.Label(f, text="Allowed models (CSV; blank = unrestricted)").grid(
            row=sep_row + 2, column=0, columnspan=2, sticky="w", padx=8
        )
        self.allowed_models_var = tk.StringVar()
        self.allowed_models_var.trace_add("write", self._mark_dirty)
        ttk.Entry(f, textvariable=self.allowed_models_var, width=60).grid(
            row=sep_row + 2, column=2, sticky="ew", padx=8
        )

    def _build_rate_limit_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Rate Limit")
        f.columnconfigure(1, weight=1)
        self.rpm_var = tk.StringVar()
        self.tpm_var = tk.StringVar()
        self.burst_var = tk.StringVar()
        for v in (self.rpm_var, self.tpm_var, self.burst_var):
            v.trace_add("write", self._mark_dirty)
        rows = [
            ("Requests / minute (positive int)", self.rpm_var),
            ("Tokens / minute (optional)", self.tpm_var),
            ("Burst allowance fraction (e.g. 0.2)", self.burst_var),
        ]
        for r, (label, var) in enumerate(rows):
            _grid_label(f, label, r)
            _grid_entry(f, var, r)

    def _build_budgets_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Budgets")
        self.budgets_tree = self._build_table(
            f,
            columns=[("id", 140), ("scope", 160), ("window", 90), ("maxSpendUsd", 120), ("onLimitReached", 130)],
            on_add=self._budget_add,
            on_edit=self._budget_edit,
            on_delete=self._budget_delete,
        )

    def _build_rules_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Rules")
        self.rules_tree = self._build_table(
            f,
            columns=[("id", 140), ("priority", 80), ("match", 220), ("action", 220)],
            on_add=self._rule_add,
            on_edit=self._rule_edit,
            on_delete=self._rule_delete,
        )

    def _build_pricing_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Pricing Overrides")
        self.pricing_tree = self._build_table(
            f,
            columns=[("model", 220), ("input", 120), ("output", 120), ("cachedInput", 120)],
            on_add=self._pricing_add,
            on_edit=self._pricing_edit,
            on_delete=self._pricing_delete,
            extra_buttons=[("Fetch models & pricing…", self._open_fetch_dialog)],
        )

    def _build_byok_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="BYOK Keys")
        f.rowconfigure(1, weight=1)
        f.columnconfigure(0, weight=1)

        # Help banner explaining where keys live + runtime hookup requirement
        help_text = (
            f"Keys are saved to {byok_io.BYOK_FILE} (mode 0600, per-user). "
            "They are NOT written to freerouter.config.json or .env, so they "
            "won't end up in source control. The FreeRouter runtime needs a "
            "FileKeyStore (or equivalent) to load this file at startup and "
            "register each entry via router.setKey(userId, provider, key); "
            "without that hookup, keys saved here are inert."
        )
        ttk.Label(f, text=help_text, foreground="#555", justify="left", wraplength=820).grid(
            row=0, column=0, sticky="w", padx=4, pady=(0, 8),
        )

        table_frame = ttk.Frame(f)
        table_frame.grid(row=1, column=0, sticky="nsew")
        self.byok_tree = self._build_table(
            table_frame,
            columns=[
                ("userId", 140), ("provider", 110),
                ("apiKey", 280), ("createdAt", 170),
            ],
            on_add=self._byok_add,
            on_edit=self._byok_edit,
            on_delete=self._byok_delete,
            extra_buttons=[("Toggle reveal", self._toggle_byok_reveal)],
        )

    def _toggle_byok_reveal(self) -> None:
        self._reveal_byok.set(not self._reveal_byok.get())
        self._refresh_byok_tree()

    def _build_audit_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Audit")
        self.audit_enabled_var = tk.BooleanVar()
        self.audit_enabled_var.trace_add("write", self._mark_dirty)
        _grid_check(f, "Enable audit logging", self.audit_enabled_var, 0, col=0)
        ttk.Label(
            f,
            text=(
                "Audit sinks (file/HTTP/etc.) are wired in code at runtime — set\n"
                "`audit.sink` when constructing the FreeRouter instance. This\n"
                "checkbox toggles the `audit.enabled` flag in the config file."
            ),
            justify="left",
        ).grid(row=1, column=0, sticky="w", padx=8, pady=8)

    def _build_env_tab(self) -> None:
        f = ttk.Frame(self.nb, padding=12)
        self.nb.add(f, text="Env Vars")
        f.columnconfigure(1, weight=1)
        ttk.Label(
            f,
            text=f"Editing {self.env_path} (relative to CWD). Values are masked unless reveal is on.",
            foreground="#555",
        ).grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=(0, 8))

        self.env_vars: dict[str, tk.StringVar] = {}
        self.env_entries: dict[str, ttk.Entry] = {}
        for r, (key, desc) in enumerate(KNOWN_ENV_VARS, start=1):
            _grid_label(f, key, r)
            var = tk.StringVar()
            var.trace_add("write", self._mark_dirty)
            self.env_vars[key] = var
            entry = ttk.Entry(f, textvariable=var, width=48, show="•")
            entry.grid(row=r, column=1, sticky="ew", padx=8, pady=2)
            self.env_entries[key] = entry
            ttk.Label(f, text=desc, foreground="#666").grid(row=r, column=2, sticky="w", padx=8)

        reveal_row = len(KNOWN_ENV_VARS) + 2
        ttk.Checkbutton(
            f, text="Reveal values", variable=self._reveal_secrets, command=self._toggle_secret_reveal
        ).grid(row=reveal_row, column=0, columnspan=2, sticky="w", padx=8, pady=8)

    def _toggle_secret_reveal(self) -> None:
        show = "" if self._reveal_secrets.get() else "•"
        for entry in self.env_entries.values():
            entry.configure(show=show)

    # ── reusable table builder ─────────────────────────────────

    def _build_table(
        self,
        parent: tk.Widget,
        columns: list[tuple[str, int]],
        on_add: Callable[[], None],
        on_edit: Callable[[], None],
        on_delete: Callable[[], None],
        extra_buttons: list[tuple[str, Callable[[], None]]] | None = None,
    ) -> ttk.Treeview:
        parent.rowconfigure(0, weight=1)
        parent.columnconfigure(0, weight=1)
        col_ids = [c[0] for c in columns]
        tree = ttk.Treeview(parent, columns=col_ids, show="headings", height=14)
        for cid, width in columns:
            tree.heading(cid, text=cid)
            tree.column(cid, width=width, anchor="w")
        tree.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(parent, orient="vertical", command=tree.yview)
        sb.grid(row=0, column=1, sticky="ns")
        tree.configure(yscrollcommand=sb.set)

        btns = ttk.Frame(parent)
        btns.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        ttk.Button(btns, text="Add", command=on_add).pack(side="left")
        ttk.Button(btns, text="Edit", command=on_edit).pack(side="left", padx=4)
        ttk.Button(btns, text="Delete", command=on_delete).pack(side="left")
        for label, cb in (extra_buttons or []):
            ttk.Button(btns, text=label, command=cb).pack(side="left", padx=4)
        tree.bind("<Double-1>", lambda _e: on_edit())
        return tree

    # ── known-id / known-model harvesting ─────────────────────

    def _collect_known_ids(self) -> dict[str, list[str]]:
        """Gather IDs already referenced anywhere in budgets or rules.

        Lets the dialogs offer a dropdown of values the operator has used
        before, so they don't have to retype an orgId/userId/etc. New
        values can still be typed — these are editable comboboxes.
        """
        seen: dict[str, set[str]] = {
            "orgId": set(), "departmentId": set(),
            "teamId": set(), "userId": set(),
        }
        for b in self._budgets_list():
            scope = b.get("scope") or {}
            for key in seen:
                v = scope.get(key)
                if isinstance(v, str) and v:
                    seen[key].add(v)
        for r in self.rules:
            match = r.get("match") or {}
            for key in seen:
                v = match.get(key)
                if isinstance(v, list):
                    for item in v:
                        if isinstance(item, str) and item:
                            seen[key].add(item)
                elif isinstance(v, str) and v:
                    seen[key].add(v)
        return {k: sorted(v) for k, v in seen.items()}

    def _collect_known_models(self) -> list[str]:
        """Gather model IDs referenced anywhere in the loaded config."""
        seen: set[str] = set()
        if isinstance(self.config.get("defaultModel"), str) and self.config["defaultModel"]:
            seen.add(self.config["defaultModel"])
        for m in self.config.get("allowedModels") or []:
            if isinstance(m, str) and m:
                seen.add(m)
        for b in self._budgets_list():
            fm = b.get("fallbackModel")
            if isinstance(fm, str) and fm:
                seen.add(fm)
        for r in self.rules:
            action = r.get("action") or {}
            if action.get("type") == "pin" and isinstance(action.get("model"), str):
                seen.add(action["model"])
            for m in action.get("candidateModels") or []:
                if isinstance(m, str) and m:
                    seen.add(m)
        for m in (self.config.get("pricingOverrides") or {}).keys():
            if isinstance(m, str) and m:
                seen.add(m)
        seen.update(pricing_fetcher.all_model_ids(self._cached_manifest))
        return sorted(seen)

    def _load_cached_manifest(self) -> pricing_fetcher.Manifest:
        cached = prefs.load().get("cachedManifest")
        if not isinstance(cached, dict):
            return {}
        out: pricing_fetcher.Manifest = {}
        for provider, models in cached.items():
            if not isinstance(provider, str) or not isinstance(models, dict):
                continue
            inner: dict[str, dict[str, Any]] = {}
            for model_id, pricing in models.items():
                if isinstance(model_id, str) and isinstance(pricing, dict):
                    inner[model_id] = pricing
            if inner:
                out[provider] = inner
        return out

    def _open_fetch_dialog(self) -> None:
        FetchPricingDialog(self.root, self)

    def _refresh_default_model_options(self) -> None:
        """Update the Default model combobox dropdown with current known models."""
        self.default_model_combo["values"] = self._collect_known_models()

    # ── budgets CRUD ──────────────────────────────────────────

    def _budgets_list(self) -> list[dict[str, Any]]:
        return list(self.config.get("budgets") or [])

    def _budget_add(self) -> None:
        dlg = BudgetDialog(
            self.root,
            known_ids=self._collect_known_ids(),
            known_models=self._collect_known_models(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        budgets = self._budgets_list()
        if any(b.get("id") == dlg.result["id"] for b in budgets):
            messagebox.showerror("Duplicate", f"Budget id '{dlg.result['id']}' already exists.")
            return
        budgets.append(dlg.result)
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _budget_edit(self) -> None:
        sel = self._selected_index(self.budgets_tree)
        if sel is None:
            return
        budgets = self._budgets_list()
        dlg = BudgetDialog(
            self.root,
            initial=budgets[sel],
            known_ids=self._collect_known_ids(),
            known_models=self._collect_known_models(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        budgets[sel] = dlg.result
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _budget_delete(self) -> None:
        sel = self._selected_index(self.budgets_tree)
        if sel is None:
            return
        budgets = self._budgets_list()
        budgets.pop(sel)
        self.config["budgets"] = budgets
        self._refresh_budgets_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _refresh_budgets_tree(self) -> None:
        self.budgets_tree.delete(*self.budgets_tree.get_children())
        for b in self._budgets_list():
            scope = b.get("scope") or {}
            scope_label = scope.get("type", "?")
            for f in ("orgId", "departmentId", "teamId", "userId"):
                if scope.get(f):
                    scope_label += f"/{scope[f]}"
            self.budgets_tree.insert("", "end", values=(
                b.get("id", ""), scope_label, b.get("window", ""),
                b.get("maxSpendUsd", ""), b.get("onLimitReached", ""),
            ))

    # ── rules CRUD ────────────────────────────────────────────

    def _rule_add(self) -> None:
        dlg = RuleDialog(
            self.root,
            known_ids=self._collect_known_ids(),
            known_models=self._collect_known_models(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        if any(r.get("id") == dlg.result["id"] for r in self.rules):
            messagebox.showerror("Duplicate", f"Rule id '{dlg.result['id']}' already exists.")
            return
        self.rules.append(dlg.result)
        self._refresh_rules_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _rule_edit(self) -> None:
        sel = self._selected_index(self.rules_tree)
        if sel is None:
            return
        dlg = RuleDialog(
            self.root,
            initial=self.rules[sel],
            known_ids=self._collect_known_ids(),
            known_models=self._collect_known_models(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        self.rules[sel] = dlg.result
        self._refresh_rules_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _rule_delete(self) -> None:
        sel = self._selected_index(self.rules_tree)
        if sel is None:
            return
        self.rules.pop(sel)
        self._refresh_rules_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _refresh_rules_tree(self) -> None:
        self.rules_tree.delete(*self.rules_tree.get_children())
        for r in self.rules:
            match = r.get("match") or {}
            action = r.get("action") or {}
            match_label = ", ".join(f"{k}={v}" for k, v in match.items()) or "(any)"
            action_label = action.get("type", "?")
            if action_label == "pin":
                action_label += f" → {action.get('model', '')}"
            elif action_label == "strategy":
                action_label += f" → {action.get('strategy', '')}"
            elif action_label == "block":
                action_label += f" ({action.get('reason', '')})"
            self.rules_tree.insert("", "end", values=(
                r.get("id", ""), r.get("priority", ""), match_label, action_label,
            ))

    # ── pricing CRUD ──────────────────────────────────────────

    def _pricing_dict(self) -> dict[str, dict[str, float]]:
        return self.config.setdefault("pricingOverrides", {})

    def _pricing_add(self) -> None:
        dlg = PricingDialog(self.root, known_models=self._collect_known_models())
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        overrides = self._pricing_dict()
        if dlg.result["model"] in overrides:
            messagebox.showerror("Duplicate", f"Override for '{dlg.result['model']}' already exists.")
            return
        overrides[dlg.result["model"]] = dlg.result["pricing"]
        self._refresh_pricing_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _pricing_edit(self) -> None:
        sel = self._selected_index(self.pricing_tree)
        if sel is None:
            return
        items = list(self._pricing_dict().items())
        model, pricing = items[sel]
        dlg = PricingDialog(
            self.root,
            initial=(model, pricing),
            known_models=self._collect_known_models(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        overrides = self._pricing_dict()
        if dlg.result["model"] != model:
            del overrides[model]
        overrides[dlg.result["model"]] = dlg.result["pricing"]
        self._refresh_pricing_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _pricing_delete(self) -> None:
        sel = self._selected_index(self.pricing_tree)
        if sel is None:
            return
        items = list(self._pricing_dict().items())
        model, _ = items[sel]
        del self._pricing_dict()[model]
        self._refresh_pricing_tree()
        self._refresh_default_model_options()
        self._mark_dirty()

    def _refresh_pricing_tree(self) -> None:
        self.pricing_tree.delete(*self.pricing_tree.get_children())
        for model, pricing in self._pricing_dict().items():
            self.pricing_tree.insert("", "end", values=(
                model, pricing.get("input", ""), pricing.get("output", ""),
                pricing.get("cachedInput", ""),
            ))

    # ── BYOK CRUD ─────────────────────────────────────────────────

    def _load_byok_safe(self) -> list[byok_io.BYOKEntry]:
        try:
            return byok_io.load()
        except OSError as exc:
            messagebox.showerror(
                "BYOK keys could not be loaded",
                f"{exc}\n\nThe BYOK Keys tab will start empty. Saving will overwrite the file.",
            )
            return []

    def _byok_known_user_ids(self) -> list[str]:
        seen = {e.user_id for e in self.byok}
        seen.update(self._collect_known_ids().get("userId", []))
        return sorted(seen)

    def _byok_add(self) -> None:
        dlg = BYOKDialog(self.root, known_user_ids=self._byok_known_user_ids())
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        if any(
            e.user_id == dlg.result["userId"] and e.provider == dlg.result["provider"]
            for e in self.byok
        ):
            messagebox.showerror(
                "Duplicate",
                f"A key for ({dlg.result['userId']}, {dlg.result['provider']}) already exists. "
                "Edit it instead to rotate.",
            )
            return
        self.byok.append(byok_io.BYOKEntry.new(
            user_id=dlg.result["userId"],
            provider=dlg.result["provider"],
            api_key=dlg.result["apiKey"],
        ))
        self._refresh_byok_tree()
        self._mark_dirty()

    def _byok_edit(self) -> None:
        sel = self._selected_index(self.byok_tree)
        if sel is None:
            return
        existing = self.byok[sel]
        dlg = BYOKDialog(
            self.root, initial=existing, known_user_ids=self._byok_known_user_ids(),
        )
        self.root.wait_window(dlg)
        if dlg.result is None:
            return
        # Edit = rotate (replace key, refresh createdAt). userId/provider can also change;
        # if they do, enforce uniqueness against the rest of the list.
        for i, e in enumerate(self.byok):
            if i == sel:
                continue
            if e.user_id == dlg.result["userId"] and e.provider == dlg.result["provider"]:
                messagebox.showerror(
                    "Duplicate",
                    f"Another entry for ({dlg.result['userId']}, {dlg.result['provider']}) "
                    "already exists.",
                )
                return
        self.byok[sel] = byok_io.BYOKEntry.new(
            user_id=dlg.result["userId"],
            provider=dlg.result["provider"],
            api_key=dlg.result["apiKey"],
        )
        self._refresh_byok_tree()
        self._mark_dirty()

    def _byok_delete(self) -> None:
        sel = self._selected_index(self.byok_tree)
        if sel is None:
            return
        entry = self.byok[sel]
        if not messagebox.askyesno(
            "Delete BYOK key?",
            f"Permanently remove the API key for ({entry.user_id}, {entry.provider})?",
        ):
            return
        self.byok.pop(sel)
        self._refresh_byok_tree()
        self._mark_dirty()

    def _refresh_byok_tree(self) -> None:
        self.byok_tree.delete(*self.byok_tree.get_children())
        reveal = self._reveal_byok.get()
        for entry in self.byok:
            if reveal:
                key_display = entry.api_key
            elif len(entry.api_key) <= 4:
                key_display = "•" * len(entry.api_key)
            else:
                key_display = "•" * (len(entry.api_key) - 4) + entry.api_key[-4:]
            ts = datetime.datetime.fromtimestamp(entry.created_at / 1000).strftime(
                "%Y-%m-%d %H:%M:%S"
            )
            self.byok_tree.insert("", "end", values=(
                entry.user_id, entry.provider, key_display, ts,
            ))

    # ── selection helpers ─────────────────────────────────────

    def _selected_index(self, tree: ttk.Treeview) -> int | None:
        sel = tree.selection()
        if not sel:
            messagebox.showinfo("No selection", "Select a row first.")
            return None
        return tree.index(sel[0])

    # ── load / save ───────────────────────────────────────────

    def _refresh_all(self) -> None:
        self._suspend_dirty = True
        try:
            cfg = self.config
            self.default_provider_var.set(cfg.get("defaultProvider", "") or "")
            self.default_model_var.set(cfg.get("defaultModel", "") or "")
            self.master_key_var.set(cfg.get("masterKey", "") or "")
            self.max_input_var.set(str(cfg.get("maxInputLength", "") or ""))
            self.key_expiry_var.set(str(cfg.get("keyExpiryMs", "") or ""))
            self.guard_var.set(bool(cfg.get("promptInjectionGuard", True)))
            self.signing_var.set(bool(cfg.get("requestSigning", False)))

            providers = cfg.get("providers") or {}
            for name in KNOWN_PROVIDERS:
                p = providers.get(name) or {}
                self.provider_enabled[name].set(bool(p.get("enabled", True)))
                self.provider_prefixes[name].set(", ".join(p.get("routingPrefixes") or []))
            self.blocked_providers_var.set(", ".join(cfg.get("blockedProviders") or []))
            self.allowed_models_var.set(", ".join(cfg.get("allowedModels") or []))

            rl = cfg.get("rateLimit") or {}
            self.rpm_var.set(str(rl.get("requestsPerMinute", "") or ""))
            self.tpm_var.set(str(rl.get("tokensPerMinute", "") or ""))
            self.burst_var.set(str(rl.get("burstAllowance", "") or ""))

            audit = cfg.get("audit") or {}
            self.audit_enabled_var.set(bool(audit.get("enabled", False)))

            for key, var in self.env_vars.items():
                var.set(self.env.get(key, ""))

            self._refresh_budgets_tree()
            self._refresh_rules_tree()
            self._refresh_pricing_tree()
            self._refresh_byok_tree()
            self._refresh_default_model_options()
            self.dirty = False
            self.root.title(self._title())
            self.status_var.set("Ready")
        finally:
            self._suspend_dirty = False

    def _gather_into_config(self) -> dict[str, Any]:
        cfg = deepcopy(self.config)

        cfg["defaultProvider"] = _empty_to_none(self.default_provider_var.get())
        cfg["defaultModel"] = _empty_to_none(self.default_model_var.get())
        if not cfg["defaultProvider"]:
            cfg.pop("defaultProvider", None)
        if not cfg["defaultModel"]:
            cfg.pop("defaultModel", None)

        master_key = _empty_to_none(self.master_key_var.get())
        if master_key:
            cfg["masterKey"] = master_key
        else:
            cfg.pop("masterKey", None)

        max_input = _safe_int(self.max_input_var.get())
        if max_input is not None:
            cfg["maxInputLength"] = max_input
        else:
            cfg.pop("maxInputLength", None)

        key_expiry = _safe_int(self.key_expiry_var.get())
        if key_expiry is not None:
            cfg["keyExpiryMs"] = key_expiry
        else:
            cfg.pop("keyExpiryMs", None)

        cfg["promptInjectionGuard"] = self.guard_var.get()
        cfg["requestSigning"] = self.signing_var.get()

        providers: dict[str, Any] = {}
        for name in KNOWN_PROVIDERS:
            entry: dict[str, Any] = {"enabled": self.provider_enabled[name].get()}
            prefixes = [p.strip() for p in self.provider_prefixes[name].get().split(",") if p.strip()]
            if prefixes:
                entry["routingPrefixes"] = prefixes
            providers[name] = entry
        cfg["providers"] = providers

        blocked = [p.strip() for p in self.blocked_providers_var.get().split(",") if p.strip()]
        if blocked:
            cfg["blockedProviders"] = blocked
        else:
            cfg.pop("blockedProviders", None)
        allowed = [m.strip() for m in self.allowed_models_var.get().split(",") if m.strip()]
        if allowed:
            cfg["allowedModels"] = allowed
        else:
            cfg.pop("allowedModels", None)

        rpm = _safe_int(self.rpm_var.get())
        tpm = _safe_float(self.tpm_var.get())
        burst = _safe_float(self.burst_var.get())
        if rpm is not None or tpm is not None or burst is not None:
            rl: dict[str, Any] = {}
            if rpm is not None:
                rl["requestsPerMinute"] = rpm
            if tpm is not None:
                rl["tokensPerMinute"] = tpm
            if burst is not None:
                rl["burstAllowance"] = burst
            cfg["rateLimit"] = rl
        else:
            cfg.pop("rateLimit", None)

        cfg["audit"] = {"enabled": self.audit_enabled_var.get()}
        return cfg

    def validate_only(self) -> bool:
        cfg = self._gather_into_config()
        cfg_result = validate_config(cfg)
        rules_result = validate_rules(self.rules)

        problems: list[str] = list(cfg_result.errors) + list(rules_result.errors)
        warnings: list[str] = list(cfg_result.warnings) + list(rules_result.warnings)

        if problems:
            messagebox.showerror(
                "Validation failed",
                "Fix these errors before saving:\n\n" + "\n".join(f"• {p}" for p in problems),
            )
            return False
        if warnings:
            messagebox.showwarning(
                "Validation warnings",
                "Config is valid but has warnings:\n\n" + "\n".join(f"• {w}" for w in warnings),
            )
        else:
            messagebox.showinfo("Validation", "Config and rules are valid.")
        return True

    def save_all(self) -> None:
        cfg = self._gather_into_config()
        cfg_result = validate_config(cfg)
        rules_result = validate_rules(self.rules)
        problems: list[str] = list(cfg_result.errors) + list(rules_result.errors)
        if problems:
            messagebox.showerror(
                "Cannot save",
                "Fix these errors before saving:\n\n" + "\n".join(f"• {p}" for p in problems),
            )
            return

        env_out = {k: v.get() for k, v in self.env_vars.items() if v.get().strip()}

        try:
            config_io.save_json(self.config_path, cfg)
            config_io.save_rules(self.rules_path, self.rules)
            config_io.save_env(self.env_path, env_out)
            byok_io.save(self.byok)
        except OSError as exc:
            messagebox.showerror("Save failed", f"{exc}")
            return

        self.config = cfg
        self.env = env_out
        self.dirty = False
        self.root.title(self._title())
        self.status_var.set(
            f"Saved {self.config_path}, {self.rules_path}, {self.env_path}, "
            f"{byok_io.BYOK_FILE}"
        )

    def reload(self) -> None:
        if self.dirty and not messagebox.askyesno(
            "Discard changes?", "Reloading will discard your unsaved edits. Continue?"
        ):
            return
        self.config = config_io.load_json(self.config_path)
        self.rules = config_io.load_rules(self.rules_path)
        self.env = config_io.load_env(self.env_path)
        self.byok = self._load_byok_safe()
        self._refresh_all()
        self.status_var.set("Reloaded from disk")

    def _on_quit(self) -> None:
        if self.dirty and not messagebox.askyesno(
            "Quit without saving?", "You have unsaved changes. Quit anyway?"
        ):
            return
        self.root.destroy()
