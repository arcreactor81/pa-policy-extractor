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
import logging
import os
import time

import requests

log = logging.getLogger("pa-extractor.llm")

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


class LLMError(RuntimeError):
    """Base class for classified LLM failures."""

    def __init__(self, message: str, *, outcome: str | None = None,
                 status: int | None = None) -> None:
        super().__init__(message)
        self.outcome = outcome
        self.status = status


class PermanentLLMError(LLMError):
    """A failure that must not be retried at either retry layer."""


class TransientLLMError(LLMError):
    """A retryable transport, HTTP, or truncation failure."""


class InvalidLLMResponseError(LLMError):
    """A successful HTTP response whose completion payload is unusable."""


# Deliberate four-class transport whitelist. Everything else escapes _chat()
# immediately instead of being silently converted into an inner retry.
_RETRYABLE_TRANSPORT_ERRORS = (
    requests.exceptions.Timeout,
    requests.exceptions.ConnectionError,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.ContentDecodingError,
)


def _transport_outcome(error: BaseException) -> str:
    """Map the retryable transport whitelist to a finite log outcome."""
    if isinstance(error, requests.exceptions.Timeout):
        return "timeout"
    if isinstance(error, requests.exceptions.ChunkedEncodingError):
        return "chunked_encoding_error"
    if isinstance(error, requests.exceptions.ContentDecodingError):
        return "content_decoding_error"
    return "connection_error"


