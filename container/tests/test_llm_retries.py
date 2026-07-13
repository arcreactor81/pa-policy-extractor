"""Hermetic retry-classification and physical-attempt observability tests."""
from __future__ import annotations

import logging

import pytest

from pipeline import explain, llm


_DEFAULT_PAYLOAD = object()


class _Response:
    def __init__(self, status: int = 200, payload=_DEFAULT_PAYLOAD):
        self.status_code = status
        self._payload = payload

    def json(self):
        if isinstance(self._payload, BaseException):
            raise self._payload
        if self._payload is _DEFAULT_PAYLOAD:
            return {
                "choices": [
                    {"finish_reason": "stop",
                     "message": {"content": '{"ok": true}'}}
                ]
            }
        return self._payload


def _install_sequence(monkeypatch, sequence):
    items = list(sequence)
    calls = []

    def _post(url, headers=None, json=None, timeout=None):
        item = items[len(calls)]
        calls.append({
            "url": url,
            "headers": headers,
            "json": json,
            "timeout": timeout,
        })
        if isinstance(item, BaseException):
            raise item
        return item

    monkeypatch.setattr(llm.requests, "post", _post)
    return calls


def _call(*, max_retries: int = 3, operation: str = "unit_test",
          outer_attempt: int = 2):
    return llm._chat(
        "https://unit.test/base", {"Authorization": "Bearer test-secret"},
        "test-model",
        system_instruction="system-secret", user_prompt="prompt-secret",
        temperature=0.1, json_output=True, max_retries=max_retries,
        timeout=5.0, thinking=False, provider="test",
        operation=operation, outer_attempt=outer_attempt,
    )


def _capture_sleeps(monkeypatch):
    sleeps = []
    monkeypatch.setattr(llm.time, "sleep", sleeps.append)
    return sleeps


def _minimal_score_row():
    return {
        "Brand": "TREMFYA",
        "Age": "NA",
        "Step Therapy Requirements Documented in Policy": "NA",
        "Number of Steps through Brands": "NA",
        "Number of Steps through Generic": "NA",
        "Step through-Phototherapy": "NA",
        "TB Test required": "NA",
        "Quantity Limits": "NA",
        "Specialist Types": "NA",
        "Initial Authorization Duration(in-months)": "NA",
        "Reauthorization Duration(in-months)": "NA",
        "Reauthorization Required": "NA",
        "Reauthorization Requirements Documented in Policy": "NA",
    }


def test_error_hierarchy_remains_runtime_error_compatible():
    assert issubclass(llm.LLMError, RuntimeError)
    assert issubclass(llm.PermanentLLMError, llm.LLMError)
    assert issubclass(llm.TransientLLMError, llm.LLMError)
    assert issubclass(llm.InvalidLLMResponseError, llm.LLMError)


def test_success_logs_one_sanitized_physical_attempt(monkeypatch, caplog):
    calls = _install_sequence(monkeypatch, [_Response()])
    sleeps = _capture_sleeps(monkeypatch)
    caplog.set_level(logging.INFO, logger="pa-extractor.llm")

    assert _call(operation="extract", outer_attempt=3) == '{"ok": true}'

    attempt_logs = [
        record.getMessage() for record in caplog.records
        if record.getMessage().startswith("llm_attempt ")
    ]
    assert len(calls) == 1
    assert sleeps == []
    assert len(attempt_logs) == 1
    assert "operation=extract" in attempt_logs[0]
    assert "outer_attempt=3" in attempt_logs[0]
    assert "http_attempt=1" in attempt_logs[0]
    assert "outcome=success" in attempt_logs[0]
    assert "status=200" in attempt_logs[0]
    assert "test-secret" not in attempt_logs[0]
    assert "system-secret" not in attempt_logs[0]
    assert "prompt-secret" not in attempt_logs[0]


@pytest.mark.parametrize(
    ("status", "outcome"),
    [(408, "http_408"), (429, "http_429"), (503, "http_5xx")],
)
def test_retryable_http_statuses_exhaust_inner_budget(
        monkeypatch, caplog, status, outcome):
    calls = _install_sequence(monkeypatch, [_Response(status)] * 3)
    sleeps = _capture_sleeps(monkeypatch)
    caplog.set_level(logging.INFO, logger="pa-extractor.llm")

    with pytest.raises(RuntimeError) as caught:
        _call()

    assert type(caught.value) is RuntimeError
    assert str(caught.value) == (
        f"test call failed after 3 attempts: test returned HTTP {status}"
    )
    assert len(calls) == 3
    assert sleeps == [2, 4]
    assert isinstance(caught.value.__cause__, llm.TransientLLMError)
    attempt_logs = [
        record.getMessage() for record in caplog.records
        if record.getMessage().startswith("llm_attempt ")
    ]
    assert len(attempt_logs) == 3
    assert all(f"outcome={outcome}" in message for message in attempt_logs)


