"""
llm.py — DeepSeek V4-Pro client, OpenAI-compatible, routed through Cloudflare
AI Gateway.

This is the ONLY part of the reasoning pipeline that differs from the original
submission. The original called Gemini 2.5 Flash via `google.genai`; here we call
DeepSeek `deepseek-v4-pro` via its OpenAI-compatible Chat Completions API. The
prompts, validators and the temperature (0.1) are unchanged — see core.py, which
imports them verbatim from the original notebooks.

Endpoint resolution (in priority order):
  1. DEEPSEEK_BASE_URL                         — explicit full base, used as-is.
  2. CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID     — build the AI Gateway DeepSeek
       https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/deepseek
  3. https://api.deepseek.com                  — DeepSeek direct (no gateway).

Auth:
  DEEPSEEK_API_KEY   — required (Bearer token for DeepSeek).
  CF_AIG_TOKEN       — optional; sent as `cf-aig-authorization: Bearer <token>`
                       when the AI Gateway is configured as authenticated.

W3 — optional secondary (consensus) validator provider(s):
  One or more SECONDARY, independent extractors reachable through Cloudflare
  Workers AI's OpenAI-compatible Chat Completions endpoint. They are used ONLY by
  the optional multi-model consensus feature (see core.py); DeepSeek stays the
  canonical/primary extractor. Config (all from env, forwarded by the Worker):
    CF_API_TOKEN       — Cloudflare account API token scoped to Workers AI
                         (Bearer). REQUIRED to enable consensus; if absent the
                         feature silently no-ops (the canonical result is unchanged).
    VALIDATOR_MODELS   — CSV of Workers AI model ids (each "@cf/..."). This is the
                         3-MODEL consensus generalization of the original single
                         SECONDARY_MODEL: every id in the list is run as an
                         independent validator. Default:
                           "@cf/openai/gpt-oss-20b,
                            @cf/mistralai/mistral-small-3.1-24b-instruct"
                         (both 128k-context with strong JSON mode; see
                         _DEFAULT_VALIDATOR_MODELS for the rationale). For backward
                         compatibility, if VALIDATOR_MODELS is unset but the legacy
                         SECONDARY_MODEL is set, that single model is used.
    SECONDARY_MODEL    — legacy single-validator id (kept for compat; superseded by
                         VALIDATOR_MODELS). VALIDATOR_MODELS[0] is exposed as
                         SECONDARY_MODEL for callers/diagnostics that still read it.
    CF_AIG_ACCOUNT_ID  — reused as the Cloudflare account id for the endpoint URL.
    SECONDARY_BASE_URL — optional explicit full base (overrides the built URL).
  Each validator uses the SAME SYSTEM_PROMPT + user prompt and the SAME request /
  parse shape, but NEVER receives the DeepSeek-only thinking / reasoning_effort
  params (Workers AI rejects them). JSON mode is requested best-effort; the
  caller falls back to the notebooks' lenient JSON parser if it isn't honoured.

  Refactor note (eval low-nit): chat() [primary DeepSeek] and chat_secondary()
  [a single validator] now share one private _chat(base_url, headers, model, *,
  thinking) helper that holds the common request/retry/parse logic. The ONLY
  per-provider differences are the base URL, auth headers, model id, and whether
  DeepSeek-only thinking/reasoning_effort is attached.
"""
from __future__ import annotations

import json
import os
import time

import requests

MODEL_ID = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-pro").strip()
# 900s: window-packed inputs on big documents run multi-minute prefill on the
# provider side (measured live); 300s timed out the slow tail and surfaced as
# per-brand "extraction failed". The container's NDJSON heartbeats keep the
# client stream alive while a call runs long.
_TIMEOUT = float(os.environ.get("DEEPSEEK_TIMEOUT", "900"))

