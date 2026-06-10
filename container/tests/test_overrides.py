"""
Tests for the accuracy override layer (pipeline.overrides) + the core helpers it
ships with (row coercion, policy-text truncation).

The override layer patches the loaded notebook namespaces IN PLACE inside
core._namespaces() (the notebook functions' __globals__ IS the namespace dict),
so the `reducer_ns` fixture already exposes the deployed behaviour:
  * PSO_PATTERNS' dead case-sensitive \\bPsO\\b entry re-compiled IGNORECASE,
  * reduce_document wrapped with the REDUCER_PASSTHROUGH_CHARS threshold and
    the relevance guard (brand + PsO keyword + criteria token, else full md).

The guard tests build their own wrapper via _make_reduce_document_override with
a stub `original` and a fake doc — synthetic strings only, no docling needed.
"""
from __future__ import annotations

import importlib
import os
import re

import pytest

from pipeline import core, overrides


# ─────────────────────── fix 1: PsO regex patch ───────────────────────────────
def test_patched_pso_patterns_match_lowercased_pso(reducer_ns):
    # Reducer strategies B/C search .lower()ed text, where the notebook's
    # case-sensitive \bPsO\b can never match. The patched list must hit 'pso'.
    lowered = "coverage criteria for moderate to severe pso are listed below"
    assert any(p.search(lowered) for p in reducer_ns["PSO_PATTERNS"])


def test_no_case_sensitive_pso_pattern_survives(reducer_ns):
    for pat in reducer_ns["PSO_PATTERNS"]:
        if pat.pattern.lower() == r"\bpso\b":
            assert pat.flags & re.IGNORECASE


def test_patched_patterns_still_match_original_casings(reducer_ns):
    # The fix must not lose the matches the list already had.
    for text in ("Plaque Psoriasis criteria", "PsO indication", "psoriasis"):
        assert any(p.search(text) for p in reducer_ns["PSO_PATTERNS"])


# ─────────────── fix 2: reduce_document wrapper (relevance guard) ─────────────
class _FakeDoc:
    """Stand-in for a DoclingDocument: only export_to_markdown is consumed."""

    def __init__(self, md: str):
        self._md = md

    def export_to_markdown(self) -> str:
        return self._md


def _make_wrapper(reducer_ns, original):
    """Build the wrapper exactly as apply_reducer_overrides does, but around a
    stub `original` so the guard logic runs on synthetic strings."""
    return overrides._make_reduce_document_override(
        original, reducer_ns["BRAND_ALIASES"], reducer_ns["alias_in_text"],
        reducer_ns["PSO_PATTERNS"])


# A "large" document body: padding pushes it over REDUCER_PASSTHROUGH_CHARS so
# the wrapper actually invokes the (stub) original instead of passing through.
_BIG_PAD = "lorem ipsum filler text. " * 5000  # ~125k chars


def test_relevance_guard_rejects_wrong_brand_reduction(reducer_ns):
    # A reduced output that only discusses COSENTYX cannot support a STELARA
    # query: the guard must fall back to the full markdown (passthrough-like).
    full_md = "STELARA (ustekinumab) plaque psoriasis criteria... " + _BIG_PAD
    reduced = ("cosentyx (secukinumab) step therapy required for moderate to "
               "severe plaque psoriasis; approval criteria apply")
    wrapper = _make_wrapper(reducer_ns, lambda doc, brand: reduced)

    out = wrapper(_FakeDoc(full_md), "STELARA")
    assert out == full_md
    assert overrides.consume_relevance_fallback() is True
    assert overrides.consume_relevance_fallback() is False  # consume-once


