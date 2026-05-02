"""Structural validator for freerouter.config.json.

Mirrors src/config-validator.ts so the GUI rejects the same shapes the
TypeScript runtime would. Returns a {valid, errors, warnings} record.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

KNOWN_TOP_LEVEL_KEYS = {
    "$schema", "$comment",
    "masterKey", "defaultProvider", "defaultModel",
    "rateLimit", "budgets", "allowedModels", "blockedProviders",
    "maxInputLength", "promptInjectionGuard", "requestSigning",
    "keyExpiryMs", "audit", "providers", "pricingOverrides",
    "rules",
}

VALID_BUDGET_WINDOWS = {"hourly", "daily", "weekly", "monthly", "quarterly", "total"}
VALID_LIMIT_ACTIONS = {"block", "warn", "downgrade", "notify", "throttle"}
VALID_SCOPE_TYPES = {"global", "org", "department", "team", "user"}
VALID_RULE_ACTIONS = {"pin", "strategy", "block"}
VALID_RULE_PRIORITY_HINTS = {"realtime", "batch"}

_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


@dataclass
class ValidationResult:
    valid: bool = True
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add_error(self, msg: str) -> None:
        self.errors.append(msg)
        self.valid = False

    def merge(self, other: "ValidationResult") -> None:
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)
        if not other.valid:
            self.valid = False


def _is_object(val: Any) -> bool:
    return isinstance(val, dict)


def validate_config(config: Any) -> ValidationResult:
    result = ValidationResult()
    if not _is_object(config):
        result.add_error("Config must be a JSON object")
        return result

    for key in config:
        if key not in KNOWN_TOP_LEVEL_KEYS:
            result.warnings.append(f'Unknown config key "{key}" — possible typo')

    mk = config.get("masterKey")
    if mk is not None:
        if not isinstance(mk, str) or not _HEX64.match(mk):
            result.add_error("masterKey must be a 64-character hex string (32 bytes)")

    rl = config.get("rateLimit")
    if rl is not None:
        if not _is_object(rl):
            result.add_error("rateLimit must be an object")
        else:
            rpm = rl.get("requestsPerMinute")
            if not isinstance(rpm, int) or isinstance(rpm, bool) or rpm <= 0:
                result.add_error("rateLimit.requestsPerMinute must be a positive integer")
            tpm = rl.get("tokensPerMinute")
            if tpm is not None and (not isinstance(tpm, (int, float)) or isinstance(tpm, bool) or tpm <= 0):
                result.add_error("rateLimit.tokensPerMinute must be a positive number")
            ba = rl.get("burstAllowance")
            if ba is not None and (not isinstance(ba, (int, float)) or isinstance(ba, bool) or ba < 0):
                result.add_error("rateLimit.burstAllowance must be a non-negative number")

    budgets = config.get("budgets")
    if budgets is not None:
        if not isinstance(budgets, list):
            result.add_error("budgets must be an array")
        else:
            for i, b in enumerate(budgets):
                _validate_budget(b, f"budgets[{i}]", result)

    audit = config.get("audit")
    if audit is not None:
        if not _is_object(audit):
            result.add_error("audit must be an object")
        elif "enabled" in audit and not isinstance(audit["enabled"], bool):
            result.add_error("audit.enabled must be a boolean")

    mil = config.get("maxInputLength")
    if mil is not None and (not isinstance(mil, (int, float)) or isinstance(mil, bool) or mil <= 0):
        result.add_error("maxInputLength must be a positive number")

    for field_name in ("allowedModels", "blockedProviders"):
        val = config.get(field_name)
        if val is not None:
            if not isinstance(val, list) or not all(isinstance(x, str) for x in val):
                result.add_error(f"{field_name} must be an array of strings")

    providers = config.get("providers")
    if providers is not None and not _is_object(providers):
        result.add_error("providers must be an object")

    return result


def _validate_budget(b: Any, prefix: str, result: ValidationResult) -> None:
    if not _is_object(b):
        result.add_error(f"{prefix} must be an object")
        return
    if not isinstance(b.get("id"), str) or b.get("id") == "":
        result.add_error(f"{prefix}.id must be a non-empty string")
    msu = b.get("maxSpendUsd")
    if not isinstance(msu, (int, float)) or isinstance(msu, bool) or msu < 0:
        result.add_error(f"{prefix}.maxSpendUsd must be a non-negative number")
    if b.get("window") not in VALID_BUDGET_WINDOWS:
        result.add_error(f"{prefix}.window must be one of: {sorted(VALID_BUDGET_WINDOWS)}")
    if b.get("onLimitReached") not in VALID_LIMIT_ACTIONS:
        result.add_error(f"{prefix}.onLimitReached must be one of: {sorted(VALID_LIMIT_ACTIONS)}")
    if b.get("onLimitReached") == "downgrade" and not isinstance(b.get("fallbackModel"), str):
        result.add_error(f"{prefix}.fallbackModel is required when onLimitReached === 'downgrade'")
    scope = b.get("scope")
    if _is_object(scope):
        if scope.get("type") not in VALID_SCOPE_TYPES:
            result.add_error(f"{prefix}.scope.type must be one of: {sorted(VALID_SCOPE_TYPES)}")
    else:
        result.add_error(f"{prefix}.scope must be an object with a type field")


def validate_rules(rules: Any) -> ValidationResult:
    result = ValidationResult()
    if not isinstance(rules, list):
        result.add_error("rules file must be a JSON array")
        return result
    for i, rule in enumerate(rules):
        prefix = f"rules[{i}]"
        if not _is_object(rule):
            result.add_error(f"{prefix} must be an object")
            continue
        if not isinstance(rule.get("id"), str) or rule.get("id") == "":
            result.add_error(f"{prefix}.id must be a non-empty string")
        if not _is_object(rule.get("match")):
            result.add_error(f"{prefix}.match must be an object")
        action = rule.get("action")
        if not _is_object(action):
            result.add_error(f"{prefix}.action must be an object")
            continue
        atype = action.get("type")
        if atype not in VALID_RULE_ACTIONS:
            result.add_error(
                f"{prefix}.action.type must be one of: {sorted(VALID_RULE_ACTIONS)}"
            )
        elif atype == "pin" and not isinstance(action.get("model"), str):
            result.add_error(f"{prefix}.action.model is required for pin actions")
        elif atype == "block" and not isinstance(action.get("reason"), str):
            result.add_error(f"{prefix}.action.reason is required for block actions")
        elif atype == "strategy" and not isinstance(action.get("strategy"), str):
            result.add_error(f"{prefix}.action.strategy is required for strategy actions")
        match = rule.get("match")
        if _is_object(match) and match.get("priority") not in (None, *VALID_RULE_PRIORITY_HINTS):
            result.add_error(
                f"{prefix}.match.priority must be one of: {sorted(VALID_RULE_PRIORITY_HINTS)}"
            )
    return result
