"""
Golden tests for validate_and_normalize — imported VERBATIM from
updated_pipeline.ipynb via pipeline.core's AST notebook loader.

These pin the contract of the business-rules normalizer so a future change to the
notebook (or the loader) that silently alters extraction fidelity fails CI.

Covered behaviors (per the rubric in SYSTEM_PROMPT + the function body):
  * Age: a population word ("adult"/"pediatric") with NO number -> "FDA labelled
    age" (never converted to >=18); explicit "FDA"-containing text -> "FDA
    labelled age"; a printed numeric threshold is preserved verbatim.
  * Step counts: "0" / 0 -> "No"; NA/none/"" -> "NA"; "2" -> "2".
  * NA-vs-No binary fields: absent -> "NA"; explicit "no" -> "No"; "yes" -> "Yes".
  * Durations: Unspecified-vs-NA gate — when PsO coverage exists a blank/unstated
    duration becomes "Unspecified", otherwise "NA". A printed number is kept.
  * Cross-field reauth: a non-NA reauth duration OR reauth requirements forces
    reauthorization_required -> "Yes" (and the reauth duration is then
    number-or-"Unspecified", never NA).
"""
from __future__ import annotations

import pytest


# ───────────────────────── Age: "adult" -> "FDA labelled age" ─────────────────
@pytest.mark.parametrize("age_in", ["adult", "Adults", "ADULT", "pediatric", "children"])
def test_population_word_without_number_becomes_fda_labelled_age(validate_and_normalize, age_in):
    out = validate_and_normalize({"age": age_in}, "TREMFYA")
    assert out["age"] == "FDA labelled age"


def test_fda_text_normalizes_to_fda_labelled_age(validate_and_normalize):
    out = validate_and_normalize({"age": "per FDA-approved age"}, "TREMFYA")
    assert out["age"] == "FDA labelled age"


def test_adult_is_never_converted_to_numeric(validate_and_normalize):
    out = validate_and_normalize({"age": "adult"}, "TREMFYA")
    assert out["age"] != ">=18"
    assert out["age"] == "FDA labelled age"


@pytest.mark.parametrize("age_in", [">=18", ">=6", "18 years of age"])
def test_numeric_age_is_preserved(validate_and_normalize, age_in):
    out = validate_and_normalize({"age": age_in}, "TREMFYA")
    # A population word with a number must NOT be rewritten to the FDA string.
    assert out["age"] == age_in


def test_age_absent_is_left_unset(validate_and_normalize):
    # Real verbatim behavior: the validator only WRITES params["age"] when the
    # model emitted an FDA-deferral or a bare population word. For a fully empty
    # params dict it reads age via params.get("age", "NA") locally but never
    # assigns it back, so the returned dict has NO "age" key at all. (The CSV
    # column mapping later defaults a missing key to "" via p.get("age", "").)
    out = validate_and_normalize({}, "TREMFYA")
    assert "age" not in out


# ───────────────────────── Step counts: "0" -> "No", NA vs No ─────────────────
@pytest.mark.parametrize("field", [
    "number_of_steps_through_brands",
    "number_of_steps_through_generic",
])
def test_step_string_zero_becomes_no(validate_and_normalize, field):
    out = validate_and_normalize({field: "0"}, "TREMFYA")
    assert out[field] == "No"


@pytest.mark.parametrize("field", [
    "number_of_steps_through_brands",
    "number_of_steps_through_generic",
])
def test_step_int_zero_becomes_no(validate_and_normalize, field):
    out = validate_and_normalize({field: 0}, "TREMFYA")
    assert out[field] == "No"


@pytest.mark.parametrize("field", [
    "number_of_steps_through_brands",
    "number_of_steps_through_generic",
])
@pytest.mark.parametrize("val", ["na", "n/a", "none", ""])
def test_step_absent_data_becomes_na_not_no(validate_and_normalize, field, val):
    # NA = data missing; must NOT collapse to "No" (which means "explicitly none").
    out = validate_and_normalize({field: val}, "TREMFYA")
    assert out[field] == "NA"


@pytest.mark.parametrize("raw,expected", [("2", "2"), (3, "3"), ("1 step", "1")])
def test_step_positive_count_extracted(validate_and_normalize, raw, expected):
    out = validate_and_normalize({"number_of_steps_through_brands": raw}, "TREMFYA")
    assert out["number_of_steps_through_brands"] == expected


def test_step_explicit_no_stays_no(validate_and_normalize):
    out = validate_and_normalize({"number_of_steps_through_brands": "No"}, "TREMFYA")
    assert out["number_of_steps_through_brands"] == "No"


# ───────────────────────── Binary fields: NA vs No vs Yes ─────────────────────
@pytest.mark.parametrize("field", ["tb_test_required", "reauthorization_required"])
def test_binary_absent_is_na(validate_and_normalize, field):
    out = validate_and_normalize({}, "TREMFYA")
    assert out[field] == "NA"


@pytest.mark.parametrize("field", ["tb_test_required", "reauthorization_required"])
@pytest.mark.parametrize("yes_val", ["yes", "Yes", "y", "true"])
def test_binary_yes_variants(validate_and_normalize, field, yes_val):
    out = validate_and_normalize({field: yes_val}, "TREMFYA")
    assert out[field] == "Yes"