def test_relevance_guard_passes_correct_reduction(reducer_ns):
    # Brand alias + PsO keyword + criteria token all present -> reduced output
    # is trusted and returned unchanged (no fallback flag).
    full_md = "header " + _BIG_PAD
    reduced = ("stelara (ustekinumab) for plaque psoriasis: step therapy "
               "required through two generics before approval")
    wrapper = _make_wrapper(reducer_ns, lambda doc, brand: reduced)

    out = wrapper(_FakeDoc(full_md), "STELARA")
    assert out == reduced
    assert overrides.consume_relevance_fallback() is False


def test_relevance_guard_requires_criteria_language(reducer_ns):
    # Brand + PsO present but NO criteria token -> fallback.
    full_md = "header " + _BIG_PAD
    reduced = "stelara is indicated for plaque psoriasis in adults"
    wrapper = _make_wrapper(reducer_ns, lambda doc, brand: reduced)

    out = wrapper(_FakeDoc(full_md), "STELARA")
    assert out == full_md
    assert overrides.consume_relevance_fallback() is True


def test_guard_skips_non_reduced_output(reducer_ns):
    # When the original itself fell back to the full markdown (same length),
    # there is nothing to guard — the result passes through un-flagged.
    full_md = "no brand or pso here " + _BIG_PAD
    wrapper = _make_wrapper(reducer_ns, lambda doc, brand: full_md)

    out = wrapper(_FakeDoc(full_md), "STELARA")
    assert out == full_md
    assert overrides.consume_relevance_fallback() is False


def test_passthrough_below_threshold_never_calls_original(reducer_ns, monkeypatch):
    calls = []

    def original(doc, brand):
        calls.append(brand)
        return "reduced"

    wrapper = _make_wrapper(reducer_ns, original)
    monkeypatch.setattr(overrides, "REDUCER_PASSTHROUGH_CHARS", 50)

    small = "tiny document"
    assert wrapper(_FakeDoc(small), "STELARA") == small
    assert calls == []  # passthrough: the verbatim reducer never ran

    # At/over the threshold the original runs (its result is then guarded).
    big = "x" * 60
    wrapper(_FakeDoc(big), "STELARA")
    assert calls == ["STELARA"]


def test_reducer_passthrough_chars_env_respected(monkeypatch):
    # The constant is parsed from the env at import time; reload to prove the
    # env var drives it, then restore the default for the rest of the session.
    monkeypatch.setenv("REDUCER_PASSTHROUGH_CHARS", "5000")
    try:
        importlib.reload(overrides)
        assert overrides.REDUCER_PASSTHROUGH_CHARS == 5000
    finally:
        monkeypatch.delenv("REDUCER_PASSTHROUGH_CHARS", raising=False)
        importlib.reload(overrides)
    assert overrides.REDUCER_PASSTHROUGH_CHARS == 100_000


# ───────────────────── row coercion helper (core._coerce_cell) ────────────────
def test_coerce_cell_int_and_list_to_strings():
    assert core._coerce_cell(5) == "5"
    assert core._coerce_cell(["Dermatologist", "Rheumatologist"]) == \
        "Dermatologist; Rheumatologist"


def test_coerce_cell_none_and_whitespace():
    assert core._coerce_cell(None) == ""
    assert core._coerce_cell("  >=18  ") == ">=18"
    assert core._coerce_cell("") == ""


def test_run_row_shape_after_coercion(csv_columns):
    # A model JSON with an int age + list of specialists must land in run_row
    # as strings (the CSV-round-trip shape format_row_for_model relies on:
    # (row.get(col) or 'NA').strip() crashes on int/list).
    params = {"age": 18, "specialist_types": ["Dermatologist", "Rheumatologist"]}
    run_row = {col: core._coerce_cell(fn({"filename": "p.pdf", "brand": "STELARA"}, params))
               for col, fn in csv_columns}
    assert all(isinstance(v, str) for v in run_row.values())
    assert run_row["Age"] == "18"
    assert run_row["Specialist Types"] == "Dermatologist; Rheumatologist"
    # The verbatim scoring formatter must accept the coerced row.
    assert (run_row.get("Age") or "NA").strip() == "18"