@pytest.mark.parametrize("status", [400, 401, 404])
def test_other_http_4xx_is_permanent(monkeypatch, status):
    calls = _install_sequence(monkeypatch, [_Response(status)])
    sleeps = _capture_sleeps(monkeypatch)

    with pytest.raises(llm.PermanentLLMError) as caught:
        _call()

    assert len(calls) == 1
    assert sleeps == []
    assert str(status) in str(caught.value)


@pytest.mark.parametrize("finish", ["content_filter", "safety"])
def test_blocked_finish_reason_is_permanent(monkeypatch, finish):
    response = _Response(payload={
        "choices": [{"finish_reason": finish, "message": {"content": "ignored"}}]
    })
    calls = _install_sequence(monkeypatch, [response])
    sleeps = _capture_sleeps(monkeypatch)

    with pytest.raises(llm.PermanentLLMError):
        _call()

    assert len(calls) == 1
    assert sleeps == []


def test_length_finish_reason_retries_then_succeeds(monkeypatch, caplog):
    truncated = _Response(payload={
        "choices": [{"finish_reason": "length", "message": {"content": "partial"}}]
    })
    calls = _install_sequence(monkeypatch, [truncated, _Response()])
    sleeps = _capture_sleeps(monkeypatch)
    caplog.set_level(logging.INFO, logger="pa-extractor.llm")

    assert _call() == '{"ok": true}'

    assert len(calls) == 2
    assert sleeps == [2]
    outcomes = [
        record.getMessage() for record in caplog.records
        if record.getMessage().startswith("llm_attempt ")
    ]
    assert "outcome=length" in outcomes[0]
    assert "outcome=success" in outcomes[1]


@pytest.mark.parametrize(
    "payload",
    [
        ValueError("invalid JSON"),
        [],
        {"choices": []},
        {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]},
    ],
)
def test_malformed_success_is_not_inner_retried(monkeypatch, payload):
    calls = _install_sequence(monkeypatch, [_Response(payload=payload)])
    sleeps = _capture_sleeps(monkeypatch)

    with pytest.raises(llm.InvalidLLMResponseError):
        _call()

    assert len(calls) == 1
    assert sleeps == []


@pytest.mark.parametrize(
    ("error_type", "outcome"),
    [
        (llm.requests.exceptions.Timeout, "timeout"),
        (llm.requests.exceptions.ConnectionError, "connection_error"),
        (llm.requests.exceptions.ChunkedEncodingError, "chunked_encoding_error"),
        (llm.requests.exceptions.ContentDecodingError, "content_decoding_error"),
    ],
)
def test_four_class_transport_whitelist_is_retried(
        monkeypatch, caplog, error_type, outcome):
    calls = _install_sequence(
        monkeypatch, [error_type("transport failed") for _ in range(3)]
    )
    sleeps = _capture_sleeps(monkeypatch)
    caplog.set_level(logging.INFO, logger="pa-extractor.llm")

    with pytest.raises(RuntimeError) as caught:
        _call()

    assert type(caught.value) is RuntimeError
    assert str(caught.value) == (
        "test call failed after 3 attempts: transport failed"
    )
    assert isinstance(caught.value.__cause__, error_type)
    assert len(calls) == 3
    assert sleeps == [2, 4]
    attempt_logs = [
        record.getMessage() for record in caplog.records
        if record.getMessage().startswith("llm_attempt ")
    ]
    assert len(attempt_logs) == 3
    assert all(f"outcome={outcome}" in message for message in attempt_logs)


def test_unclassified_exception_escapes_without_inner_retry(monkeypatch, caplog):
    calls = _install_sequence(monkeypatch, [RuntimeError("unexpected")])
    sleeps = _capture_sleeps(monkeypatch)
    caplog.set_level(logging.INFO, logger="pa-extractor.llm")

    with pytest.raises(RuntimeError) as caught:
        _call()

    assert type(caught.value) is RuntimeError
    assert len(calls) == 1
    assert sleeps == []
    assert any(
        "outcome=unexpected_error" in record.getMessage()
        for record in caplog.records
    )