def test_tb_explicit_no_is_no_not_na(validate_and_normalize):
    out = validate_and_normalize({"tb_test_required": "no"}, "TREMFYA")
    assert out["tb_test_required"] == "No"


@pytest.mark.parametrize("junk", ["maybe", "unknown", "sometimes"])
def test_binary_unrecognized_falls_back_to_na(validate_and_normalize, junk):
    out = validate_and_normalize({"tb_test_required": junk}, "TREMFYA")
    assert out["tb_test_required"] == "NA"


# ───────────────────── Phototherapy: step-type field (Yes/No/NA) ──────────────
@pytest.mark.parametrize("raw,expected", [
    ("yes", "Yes"), ("y", "Yes"),
    ("no", "No"), ("n", "No"),
    ("na", "NA"), ("", "NA"), ("whatever", "NA"),
])
def test_phototherapy_normalization(validate_and_normalize, raw, expected):
    out = validate_and_normalize({"step_through_phototherapy": raw}, "TREMFYA")
    assert out["step_through_phototherapy"] == expected


# ────────────────── Durations: Unspecified-vs-NA coverage gate ────────────────
def test_initial_duration_unspecified_when_coverage_exists(validate_and_normalize):
    # A substantive PsO signal (steps) establishes coverage -> blank duration
    # must become "Unspecified", never blank/NA.
    out = validate_and_normalize(
        {"number_of_steps_through_brands": "2", "initial_authorization_duration": ""},
        "TREMFYA",
    )
    assert out["initial_authorization_duration"] == "Unspecified"


def test_initial_duration_na_when_no_coverage(validate_and_normalize):
    # No substantive PsO signal -> a missing duration stays "NA" (true negative).
    out = validate_and_normalize({"initial_authorization_duration": ""}, "TREMFYA")
    assert out["initial_authorization_duration"] == "NA"


def test_duration_explicit_unspecified_preserved(validate_and_normalize):
    out = validate_and_normalize(
        {"initial_authorization_duration": "Unspecified"}, "TREMFYA"
    )
    assert out["initial_authorization_duration"] == "Unspecified"


@pytest.mark.parametrize("raw,expected", [("12", "12"), (6, "6"), ("12 months", "12")])
def test_duration_numeric_extracted(validate_and_normalize, raw, expected):
    out = validate_and_normalize(
        {"number_of_steps_through_brands": "1", "initial_authorization_duration": raw},
        "TREMFYA",
    )
    assert out["initial_authorization_duration"] == expected


def test_nonnumeric_duration_with_coverage_is_unspecified(validate_and_normalize):
    out = validate_and_normalize(
        {"number_of_steps_through_brands": "1", "initial_authorization_duration": "varies"},
        "TREMFYA",
    )
    assert out["initial_authorization_duration"] == "Unspecified"


# ───────────────── Cross-field reauthorization inference ──────────────────────
def test_reauth_duration_forces_required_yes(validate_and_normalize):
    out = validate_and_normalize({"reauthorization_duration": "12"}, "TREMFYA")
    assert out["reauthorization_required"] == "Yes"
    assert out["reauthorization_duration"] == "12"


def test_reauth_requirements_force_required_yes(validate_and_normalize):
    out = validate_and_normalize(
        {"reauthorization_requirements": "Positive clinical response"}, "TREMFYA"
    )
    assert out["reauthorization_required"] == "Yes"
    # required=Yes -> reauth duration must be number-or-"Unspecified", not NA.
    assert out["reauthorization_duration"] != "NA"
    assert out["reauthorization_duration"] == "Unspecified"


def test_reauth_required_yes_never_leaves_na_duration(validate_and_normalize):
    out = validate_and_normalize(
        {"reauthorization_required": "yes", "reauthorization_duration": ""}, "TREMFYA"
    )
    assert out["reauthorization_required"] == "Yes"
    assert out["reauthorization_duration"] == "Unspecified"


def test_no_reauth_signal_leaves_na(validate_and_normalize):
    # Nothing references reauth -> required is NA and duration is NA (no coverage).
    out = validate_and_normalize({}, "TREMFYA")
    assert out["reauthorization_required"] == "NA"
    assert out["reauthorization_duration"] == "NA"


def test_reauth_requirements_na_text_normalized(validate_and_normalize):
    out = validate_and_normalize({"reauthorization_requirements": "none"}, "TREMFYA")
    assert out["reauthorization_requirements"] == "NA"
    # "none" is an absent value -> does NOT force reauth required.
    assert out["reauthorization_required"] == "NA"


# ───────────────── Idempotency: re-running the validator is stable ────────────
def test_validate_is_idempotent(validate_and_normalize):
    first = validate_and_normalize(
        {
            "age": "adult",
            "number_of_steps_through_brands": "0",
            "number_of_steps_through_generic": "2",
            "tb_test_required": "yes",
            "reauthorization_duration": "12",
        },
        "TREMFYA",
    )
    second = validate_and_normalize(dict(first), "TREMFYA")
    for key in (
        "age",
        "number_of_steps_through_brands",
        "number_of_steps_through_generic",
        "tb_test_required",
        "reauthorization_required",
        "reauthorization_duration",
    ):
        assert second[key] == first[key]
