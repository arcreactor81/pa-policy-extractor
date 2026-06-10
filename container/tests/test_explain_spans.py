"""
Golden tests for the source-span explainability guard in pipeline.explain.

extract_spans() asks the LLM for VERBATIM supporting quotes per deliverable field
but must NEVER trust the model blindly:
  * a quote that is NOT a substring of the policy text is DROPPED (no
    paraphrase/invention leaks through),
  * a garbled / non-JSON / raising LLM degrades to a fully-populated found=false
    map and NEVER raises,
  * found is downgraded to false when no verbatim quote survives the guard.

The LLM (llm.chat) is mocked in every test, so no network / heavy deps are used.
"""
from __future__ import annotations

import json

import pytest

POLICY = (
    "Patients must be 18 years or older. A documented negative TB test is "
    "required prior to initiation. Coverage requires trial of one topical agent."
)


@pytest.fixture
def explain(explain_mod):
    return explain_mod


def _spans_payload(mapping: dict) -> str:
    """Wrap a {col: {found, quotes}} mapping in the model's expected envelope."""
    return json.dumps({"spans": mapping})


# ───────────── verbatim guard: non-substring quotes are dropped ───────────────
def test_quote_not_in_policy_is_dropped(explain, monkeypatch):
    # Model returns a paraphrase that is NOT a substring of POLICY.
    payload = _spans_payload({
        "TB Test required": {
            "found": True,
            "quotes": ["the policy demands tuberculosis screening"],  # paraphrase
        }
    })
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)

    spans = explain.extract_spans(POLICY, {"TB Test required": "Yes"}, "TREMFYA")
    assert spans["TB Test required"]["quotes"] == []
    # No surviving verbatim quote -> found downgraded to false.
    assert spans["TB Test required"]["found"] is False


def test_verbatim_quote_in_policy_is_kept(explain, monkeypatch):
    quote = "A documented negative TB test is required prior to initiation."
    payload = _spans_payload({
        "TB Test required": {"found": True, "quotes": [quote]},
    })
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)

    spans = explain.extract_spans(POLICY, {"TB Test required": "Yes"}, "TREMFYA")
    assert quote in spans["TB Test required"]["quotes"]
    assert spans["TB Test required"]["found"] is True


def test_mixed_quotes_only_verbatim_survive(explain, monkeypatch):
    good = "Patients must be 18 years or older."
    bad = "patients should be adults"  # not a substring
    payload = _spans_payload({"Age": {"found": True, "quotes": [good, bad]}})
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)

    spans = explain.extract_spans(POLICY, {"Age": ">=18"}, "TREMFYA")
    assert spans["Age"]["quotes"] == [good]
    assert spans["Age"]["found"] is True


def test_whitespace_tolerant_match_is_kept(explain, monkeypatch):
    # Same text as the policy but with collapsed/var whitespace -> still verbatim.
    quote = "A   documented negative TB test   is required prior to initiation."
    payload = _spans_payload({"TB Test required": {"found": True, "quotes": [quote]}})
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)

    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    assert spans["TB Test required"]["quotes"] == [quote]
    assert spans["TB Test required"]["found"] is True


def test_found_true_but_empty_quotes_downgraded(explain, monkeypatch):
    payload = _spans_payload({"Age": {"found": True, "quotes": []}})
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)

    spans = explain.extract_spans(POLICY, {"Age": ">=18"}, "TREMFYA")
    assert spans["Age"]["found"] is False
    assert spans["Age"]["quotes"] == []


# ───────────── graceful degradation: never raises, always a full map ──────────
def test_garbled_non_json_returns_full_false_map(explain, monkeypatch):
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: "not json at all <<<>>>")
    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    assert set(spans.keys()) == set(explain.DELIVERABLE_COLUMNS)
    assert all(v == {"found": False, "quotes": []} for v in spans.values())


def test_llm_raising_returns_full_false_map(explain, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("DeepSeek exploded")

    monkeypatch.setattr(explain.llm, "chat", _boom)
    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    assert set(spans.keys()) == set(explain.DELIVERABLE_COLUMNS)
    assert all(v["found"] is False and v["quotes"] == [] for v in spans.values())


def test_extract_spans_never_raises_on_any_input(explain, monkeypatch):
    for bad in ["", "{", "{'broken': ", "null", "[]", "12345"]:
        monkeypatch.setattr(explain.llm, "chat", lambda *a, _b=bad, **k: _b)
        spans = explain.extract_spans(POLICY, {}, "TREMFYA")
        assert set(spans.keys()) == set(explain.DELIVERABLE_COLUMNS)


def test_empty_policy_short_circuits_to_false_map(explain, monkeypatch):
    # No policy text -> must not even call the LLM; returns the false map.
    called = {"n": 0}

    def _track(*a, **k):
        called["n"] += 1
        return "{}"

    monkeypatch.setattr(explain.llm, "chat", _track)
    spans = explain.extract_spans("   ", {}, "TREMFYA")
    assert called["n"] == 0
    assert all(v["found"] is False for v in spans.values())


def test_bare_mapping_without_spans_envelope_accepted(explain, monkeypatch):
    # Model returns a bare {col: {...}} mapping (no "spans" wrapper).
    quote = "Coverage requires trial of one topical agent."
    payload = json.dumps({
        "Step Therapy Requirements Documented in Policy": {
            "found": True, "quotes": [quote],
        }
    })
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)
    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    col = "Step Therapy Requirements Documented in Policy"
    assert spans[col]["quotes"] == [quote]
    assert spans[col]["found"] is True


def test_markdown_fenced_json_is_parsed(explain, monkeypatch):
    quote = "Patients must be 18 years or older."
    fenced = "```json\n" + json.dumps({"spans": {"Age": {"found": True, "quotes": [quote]}}}) + "\n```"
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: fenced)
    spans = explain.extract_spans(POLICY, {"Age": ">=18"}, "TREMFYA")
    assert spans["Age"]["quotes"] == [quote]


def test_duplicate_quotes_deduped(explain, monkeypatch):
    quote = "Patients must be 18 years or older."
    payload = _spans_payload({"Age": {"found": True, "quotes": [quote, quote]}})
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)
    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    assert spans["Age"]["quotes"] == [quote]


def test_non_string_quotes_ignored(explain, monkeypatch):
    payload = _spans_payload({"Age": {"found": True, "quotes": [123, None, {"x": 1}]}})
    monkeypatch.setattr(explain.llm, "chat", lambda *a, **k: payload)
    spans = explain.extract_spans(POLICY, {}, "TREMFYA")
    assert spans["Age"]["quotes"] == []
    assert spans["Age"]["found"] is False