def test_missing_primary_config_is_permanent_with_stable_message(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    with pytest.raises(llm.PermanentLLMError) as caught:
        llm._headers()

    assert str(caught.value) == "DEEPSEEK_API_KEY is not set."


def test_missing_secondary_config_is_permanent_with_stable_messages(monkeypatch):
    for key in ("CF_API_TOKEN", "SECONDARY_BASE_URL", "CF_AIG_ACCOUNT_ID",
                "CF_AIG_GATEWAY_ID"):
        monkeypatch.delenv(key, raising=False)

    with pytest.raises(llm.PermanentLLMError) as caught:
        llm._secondary_headers()
    assert str(caught.value) == "CF_API_TOKEN is not set (secondary provider disabled)."

    with pytest.raises(llm.PermanentLLMError) as caught:
        llm.chat_secondary("system", "prompt")
    assert str(caught.value) == "secondary base URL is not configured."


def test_explain_malformed_success_degrades_after_one_http_attempt(monkeypatch):
    malformed = _Response(payload={"choices": []})
    calls = _install_sequence(monkeypatch, [malformed, malformed, malformed])
    sleeps = _capture_sleeps(monkeypatch)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    spans = explain.extract_spans(
        "The policy contains no relevant source quote.",
        {},
        "TREMFYA",
    )

    assert spans == explain._empty_spans()
    assert len(calls) == 1
    assert sleeps == []


def test_outer_attempt_context_is_threaded_from_core(core_mod, monkeypatch):
    seen = []

    def _chat(*args, operation=None, outer_attempt=None, **kwargs):
        seen.append((operation, outer_attempt))
        if outer_attempt < 3:
            raise llm.TransientLLMError("logical call failed")
        return "{}"

    monkeypatch.setattr(core_mod.llm, "chat", _chat)

    assert isinstance(core_mod._extract_params("policy", "TREMFYA"), dict)
    assert seen == [("extract", 1), ("extract", 2), ("extract", 3)]


def test_permanent_failure_short_circuits_into_sanitized_paths(
        core_mod, monkeypatch):
    primary_calls = []
    secondary_calls = []
    permanent = llm.PermanentLLMError("permanent")

    def _primary(*args, **kwargs):
        primary_calls.append(kwargs)
        raise permanent

    def _secondary(*args, **kwargs):
        secondary_calls.append(kwargs)
        raise permanent

    monkeypatch.setattr(core_mod.llm, "chat", _primary)
    monkeypatch.setattr(core_mod.llm, "chat_secondary", _secondary)

    with pytest.raises(RuntimeError, match=r"^extraction failed$") as caught:
        core_mod._extract_params("policy", "TREMFYA")
    assert type(caught.value) is RuntimeError
    assert len(primary_calls) == 1

    with pytest.raises(
        RuntimeError, match=r"^validator extraction failed$"
    ) as caught:
        core_mod._extract_params_secondary(
            "policy", "TREMFYA", model="@cf/test"
        )
    assert type(caught.value) is RuntimeError
    assert len(secondary_calls) == 1


def test_permanent_scoring_failure_logs_detail_and_uses_sanitized_boundary_fallback(
        core_mod, monkeypatch, caplog):
    calls = []

    def _chat(*args, **kwargs):
        calls.append(kwargs)
        raise llm.PermanentLLMError("permanent")

    monkeypatch.setattr(core_mod.llm, "chat", _chat)
    caplog.set_level(logging.ERROR, logger="pa-extractor.core")

    score, justification = core_mod._access_score(
        _minimal_score_row(), "policy", brand="TREMFYA"
    )

    assert score == 0
    assert justification == "(model scoring failed; boundary default applied)"
    assert "permanent" not in justification
    assert any(
        "access scoring failed for brand TREMFYA: permanent"
        in record.getMessage()
        for record in caplog.records
    )
    assert len(calls) == 1


def test_core_labels_validator_and_score_operations(core_mod, monkeypatch):
    seen = []

    def _secondary(*args, operation=None, outer_attempt=None, **kwargs):
        seen.append((operation, outer_attempt))
        return "{}"

    def _primary(*args, operation=None, outer_attempt=None, **kwargs):
        seen.append((operation, outer_attempt))
        return '{"access_score": 50, "justification": "ok"}'

    monkeypatch.setattr(core_mod.llm, "chat_secondary", _secondary)
    monkeypatch.setattr(core_mod.llm, "chat", _primary)

    assert isinstance(
        core_mod._extract_params_secondary("policy", "TREMFYA", model="@cf/test"),
        dict,
    )
    score, _ = core_mod._access_score(
        _minimal_score_row(), "policy", brand="TREMFYA"
    )
    assert score == 50
    assert seen == [("validator_extract", 1), ("score", 1)]