def _log_attempt(*, provider: str, operation: str, outer_attempt: int,
                 http_attempt: int, max_http_attempts: int, outcome: str,
                 status: int | None = None) -> None:
    """Emit one metadata-only record for a physical HTTP attempt."""
    log.info(
        "llm_attempt provider=%s operation=%s outer_attempt=%d "
        "http_attempt=%d max_http_attempts=%d outcome=%s status=%s",
        provider, operation, outer_attempt, http_attempt, max_http_attempts,
        outcome, status if status is not None else "-",
    )


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
        raise PermanentLLMError("DEEPSEEK_API_KEY is not set.")
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
          timeout: float, thinking: bool, provider: str,
          operation: str = "chat", outer_attempt: int = 1) -> str:
    """Shared OpenAI-compatible chat-completion call (primary + validators).

    Holds the ONE copy of the request/retry/parse logic that chat() (DeepSeek
    primary) and chat_secondary() (a single Workers AI validator) both use. The
    only per-provider differences are passed in: `base_url`, `headers`, `model`,
    and `thinking` (DeepSeek-only reasoning effort — Workers AI rejects it).

    Retries only the explicit transient whitelist: the four transport classes,
    HTTP 408/429/5xx, and finish_reason=length. Permanent HTTP/config/blocking
    failures and malformed success payloads escape immediately. Every physical
    requests.post call emits one metadata-only attempt log; prompts, secrets,
    request bodies, and response bodies are never logged.
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
        http_attempt = attempt + 1
        try:
            resp = requests.post(url, headers=headers, json=body, timeout=timeout)
            status = int(resp.status_code)
            if status == 408:
                raise TransientLLMError(
                    f"{provider} returned HTTP 408",
                    outcome="http_408", status=status,
                )
            if status == 429:
                raise TransientLLMError(
                    f"{provider} returned HTTP 429",
                    outcome="http_429", status=status,
                )
            if 500 <= status < 600:
                raise TransientLLMError(
                    f"{provider} returned HTTP {status}",
                    outcome="http_5xx", status=status,
                )
            if 400 <= status < 500:
                raise PermanentLLMError(
                    f"{provider} returned HTTP {status}",
                    outcome="http_4xx_permanent", status=status,
                )
            if status >= 600:
                raise InvalidLLMResponseError(
                    f"{provider} returned invalid HTTP status {status}",
                    outcome="invalid_response", status=status,
                )

            try:
                data = resp.json()
            except ValueError as error:
                raise InvalidLLMResponseError(
                    f"{provider} returned invalid JSON",
                    outcome="invalid_response", status=status,
                ) from error
            if not isinstance(data, dict):
                raise InvalidLLMResponseError(
                    f"{provider} returned a non-object completion",
                    outcome="invalid_response", status=status,
                )
            choices = data.get("choices")
            if not isinstance(choices, list) or not choices:
                raise InvalidLLMResponseError(
                    f"{provider} returned no choices",
                    outcome="invalid_response", status=status,
                )
            choice = choices[0]
            if not isinstance(choice, dict):
                raise InvalidLLMResponseError(
                    f"{provider} returned an invalid choice",
                    outcome="invalid_response", status=status,
                )

            finish = str(choice.get("finish_reason", "")).lower()
            if finish in ("content_filter", "safety"):
                raise PermanentLLMError(
                    f"{provider} blocked completion: finish_reason={finish}",
                    outcome=finish, status=status,
                )
            if finish == "length":
                raise TransientLLMError(
                    f"{provider} truncated completion: finish_reason=length",
                    outcome="length", status=status,
                )

            message = choice.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if not content or not str(content).strip():
                raise InvalidLLMResponseError(
                    f"{provider} returned empty content",
                    outcome="invalid_response", status=status,
                )

            _log_attempt(
                provider=provider, operation=operation, outer_attempt=outer_attempt,
                http_attempt=http_attempt, max_http_attempts=max_retries,
                outcome="success", status=status,
            )
            return str(content)
        except _RETRYABLE_TRANSPORT_ERRORS as error:
            last_err = error
            _log_attempt(
                provider=provider, operation=operation, outer_attempt=outer_attempt,
                http_attempt=http_attempt, max_http_attempts=max_retries,
                outcome=_transport_outcome(error),
            )
        except TransientLLMError as error:
            last_err = error
            _log_attempt(
                provider=provider, operation=operation, outer_attempt=outer_attempt,
                http_attempt=http_attempt, max_http_attempts=max_retries,
                outcome=error.outcome or "transient_error", status=error.status,
            )
        except (PermanentLLMError, InvalidLLMResponseError) as error:
            _log_attempt(
                provider=provider, operation=operation, outer_attempt=outer_attempt,
                http_attempt=http_attempt, max_http_attempts=max_retries,
                outcome=error.outcome or "invalid_response", status=error.status,
            )
            raise
        except Exception:  # noqa: BLE001 - unclassified failures are not retried
            _log_attempt(
                provider=provider, operation=operation, outer_attempt=outer_attempt,
                http_attempt=http_attempt, max_http_attempts=max_retries,
                outcome="unexpected_error",
            )
            raise

        if attempt < max_retries - 1:
            time.sleep(2 * (attempt + 1))

    error = TransientLLMError(
        f"{provider} call failed after {max_retries} attempts",
        outcome="transient_exhausted",
    )
    if last_err is None:
        raise error
    raise error from last_err


def chat(system_instruction: str, user_prompt: str,
         temperature: float = 0.1, json_output: bool = True,
         max_retries: int = 3, metadata: dict | None = None, *,
         operation: str = "chat", outer_attempt: int = 1) -> str:
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
        operation=operation, outer_attempt=outer_attempt,
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
        raise PermanentLLMError("CF_API_TOKEN is not set (secondary provider disabled).")
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
                   max_retries: int = 3, model: str | None = None, *,
                   operation: str = "validator", outer_attempt: int = 1) -> str:
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
        raise PermanentLLMError("secondary base URL is not configured.")
    return _chat(
        base, _secondary_headers(), (model or SECONDARY_MODEL),
        system_instruction=system_instruction, user_prompt=user_prompt,
        temperature=temperature, json_output=json_output, max_retries=max_retries,
        timeout=_SECONDARY_TIMEOUT, thinking=False, provider="secondary",
        operation=operation, outer_attempt=outer_attempt,
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
