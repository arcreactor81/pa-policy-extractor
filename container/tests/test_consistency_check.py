"""
Golden tests for consistency_check + CSV_COLUMNS.

consistency_check here is the DEPLOYED function: the verbatim notebook function
(access_score.ipynb) wrapped by pipeline.overrides.apply_access_overrides inside
core._namespaces() — the same object production scoring calls. The wrapped
boundary invariants:
  * a COVERED drug (any non-NA value across the EXTENDED coverage fields — the
    notebook's _COVERAGE_FIELDS plus Age / Quantity Limits / Reauth*) cannot
    score 0 -> overridden up to 25 (minimum covered),
  * an UNCOVERED drug (all extended fields NA) with a positive score ABSTAINS:
    the score is PRESERVED and the reason flags the row for review (the old
    clamp-to-0 destroyed text-derived scores on extraction misses).
Scores with no boundary contradiction are returned unchanged with no reason.
"""
from __future__ import annotations

import pytest

from pipeline import overrides

# Display column that marks coverage when present (one of the substantive fields
# in the notebook's _COVERAGE_FIELDS list).
_COVERED_ROW = {"Number of Steps through Brands": "2"}
_UNCOVERED_ROW = {"Number of Steps through Brands": "NA"}


# ───────────── covered drug cannot score 0 (override 0 -> 25) ─────────────────
def test_covered_zero_is_overridden_up_to_25(consistency_check):
    score, reason = consistency_check(_COVERED_ROW, 0)
    assert score == 25
    assert reason  # a non-empty override reason is returned
    assert "covered" in reason.lower()


@pytest.mark.parametrize("score", [25, 50, 75, 100])
def test_covered_nonzero_scores_unchanged(consistency_check, score):
    out, reason = consistency_check(_COVERED_ROW, score)
    assert out == score
    assert reason is None


# ───────── uncovered drug + positive score ABSTAINS (score preserved) ─────────
@pytest.mark.parametrize("score", [25, 50, 75, 100])
def test_uncovered_positive_is_preserved_with_abstain(consistency_check, score):
    out, reason = consistency_check(_UNCOVERED_ROW, score)
    assert out == score  # NOT clamped to 0
    assert reason
    assert reason.startswith("abstain")
    assert reason == overrides.ABSTAIN_REASON


def test_uncovered_zero_unchanged(consistency_check):
    out, reason = consistency_check(_UNCOVERED_ROW, 0)
    assert out == 0
    assert reason is None


# ─────────────── coverage detection across the substantive fields ─────────────
@pytest.mark.parametrize("field", [
    "Number of Steps through Brands",
    "Number of Steps through Generic",
    "Step through-Phototherapy",
    "TB Test required",
    "Specialist Types",
    "Step Therapy Requirements Documented in Policy",
    "Initial Authorization Duration(in-months)",
])
def test_any_substantive_field_marks_coverage(consistency_check, field):
    row = {field: "Yes" if "Test" in field or "Phototherapy" in field else "12"}
    # With coverage established, a 0 must be lifted to 25.
    out, reason = consistency_check(row, 0)
    assert out == 25
    assert reason


# ──────────── EXTENDED coverage fields (override layer addition) ──────────────
@pytest.mark.parametrize("field,value", [
    ("Age", ">=18"),
    ("Quantity Limits", "2 per 28 days"),
    ("Reauthorization Duration(in-months)", "12"),
    ("Reauthorization Required", "Yes"),
    ("Reauthorization Requirements Documented in Policy", "Positive response"),
])
def test_extended_fields_count_as_coverage(consistency_check, field, value):
    # An Age-only / Reauth-only / QL-only row is COVERED under the extended
    # fields: a 0 lifts to 25 and a positive score passes with no abstain.
    row = {field: value}
    out, reason = consistency_check(row, 0)
    assert out == 25
    assert reason and "covered" in reason.lower()

    out, reason = consistency_check(row, 50)
    assert out == 50
    assert reason is None


@pytest.mark.parametrize("na_val", ["NA", "N/A", "none", "", "None"])
def test_na_variants_do_not_count_as_coverage(consistency_check, na_val):
    row = {"Number of Steps through Brands": na_val}
    out, reason = consistency_check(row, 50)
    assert out == 50  # treated as uncovered -> positive score preserved + abstain
    assert reason.startswith("abstain")


def test_empty_row_abstains_on_positive_score(consistency_check):
    out, reason = consistency_check({}, 75)
    assert out == 75
    assert reason.startswith("abstain")


# ─────────────────────────── CSV_COLUMNS contract ────────────────────────────
def test_csv_columns_header_order(csv_columns):
    headers = [name for name, _fn in csv_columns]
    assert headers[:2] == ["Filename", "Brand"]
    assert headers[-1] == "Access Score"
    # 13 deliverable params + Filename/Brand/Access Score = 15 columns.
    assert len(headers) == 15


def test_csv_columns_map_filename_and_brand(csv_columns):
    by_name = {name: fn for name, fn in csv_columns}
    row = {"filename": "policy.pdf", "brand": "TREMFYA"}
    assert by_name["Filename"](row, {}) == "policy.pdf"
    assert by_name["Brand"](row, {}) == "TREMFYA"


def test_csv_columns_pull_from_params(csv_columns):
    by_name = {name: fn for name, fn in csv_columns}
    params = {
        "age": ">=18",
        "number_of_steps_through_brands": "2",
        "access_score": 50,
    }
    row = {"filename": "p.pdf", "brand": "TREMFYA"}
    assert by_name["Age"](row, params) == ">=18"
    assert by_name["Number of Steps through Brands"](row, params) == "2"
    assert by_name["Access Score"](row, params) == 50


def test_csv_columns_missing_param_is_empty_string(csv_columns):
    by_name = {name: fn for name, fn in csv_columns}
    assert by_name["Age"]({"filename": "p", "brand": "B"}, {}) == ""
