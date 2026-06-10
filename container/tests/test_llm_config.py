"""
Config-logic tests for pipeline.llm — max_tokens, validator-model resolution,
and the Workers AI (secondary) endpoint/header priority chain.

These exercise PURE configuration logic only — no network. Import-time config
(LLM_MAX_TOKENS, VALIDATOR_MODELS, SECONDARY_MODEL) is tested by reloading
pipeline.llm under a monkeypatched env; call-time config (_secondary_base_url,
_secondary_headers) is tested by calling the functions directly under the same
patched env. The one _chat() test stubs requests.post with a capture fake that
returns a minimal valid completion, so the request-body construction (model +
max_tokens passthrough) is asserted without any HTTP.

The defaults under test are the 128k-context, JSON-reliable validator pair
(@cf/openai/gpt-oss-20b + @cf/mistralai/mistral-small-3.1-24b-instruct) and the
AI-Gateway-first Workers AI base URL — the cost-cap story depends on validators
routing through the gateway, so the URL priority is pinned here.
"""
from __future__ import annotations

import importlib

import pytest

from pipeline import llm

# Every env var that pipeline.llm reads at import time OR call time. Each test
# starts from a clean slate of these (deleted), then sets only what it needs.
_LLM_ENV_KEYS = (
    "DEEPSEEK_MODEL",
    "DEEPSEEK_TIMEOUT",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_REASONING_EFFORT",
    "SECONDARY_TIMEOUT",
    "SECONDARY_BASE_URL",
    "SECONDARY_MODEL",
    "VALIDATOR_MODELS",
    "LLM_MAX_TOKENS",
    "CF_AIG_ACCOUNT_ID",
    "CF_AIG_GATEWAY_ID",
    "CF_AIG_TOKEN",
    "CF_API_TOKEN",
)

_DEFAULT_PAIR = [
    "@cf/openai/gpt-oss-20b",
    "@cf/mistralai/mistral-small-3.1-24b-instruct",
]


@pytest.fixture
def llm_env(monkeypatch):
    """Reload pipeline.llm under a controlled env; restore the real module after.

    Returns a callable: llm_env(VAR="value", ...) -> the reloaded llm module.
    All _LLM_ENV_KEYS are first DELETED so ambient CI/dev env can't leak in,
    then the given overrides are applied, then pipeline.llm is reloaded so the
    import-time constants (LLM_MAX_TOKENS, VALIDATOR_MODELS, SECONDARY_MODEL)
    re-resolve. Teardown undoes the env patches and reloads once more, so other
    test modules keep seeing the ambient-env module state.
    """
    def _reload(**env):
        for key in _LLM_ENV_KEYS:
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        return importlib.reload(llm)

    yield _reload
    monkeypatch.undo()
    importlib.reload(llm)


# ─────────────────────────── max_tokens (LLM_MAX_TOKENS) ──────────────────────
def test_max_tokens_default_is_4096(llm_env):
    mod = llm_env()
    assert mod.LLM_MAX_TOKENS == 4096


def test_max_tokens_env_override(llm_env):
    mod = llm_env(LLM_MAX_TOKENS="2048")
    assert mod.LLM_MAX_TOKENS == 2048


def test_chat_body_carries_max_tokens_and_model(llm_env, monkeypatch):
    """_chat() must send an explicit max_tokens (Workers AI defaults to 256
    when omitted — far too small for the extraction JSON) and pass the model
    id through verbatim. requests.post is stubbed; no network."""
    mod = llm_env(LLM_MAX_TOKENS="2048")
    captured = {}

    class _FakeResp:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "choices": [
                    {"finish_reason": "stop",
                     "message": {"content": '{"ok": true}'}}
                ]
            }

    def _fake_post(url, headers=None, json=None, timeout=None):
        captured["url"] = url
        captured["body"] = json
        return _FakeResp()

    monkeypatch.setattr(mod.requests, "post", _fake_post)

    content = mod._chat(
        "https://unit.test/base", {"Authorization": "Bearer x"},
        "@cf/test/some-model",
        system_instruction="sys", user_prompt="user",
        temperature=0.1, json_output=True, max_retries=1,
        timeout=5.0, thinking=False, provider="test",
    )

    assert content == '{"ok": true}'
    body = captured["body"]
    assert body["max_tokens"] == mod.LLM_MAX_TOKENS == 2048
    assert body["model"] == "@cf/test/some-model"
    assert captured["url"] == "https://unit.test/base/chat/completions"