# ── W3 secondary (Workers AI) validator config ───────────────────────────────
# 3-MODEL consensus: a LIST of Workers AI validators (VALIDATOR_MODELS, CSV of
# "@cf/..." ids). The primary/canonical extractor is always DeepSeek (chat());
# these are the cross-check validators. Default = GPT-OSS 20B + Mistral Small
# 3.1 24B: both have 128k context on Workers AI (policy docs reach ~75k tokens,
# and Workers AI HARD-ERRORS on oversized input rather than truncating) and
# top-tier JSON-mode reliability. Do NOT default to llama-3.3-70b-fp8-fast
# (24k ctx on Workers AI) or gemma-3-12b (deprecated 2026-05-30); the cheap
# small-doc fallback is @cf/qwen/qwen3-30b-a3b-fp8 (32.7k ctx).
_DEFAULT_VALIDATOR_MODELS = (
    "@cf/openai/gpt-oss-20b,@cf/mistralai/mistral-small-3.1-24b-instruct"
)
_SECONDARY_TIMEOUT = float(os.environ.get("SECONDARY_TIMEOUT", "300"))

# Explicit output-token ceiling for every chat call. Workers AI models default
# to max_tokens=256 when the field is omitted — far too small for the ~2.5k-token
# extraction JSON, and the truncated output would parse as a half-empty row.
# DeepSeek's default is generous, but sending the field is harmless there.
LLM_MAX_TOKENS = int(os.environ.get("LLM_MAX_TOKENS", "4096"))


def _parse_validator_models() -> list:
    """Resolve the ordered, de-duplicated list of Workers AI validator model ids.

    Priority:
      1. VALIDATOR_MODELS — CSV of "@cf/..." ids (the 3-model generalization).
      2. SECONDARY_MODEL  — legacy single-validator id (backward compat) when
         VALIDATOR_MODELS is unset/empty.
      3. The built-in default pair (GPT-OSS 20B + Mistral Small 3.1 24B).
    Blank tokens are dropped; order is preserved; duplicates removed.
    """
    raw = os.environ.get("VALIDATOR_MODELS", "").strip()
    if not raw:
        # Backward compat: a lone legacy SECONDARY_MODEL still works as one validator.
        legacy = os.environ.get("SECONDARY_MODEL", "").strip()
        raw = legacy if legacy else _DEFAULT_VALIDATOR_MODELS
    seen, models = set(), []
    for tok in raw.split(","):
        m = tok.strip()
        if m and m not in seen:
            seen.add(m)
            models.append(m)
    return models


# Resolved once at import (env is fixed for the process lifetime, forwarded by the
# Worker). VALIDATOR_MODELS is the canonical list; SECONDARY_MODEL is kept as the
# first validator's id for backward compatibility with callers/diagnostics that
# still read the single-model name.
VALIDATOR_MODELS = _parse_validator_models()
SECONDARY_MODEL = VALIDATOR_MODELS[0] if VALIDATOR_MODELS else ""


