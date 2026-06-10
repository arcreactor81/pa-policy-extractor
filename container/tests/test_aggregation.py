"""
Golden tests for the N-run confidence/variance aggregation in pipeline.core:
  * _majority(values)        — modal value with a deterministic EARLIEST-run
                               tie-break.
  * _aggregate_confidence(rows) — per-column majority value + agreement in [0,1]
                               + distinct values in first-seen order.

These are the NEW aggregation logic (not verbatim notebook code) but they gate
the multi-run confidence feature, so their determinism is contract-critical.
"""
from __future__ import annotations

import pytest


# ─────────────────────────────── _majority ───────────────────────────────────
def test_majority_true_winner(core_mod):
    assert core_mod._majority(["a", "a", "b"]) == "a"


def test_majority_empty_is_empty_string(core_mod):
    assert core_mod._majority([]) == ""


def test_majority_single_value(core_mod):
    assert core_mod._majority(["only"]) == "only"


def test_majority_unanimous(core_mod):
    assert core_mod._majority(["x", "x", "x", "x"]) == "x"


def test_majority_tie_breaks_to_earliest_run(core_mod):
    # a and b both appear twice; b's first occurrence (index 0) precedes a's
    # (index 1), so the earliest-first-occurrence value b wins.
    assert core_mod._majority(["b", "a", "a", "b"]) == "b"


def test_majority_two_way_tie_first_wins(core_mod):
    assert core_mod._majority(["a", "b"]) == "a"
    assert core_mod._majority(["b", "a"]) == "b"


def test_majority_three_way_tie_first_wins(core_mod):
    assert core_mod._majority(["z", "y", "x"]) == "z"


def test_majority_is_deterministic_across_calls(core_mod):
    seq = ["m", "n", "n", "m", "o"]
    results = {core_mod._majority(seq) for _ in range(50)}
    assert len(results) == 1  # same answer every time


# ─────────────────────── _aggregate_confidence ───────────────────────────────
def _row(**overrides):
    """A full 13-column row defaulting every column to 'X' (overridable)."""
    # Built from the production column list so it always matches the contract.
    import pipeline.core as core
    base = {col: "X" for col in core.CONFIDENCE_COLUMNS}
    base.update(overrides)
    return base


def test_aggregate_unanimous_agreement_is_one(core_mod):
    rows = [_row() for _ in range(3)]
    final_row, confidence = core_mod._aggregate_confidence(rows)
    for col in core_mod.CONFIDENCE_COLUMNS:
        assert confidence[col]["agreement"] == 1.0
        assert confidence[col]["value"] == "X"
        assert confidence[col]["distinct"] == ["X"]
        assert final_row[col] == "X"


def test_aggregate_agreement_in_unit_interval(core_mod):
    # Age varies: A, B, A across 3 runs -> majority A, agreement 2/3.
    rows = [_row(Age="A"), _row(Age="B"), _row(Age="A")]
    final_row, confidence = core_mod._aggregate_confidence(rows)
    age = confidence["Age"]
    assert 0.0 <= age["agreement"] <= 1.0
    assert age["agreement"] == pytest.approx(2 / 3, abs=1e-4)
    assert age["value"] == "A"
    assert final_row["Age"] == "A"


def test_aggregate_distinct_in_first_seen_order(core_mod):
    # Distinct must preserve first-seen order: B then A then C.
    rows = [_row(Age="B"), _row(Age="A"), _row(Age="C"), _row(Age="A")]
    _final, confidence = core_mod._aggregate_confidence(rows)
    assert confidence["Age"]["distinct"] == ["B", "A", "C"]


def test_aggregate_majority_uses_earliest_run_tiebreak(core_mod):
    # Age: B, A, A, B -> tie (2 each); earliest first-occurrence (B at idx 0) wins.
    rows = [_row(Age="B"), _row(Age="A"), _row(Age="A"), _row(Age="B")]
    final_row, confidence = core_mod._aggregate_confidence(rows)
    assert confidence["Age"]["value"] == "B"
    assert final_row["Age"] == "B"
    assert confidence["Age"]["agreement"] == pytest.approx(0.5, abs=1e-4)


def test_aggregate_agreement_rounded_to_4dp(core_mod):
    # 1 of 3 -> 0.3333 (round(1/3, 4)).
    rows = [_row(Age="A"), _row(Age="B"), _row(Age="C")]
    _final, confidence = core_mod._aggregate_confidence(rows)
    # majority is the earliest among the three-way tie = A, agreement 1/3.
    assert confidence["Age"]["agreement"] == 0.3333


def test_aggregate_covers_all_confidence_columns(core_mod):
    rows = [_row() for _ in range(2)]
    _final, confidence = core_mod._aggregate_confidence(rows)
    assert set(confidence.keys()) == set(core_mod.CONFIDENCE_COLUMNS)
    # 12 extraction columns + Access Score.
    assert "Access Score" in confidence
    assert len(core_mod.CONFIDENCE_COLUMNS) == 13


def test_aggregate_confidence_shape(core_mod):
    rows = [_row() for _ in range(2)]
    _final, confidence = core_mod._aggregate_confidence(rows)
    entry = confidence["Age"]
    assert set(entry.keys()) == {"value", "agreement", "distinct"}
    assert isinstance(entry["distinct"], list)
    assert isinstance(entry["agreement"], float)


def test_clamp_runs_bounds(core_mod):
    assert core_mod._clamp_runs(0) == 1
    assert core_mod._clamp_runs(1) == 1
    assert core_mod._clamp_runs(5) == 5
    assert core_mod._clamp_runs(99) == 5
    # Non-numeric falls back to the env default, itself clamped into [1, 5].
    assert 1 <= core_mod._clamp_runs("not-a-number") <= 5
    assert 1 <= core_mod._clamp_runs(None) <= 5