# ───────────────────── _secondary_base_url priority chain ─────────────────────
def test_secondary_base_url_explicit_wins(llm_env):
    mod = llm_env(
        SECONDARY_BASE_URL="https://my.proxy.example/v1/",
        CF_AIG_ACCOUNT_ID="acct123",
        CF_AIG_GATEWAY_ID="gw456",
    )
    # Explicit beats the gateway pair; trailing slash is stripped.
    assert mod._secondary_base_url() == "https://my.proxy.example/v1"


def test_secondary_base_url_gateway_when_account_and_gateway(llm_env):
    mod = llm_env(CF_AIG_ACCOUNT_ID="acct123", CF_AIG_GATEWAY_ID="gw456")
    assert mod._secondary_base_url() == (
        "https://gateway.ai.cloudflare.com/v1/acct123/gw456/workers-ai/v1"
    )


def test_secondary_base_url_rest_fallback_account_only(llm_env):
    mod = llm_env(CF_AIG_ACCOUNT_ID="acct123")
    assert mod._secondary_base_url() == (
        "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1"
    )


def test_secondary_base_url_empty_when_unconfigured(llm_env):
    mod = llm_env()
    assert mod._secondary_base_url() == ""


# ─────────────────────────── validator-model defaults ─────────────────────────
def test_validator_models_default_pair(llm_env):
    mod = llm_env()  # VALIDATOR_MODELS and SECONDARY_MODEL both unset
    assert mod.VALIDATOR_MODELS == _DEFAULT_PAIR
    # SECONDARY_MODEL (legacy diagnostics field) is the first validator.
    assert mod.SECONDARY_MODEL == _DEFAULT_PAIR[0]


def test_legacy_secondary_model_yields_single_validator(llm_env):
    mod = llm_env(SECONDARY_MODEL="@cf/legacy/only-model")
    assert mod.VALIDATOR_MODELS == ["@cf/legacy/only-model"]
    assert mod.SECONDARY_MODEL == "@cf/legacy/only-model"


def test_validator_models_csv_dedup_order_preserved(llm_env):
    mod = llm_env(
        VALIDATOR_MODELS="@cf/a/one, @cf/b/two ,@cf/a/one,,@cf/c/three",
    )
    assert mod.VALIDATOR_MODELS == ["@cf/a/one", "@cf/b/two", "@cf/c/three"]
    assert mod.SECONDARY_MODEL == "@cf/a/one"


def test_validator_models_csv_beats_legacy_secondary_model(llm_env):
    mod = llm_env(
        VALIDATOR_MODELS="@cf/x/one,@cf/y/two",
        SECONDARY_MODEL="@cf/legacy/ignored",
    )
    assert mod.VALIDATOR_MODELS == ["@cf/x/one", "@cf/y/two"]


# ───────────────────────────── _secondary_headers ─────────────────────────────
def test_secondary_headers_require_cf_api_token(llm_env):
    mod = llm_env()
    with pytest.raises(RuntimeError):
        mod._secondary_headers()


def test_secondary_headers_without_gateway_token(llm_env):
    mod = llm_env(CF_API_TOKEN="cf-token")
    h = mod._secondary_headers()
    assert h["Authorization"] == "Bearer cf-token"
    assert "cf-aig-authorization" not in h


def test_secondary_headers_include_aig_authorization_when_token_set(llm_env):
    mod = llm_env(CF_API_TOKEN="cf-token", CF_AIG_TOKEN="aig-token")
    h = mod._secondary_headers()
    assert h["Authorization"] == "Bearer cf-token"
    assert h["cf-aig-authorization"] == "Bearer aig-token"
