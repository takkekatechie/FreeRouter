"""HTTP fetcher for FreeRouter pricing manifests.

Stdlib-only (urllib) so the admin GUI keeps zero third-party deps.

Three "sources" are supported, each producing the same internal
:data:`Manifest` shape (mirroring ``src/finops/pricing-source.ts``)::

    {
      "openai":    { "gpt-4o": { "input": 2.5, "output": 10.0, "cachedInput": 1.25 } },
      "anthropic": { "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0 } }
    }

Sources:

- ``litellm`` — community-maintained ``model_prices_and_context_window.json``
  (BerriAI/litellm). Covers OpenAI, Anthropic, Google/Vertex, Mistral, Groq,
  Cohere, AWS Bedrock, Azure, etc. No authentication.
- ``openrouter`` — live ``/v1/models`` API from OpenRouter. Aggregates real
  vendor pricing. No authentication required for the public catalog.
- ``custom`` — a self-hosted JSON manifest already in the FreeRouter shape.

LLM vendors themselves do **not** expose public JSON pricing endpoints —
their pricing pages are HTML — so "live pricing" in practice means one of
the two aggregator sources above, both of which track vendor changes.

Cross-language consistency
--------------------------
The :func:`_transform_litellm` and :func:`_transform_openrouter` functions
mirror the canonical TypeScript implementations in
``src/finops/pricing-source.ts`` (``transformLiteLLM`` / ``transformOpenRouter``).
The TS runtime is the source of truth — any change to field names,
multipliers, skip rules, or fallback logic must land in both files. The
TS test suite (``tests/pricing-source.test.ts``) exercises the canonical
contract; this module's smoke tests cover the Python mirror.
"""
from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from typing import Any, Callable


Manifest = dict[str, dict[str, dict[str, Any]]]
Transformer = Callable[[Any], Manifest]

_CERT_HINT = (
    "Your Python install can't find a CA bundle to verify the server's "
    "certificate. Two fixes:\n"
    "  1. Install certifi for THIS Python (the tool auto-detects it on next "
    "launch):  python3 -m pip install --upgrade certifi\n"
    "  2. If you're on a python.org build of Python on macOS specifically, "
    "you can also run '/Applications/Python 3.x/Install Certificates.command' "
    "(this only updates the python.org Python — not uv/conda/pyenv/Homebrew "
    "Pythons; for those, use option 1).\n"
    "If you trust the endpoint and just need to bypass verification "
    "(corporate MITM proxy, self-signed internal manifest), enable "
    "'Skip TLS verification' in the Fetch dialog."
)


class PricingFetchError(RuntimeError):
    pass


def _make_ssl_context(verify_tls: bool) -> ssl.SSLContext:
    """Build an SSL context, preferring certifi's CA bundle when installed.

    Why: many non-python.org Python installs (uv, conda, pyenv on macOS)
    ship without a usable CA store, so :func:`ssl.create_default_context`
    fails with ``CERTIFICATE_VERIFY_FAILED`` even on legitimate HTTPS
    endpoints. ``certifi`` (a tiny third-party package) provides Mozilla's
    CA bundle and is the canonical fix. If it isn't installed we fall
    back to the platform default — which still works on Pythons that
    bundle CAs (most Linux distros, the macOS python.org build after the
    Install Certificates step, and Windows).
    """
    if not verify_tls:
        return ssl._create_unverified_context()
    try:
        import certifi  # type: ignore[import-not-found]
    except ImportError:
        return ssl.create_default_context()
    return ssl.create_default_context(cafile=certifi.where())


def fetch(
    url: str,
    bearer_token: str | None = None,
    timeout: float = 10.0,
    verify_tls: bool = True,
    transformer: Transformer | None = None,
) -> Manifest:
    """GET pricing JSON and convert it to a :data:`Manifest`.

    ``transformer`` takes the raw parsed JSON and returns a Manifest. If
    omitted, :func:`_transform_native` is used (assumes the endpoint
    already speaks the FreeRouter manifest shape).

    ``verify_tls=False`` skips certificate verification — only use when
    the operator has explicitly opted in. The function never silently
    degrades to unverified TLS.
    """
    raw = _fetch_json(url, bearer_token=bearer_token, timeout=timeout, verify_tls=verify_tls)
    fn = transformer or _transform_native
    return fn(raw)