def _base_url() -> str:
    explicit = os.environ.get("DEEPSEEK_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    acct = os.environ.get("CF_AIG_ACCOUNT_ID", "").strip()
    gw = os.environ.get("CF_AIG_GATEWAY_ID", "").strip()
    if acct and gw:
        return f"https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/deepseek"
    return "https://api.deepseek.com"


def _headers(metadata: dict | None = None) -> dict:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set.")
    h = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    aig_token = os.environ.get("CF_AIG_TOKEN", "").strip()
    if aig_token:
        h["cf-aig-authorization"] = f"Bearer {aig_token}"
    # Optional Cloudflare AI Gateway cost-attribution metadata. Only sent when
    # truthy; DeepSeek's direct endpoint harmlessly ignores the header.
    if metadata:
        h["cf-aig-metadata"] = json.dumps(metadata)
    return h


def _chat(base_url: str, headers: dict, model: str, *,
          system_instruction: str, user_prompt: str,
          temperature: float, json_output: bool, max_retries: int,
          timeout: float, thinking: bool, provider: str) -> str:
    """Shared OpenAI-compatible chat-completion call (primary + validators).

    Holds the ONE copy of the request/retry/parse logic that chat() (DeepSeek
    primary) and chat_secondary() (a single Workers AI validator) both use. The
    only per-provider differences are passed in: `base_url`, `headers`, `model`,
    and `thinking` (DeepSeek-only reasoning effort — Workers AI rejects it).

    Mirrors the retry semantics of the original `call_gemini`: transient errors
    and non-stop finish reasons are retried; the final content string is returned
    for the caller to JSON-parse with the notebooks' own parser. Raises on total
    failure so the caller can record an error row / degrade gracefully. `provider`
    is used only in the final error message.
    """
    url = f"{base_url}/chat/completions"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_instruction},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": LLM_MAX_TOKENS,
        "stream": False,
    }
    if json_output:
        # OpenAI-compatible JSON mode. DeepSeek supports response_format
        # {"type": "json_object"}; Workers AI honours it on the Llama 3.x /
        # DeepSeek / Hermes families (best-effort / harmless elsewhere). The
        # prompts already instruct JSON output regardless.
        body["response_format"] = {"type": "json_object"}

    if thinking:
        # Reasoning/thinking — DeepSeek-only. The original pipeline ran Gemini with
        # dynamic thinking (thinking_budget=-1) for this nuanced step-counting /
        # FDA-line reasoning; DeepSeek v4-pro exposes an equivalent. Never sent to
        # Workers AI validators (which reject these params).
        body["thinking"] = {"type": "enabled"}
        effort = os.environ.get("DEEPSEEK_REASONING_EFFORT", "high").strip()
        if effort:
            body["reasoning_effort"] = effort

    last_err = None
    for attempt in range(max_retries):
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            if resp.status_code >= 400:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
            data = resp.json()
            choices = data.get("choices") or []
            if not choices:
                raise ValueError(f"no choices returned: {str(data)[:300]}")
            choice = choices[0]
            finish = str(choice.get("finish_reason", "")).lower()
            # `stop` = normal completion. `length` = truncated (retryable). Treat
            # content-filter style stops as terminal failures.
            if finish in ("content_filter", "safety"):
                raise ValueError(f"blocked: finish_reason={finish}")
            content = (choice.get("message") or {}).get("content")
            if not content or not str(content).strip():
                raise ValueError(f"empty content (finish_reason={finish})")
            return str(content)
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < max_retries - 1:
                time.sleep(2 * (attempt + 1))
            continue

    raise RuntimeError(f"{provider} call failed after {max_retries} attempts: {last_err}")


def chat(system_instruction: str, user_prompt: str,
         temperature: float = 0.1, json_output: bool = True,
         max_retries: int = 3, metadata: dict | None = None) -> str:
    """Run one chat completion against the PRIMARY (DeepSeek) provider.

    Thin wrapper over _chat() with the DeepSeek base URL/headers, the canonical
    model, and DeepSeek-only thinking/reasoning enabled (unless DEEPSEEK_THINKING
    is set to off, e.g. for faster/cheaper smoke tests). Returns the assistant
    message content (text) for the caller to JSON-parse.
    """
    thinking = os.environ.get("DEEPSEEK_THINKING", "on").strip().lower() != "off"
    return _chat(
        _base_url(), _headers(metadata), MODEL_ID,
        system_instruction=system_instruction, user_prompt=user_prompt,
        temperature=temperature, json_output=json_output, max_retries=max_retries,
        timeout=_TIMEOUT, thinking=thinking, provider="DeepSeek",
    )


# ── W3 secondary provider (Cloudflare Workers AI, OpenAI-compatible) ──────────
def _secondary_base_url() -> str:
    """Resolve the Workers AI OpenAI-compatible base URL.

    Priority:
      1. SECONDARY_BASE_URL                 — explicit full base, used as-is.
      2. CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID — the AI GATEWAY workers-ai
           OpenAI-compatible base
           https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/workers-ai/v1
           Routing validators through the gateway (like the DeepSeek primary)
           puts them under the gateway's analytics AND the operator's spend cap
           — the cost-control story depends on this.
      3. CF_AIG_ACCOUNT_ID only             — the direct REST API v1 base
           https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1
           (works, but bypasses gateway analytics/caps).
    Returns "" when no account id is available (caller treats as disabled).
    """
    explicit = os.environ.get("SECONDARY_BASE_URL", "").strip().rstrip("/")
    if explicit:
        return explicit
    acct = os.environ.get("CF_AIG_ACCOUNT_ID", "").strip()
    gw = os.environ.get("CF_AIG_GATEWAY_ID", "").strip()
    if acct and gw:
        return f"https://gateway.ai.cloudflare.com/v1/{acct}/{gw}/workers-ai/v1"
    if acct:
        return f"https://api.cloudflare.com/client/v4/accounts/{acct}/ai/v1"
    return ""