# ───────── end-to-end: analyze_brand with coercion + voting + overrides ──────
def _fake_llm_chat(score_sequence):
    """A fake llm.chat: extraction calls return a params JSON whose age is an
    INT and specialists a LIST (the exact shapes that crashed scoring before the
    coercion fix); scoring calls walk `score_sequence` one bucket per run."""
    import json
    state = {"i": 0}

    def chat(system, user, temperature=0.1, json_output=True, metadata=None, **k):
        feature = (metadata or {}).get("feature")
        if feature == "extract":
            return json.dumps({
                "age": 18,
                "specialist_types": ["Dermatologist", "Rheumatologist"],
                "tb_test_required": "Yes",
            })
        assert feature == "score", f"unexpected llm feature {feature!r}"
        i = state["i"]
        state["i"] += 1
        return json.dumps({"access_score": score_sequence[i],
                           "justification": f"run-{i + 1} justification"})

    return chat


def test_analyze_brand_coerces_row_and_votes_scores(monkeypatch):
    # Small fake doc -> the wrapped reduce_document passes the raw markdown
    # through (below REDUCER_PASSTHROUGH_CHARS), so no docling internals run.
    md = ("stelara (ustekinumab) is covered for plaque psoriasis when step "
          "therapy criteria are met and a negative tb test is required")
    monkeypatch.setattr(core.llm, "chat", _fake_llm_chat([25, 75, 25]))

    out = core.analyze_brand(_FakeDoc(md), md, "STELARA", filename="p.pdf",
                             runs=3, explain_spans=False, consensus=False)

    result = out["result"]
    # The int age / list specialists landed as deliverable STRINGS (and the
    # verbatim format_row_for_model didn't crash on them along the way).
    assert result["Age"] == "18"
    assert result["Specialist Types"] == "Dermatologist; Rheumatologist"
    # Majority-bucket vote across [25, 75, 25] -> 25 (covered row, no override).
    assert result["Access Score"] == 25
    # Per-run scores are persisted in the justification for auditability.
    assert "[Per-run scores: [25, 75, 25]; voted: 25]" in out["access_justification"]
    assert out["meta"]["source"] == "reduced"


def test_analyze_brand_tags_relevance_fallback_source(monkeypatch):
    # When the (wrapped) reducer signals a relevance fallback, core must tag the
    # stage source so the fallback is observable in events/meta.
    md = "stelara plaque psoriasis step therapy criteria tb test required"
    monkeypatch.setattr(core.llm, "chat", _fake_llm_chat([50]))

    def fallback_reduce(doc, brand):
        overrides._fallback_state.fired = True
        return doc.export_to_markdown()

    monkeypatch.setitem(core._namespaces()["reducer"], "reduce_document",
                        fallback_reduce)
    out = core.analyze_brand(_FakeDoc(md), md, "STELARA", filename="p.pdf",
                             runs=1, explain_spans=False, consensus=False)
    assert out["meta"]["source"] == "relevance-fallback"
    assert out["result"]["Access Score"] == 50


# ─────────────── SCORING_MAX_CHARS truncation (core helper) ───────────────────
def test_truncate_policy_text_caps_at_limit(monkeypatch):
    monkeypatch.setattr(core, "SCORING_MAX_CHARS", 100)
    out = core._truncate_policy_text("x" * 250, "p.pdf", "STELARA")
    assert len(out) == 100


def test_truncate_policy_text_noop_under_limit(monkeypatch):
    monkeypatch.setattr(core, "SCORING_MAX_CHARS", 100)
    text = "x" * 99
    assert core._truncate_policy_text(text, "p.pdf", "STELARA") is text


def test_scoring_max_chars_default_matches_notebook():
    # Default mirrors access_score.ipynb's MAX_CHARS = 300_000 (env-overridable).
    assert core.SCORING_MAX_CHARS == int(os.environ.get("SCORING_MAX_CHARS", "300000"))