def _fetch_json(
    url: str,
    *,
    bearer_token: str | None,
    timeout: float,
    verify_tls: bool,
) -> Any:
    if not url.strip():
        raise PricingFetchError("URL is required")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise PricingFetchError("URL must start with http:// or https://")

    headers = {"Accept": "application/json"}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"

    ctx = _make_ssl_context(verify_tls)

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            status = resp.status
            body = resp.read()
            content_type = resp.headers.get("Content-Type", "") or ""
    except urllib.error.HTTPError as exc:
        raise PricingFetchError(f"HTTP {exc.code}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(reason, ssl.SSLError) or "CERTIFICATE_VERIFY_FAILED" in str(reason):
            raise PricingFetchError(
                f"TLS certificate verification failed: {reason}.\n\n{_CERT_HINT}"
            ) from exc
        raise PricingFetchError(f"network error: {reason}") from exc
    except TimeoutError as exc:
        raise PricingFetchError(f"timeout after {timeout}s") from exc

    if status < 200 or status >= 300:
        raise PricingFetchError(f"unexpected HTTP status: {status}")

    try:
        decoded = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PricingFetchError("response is not UTF-8 text") from exc

    head = decoded.lstrip()[:200].lower()
    looks_like_html = (
        "html" in content_type.lower()
        or head.startswith("<!doctype html")
        or head.startswith("<html")
        or "<html" in head
    )

    try:
        return json.loads(decoded)
    except ValueError as exc:
        if looks_like_html:
            raise PricingFetchError(
                "endpoint returned HTML, not JSON. The URL must point to a JSON "
                "document — not a vendor documentation/marketing page. "
                "Vendors do not publish public JSON pricing APIs; use the "
                "'LiteLLM' or 'OpenRouter' source preset instead, or self-host "
                "a manifest in the FreeRouter shape."
            ) from exc
        raise PricingFetchError("response is not valid JSON") from exc


# ── Transformers ─────────────────────────────────────────────────────────

def _transform_native(raw: Any) -> Manifest:
    """Pass-through for endpoints already speaking the FreeRouter manifest shape."""
    return _coerce(raw)


def _transform_litellm(raw: Any) -> Manifest:
    """Convert LiteLLM's ``model_prices_and_context_window.json`` to a Manifest.

    LiteLLM stores prices as USD per token (very small floats). We multiply
    by 1e6 to match FreeRouter's convention of USD per 1M tokens. Models
    are grouped by ``litellm_provider``.
    """
    if not isinstance(raw, dict):
        raise PricingFetchError("LiteLLM source must be a JSON object")
    out: Manifest = {}
    for model_id, entry in raw.items():
        if not isinstance(model_id, str) or not isinstance(entry, dict):
            continue
        if model_id == "sample_spec":
            continue
        provider = entry.get("litellm_provider")
        if not isinstance(provider, str) or not provider:
            continue
        in_per_token = entry.get("input_cost_per_token")
        out_per_token = entry.get("output_cost_per_token")
        if not _is_number(in_per_token) or not _is_number(out_per_token):
            continue
        pricing: dict[str, Any] = {
            "input": float(in_per_token) * 1_000_000,
            "output": float(out_per_token) * 1_000_000,
        }
        cached = (
            entry.get("cache_read_input_token_cost")
            or entry.get("input_cost_per_token_cache_read")
        )
        if _is_number(cached):
            pricing["cachedInput"] = float(cached) * 1_000_000
        rpm = entry.get("rpm")
        if _is_number(rpm):
            pricing["rpmLimit"] = int(rpm)
        tpm = entry.get("tpm")
        if _is_number(tpm):
            pricing["tpmLimit"] = int(tpm)
        out.setdefault(provider, {})[model_id] = pricing
    if not out:
        raise PricingFetchError("LiteLLM source contained no usable price entries")
    return out


def _transform_openrouter(raw: Any) -> Manifest:
    """Convert OpenRouter's ``/v1/models`` response to a Manifest.

    OpenRouter ids are usually ``provider/model``; we split on the first
    slash. Prices come as JSON strings of USD-per-token, which we coerce
    and multiply by 1e6.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("data"), list):
        raise PricingFetchError("OpenRouter response must have a top-level 'data' array")
    out: Manifest = {}
    for entry in raw["data"]:
        if not isinstance(entry, dict):
            continue
        full_id = entry.get("id")
        pricing_in = entry.get("pricing") or {}
        if not isinstance(full_id, str) or not isinstance(pricing_in, dict):
            continue
        provider, model_id = full_id.split("/", 1) if "/" in full_id else ("openrouter", full_id)
        prompt_per_token = _to_float(pricing_in.get("prompt"))
        completion_per_token = _to_float(pricing_in.get("completion"))
        if prompt_per_token is None and completion_per_token is None:
            continue
        if (prompt_per_token or 0) <= 0 and (completion_per_token or 0) <= 0:
            # Free or unpriced models — skip
            continue
        pricing: dict[str, Any] = {
            "input": (prompt_per_token or 0.0) * 1_000_000,
            "output": (completion_per_token or 0.0) * 1_000_000,
        }
        cached = _to_float(pricing_in.get("input_cache_read"))
        if cached is not None and cached > 0:
            pricing["cachedInput"] = cached * 1_000_000
        out.setdefault(provider, {})[model_id] = pricing
    if not out:
        raise PricingFetchError("OpenRouter response contained no priced models")
    return out


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _to_float(v: Any) -> float | None:
    if _is_number(v):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


# ── Source presets ───────────────────────────────────────────────────────

KNOWN_SOURCES: dict[str, dict[str, Any]] = {
    "litellm": {
        "label": "LiteLLM (community pricing data)",
        "url": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
        "transformer": _transform_litellm,
        "needs_token": False,
        "description": (
            "Community-maintained JSON tracking ~hundreds of models across all "
            "major vendors (OpenAI, Anthropic, Google, Mistral, Groq, Bedrock, "
            "Azure, etc.). Updated frequently. No auth required."
        ),
    },
    "openrouter": {
        "label": "OpenRouter API (live)",
        "url": "https://openrouter.ai/api/v1/models",
        "transformer": _transform_openrouter,
        "needs_token": False,
        "description": (
            "Live aggregated pricing from OpenRouter's public catalog. No auth "
            "required for the catalog endpoint."
        ),
    },
    "custom": {
        "label": "Custom URL (FreeRouter manifest shape)",
        "url": "",
        "transformer": _transform_native,
        "needs_token": False,
        "description": (
            "Self-hosted JSON in the documented FreeRouter shape. Use this when "
            "you maintain pricing internally (e.g. negotiated enterprise rates)."
        ),
    },
}


def _coerce(raw: Any) -> Manifest:
    if not isinstance(raw, dict):
        raise PricingFetchError(
            "manifest must be a JSON object {provider: {modelId: {input, output, ...}}}"
        )
    out: Manifest = {}
    for provider, models in raw.items():
        if not isinstance(provider, str) or not isinstance(models, dict):
            continue
        inner: dict[str, dict[str, Any]] = {}
        for model_id, pricing in models.items():
            if not isinstance(model_id, str) or not isinstance(pricing, dict):
                continue
            inner[model_id] = pricing
        if inner:
            out[provider] = inner
    if not out:
        raise PricingFetchError("manifest is empty or not in the expected shape")
    return out


def all_model_ids(manifest: Manifest) -> list[str]:
    seen: set[str] = set()
    for inner in manifest.values():
        seen.update(inner.keys())
    return sorted(seen)