def secondary_enabled() -> bool:
    """True iff the secondary (consensus) validators are fully configured.

    Requires a Cloudflare account API token (CF_API_TOKEN), a resolvable base
    URL (an explicit SECONDARY_BASE_URL or a CF_AIG_ACCOUNT_ID to build one), AND
    at least one validator model in VALIDATOR_MODELS. When this is False the
    consensus feature silently no-ops — the canonical DeepSeek result is always
    returned regardless.
    """
    return (
        bool(os.environ.get("CF_API_TOKEN", "").strip())
        and bool(_secondary_base_url())
        and bool(VALIDATOR_MODELS)
    )


def _secondary_headers() -> dict:
    key = os.environ.get("CF_API_TOKEN", "").strip()
    if not key:
        raise RuntimeError("CF_API_TOKEN is not set (secondary provider disabled).")
    h = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    # When validator calls route through an AUTHENTICATED AI Gateway (see
    # _secondary_base_url priority 2), the gateway expects its own token too —
    # same pattern as the primary path's _headers().
    aig_token = os.environ.get("CF_AIG_TOKEN", "").strip()
    if aig_token:
        h["cf-aig-authorization"] = f"Bearer {aig_token}"
    return h


def chat_secondary(system_instruction: str, user_prompt: str,
                   temperature: float = 0.1, json_output: bool = True,
                   max_retries: int = 3, model: str | None = None) -> str:
    """Run one chat completion against a SECONDARY validator (Workers AI).

    Thin wrapper over _chat() with the Workers AI base URL/headers and a single
    validator `model` (defaults to SECONDARY_MODEL = the first VALIDATOR_MODELS
    entry; the 3-model consensus caller passes each id explicitly). Mirrors chat()'s
    request/parse/retry shape so the caller can reuse the same notebook JSON parser
    on the returned content. Deliberately passes thinking=False — Workers AI rejects
    the DeepSeek-only thinking / reasoning_effort params. JSON mode is best-effort;
    if a model doesn't honour it the lenient notebook parser still recovers the JSON.

    Raises on total failure so the caller can degrade gracefully (omit that
    validator from consensus).
    """
    base = _secondary_base_url()
    if not base:
        raise RuntimeError("secondary base URL is not configured.")
    return _chat(
        base, _secondary_headers(), (model or SECONDARY_MODEL),
        system_instruction=system_instruction, user_prompt=user_prompt,
        temperature=temperature, json_output=json_output, max_retries=max_retries,
        timeout=_SECONDARY_TIMEOUT, thinking=False, provider="secondary",
    )


def selftest_payload() -> dict:
    """Return the resolved (non-secret) config for /health diagnostics."""
    return {
        "model": MODEL_ID,
        "base_url": _base_url(),
        "key_present": bool(os.environ.get("DEEPSEEK_API_KEY", "").strip()),
        "aig_authenticated": bool(os.environ.get("CF_AIG_TOKEN", "").strip()),
        # W3 secondary (consensus) validators — non-secret diagnostics only.
        "secondary": {
            "enabled": secondary_enabled(),
            "model": SECONDARY_MODEL,            # first validator (legacy field)
            "validator_models": list(VALIDATOR_MODELS),
            "num_validators": len(VALIDATOR_MODELS),
            "base_url": _secondary_base_url(),
            "token_present": bool(os.environ.get("CF_API_TOKEN", "").strip()),
        },
    }
