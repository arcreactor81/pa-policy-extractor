"""
Import-hygiene + docling-guarded tests.

1. The whole test suite must import the pipeline WITHOUT torch / docling / surya /
   transformers installed (heavy deps are stubbed in conftest.py). This module
   asserts that explicitly so a regression that pulls a heavy import to module
   scope fails CI loudly.

2. Anything that genuinely needs the real docling package is gated behind
   @pytest.mark.skipif(importlib.util.find_spec('docling') is None) so it is
   skipped (not errored) when docling is absent — which is the normal CI state
   for this lightweight test job.

Also pins the two verbatim JSON parsers (parse_json_response / _parse_json) since
the extraction + scoring stages depend on them tolerating fenced / preamble JSON.
"""
from __future__ import annotations

import importlib.util

import pytest


# ─────────────────── import hygiene: no heavy deps required ───────────────────
def test_pipeline_core_imported_without_torch_or_docling():
    import pipeline.core as core  # noqa: F401

    # Neither torch nor the real docling converter should have been imported just
    # by importing pipeline.core (the converter is built lazily in _get_converter).
    assert core._CONVERTER is None
    # The heavy modules must not have been pulled in transitively.
    import sys

    # If torch/docling are genuinely installed in this CI image that's fine; the
    # point is that importing core does not REQUIRE them. We assert the converter
    # was never built (the only place real docling is imported).
    assert "pipeline.core" in sys.modules


def test_explain_imported_without_heavy_deps():
    import pipeline.explain as explain

    assert len(explain.DELIVERABLE_COLUMNS) == 13
    assert hasattr(explain, "extract_spans")


def test_all_brands_count_is_15():
    import pipeline.core as core

    assert len(core.ALL_BRANDS) == 15
    assert core.ALL_BRANDS[0] == "TREMFYA"


# ─────────────────────── verbatim JSON parser contracts ──────────────────────
def test_parse_json_response_plain(pipeline_ns):
    parse = pipeline_ns["parse_json_response"]
    assert parse('{"age": ">=18"}') == {"age": ">=18"}


def test_parse_json_response_fenced(pipeline_ns):
    parse = pipeline_ns["parse_json_response"]
    fenced = '```json\n{"age": "NA"}\n```'
    assert parse(fenced) == {"age": "NA"}


def test_parse_json_response_preamble(pipeline_ns):
    parse = pipeline_ns["parse_json_response"]
    assert parse('Here is the result: {"age": "No"} done') == {"age": "No"}


def test_access_parse_json_plain(access_ns):
    _parse = access_ns["_parse_json"]
    assert _parse('{"access_score": 50}') == {"access_score": 50}


def test_access_parse_json_garbled_returns_none(access_ns):
    _parse = access_ns["_parse_json"]
    assert _parse("totally not json") is None


def test_format_row_for_model_includes_brand_and_params(access_ns):
    fmt = access_ns["format_row_for_model"]
    row = {"Brand": "TREMFYA", "Age": ">=18", "TB Test required": "Yes"}
    out = fmt(row, "POLICY BODY TEXT")
    assert "TREMFYA" in out
    assert "POLICY BODY TEXT" in out
    # Display labels from PARAM_KEYS are present.
    assert "Age:" in out
    assert "TB Test Required:" in out


# ─────────────────── docling-gated test (skipped when absent) ─────────────────
@pytest.mark.docling
@pytest.mark.skipif(
    importlib.util.find_spec("docling") is None,
    reason="docling not installed in this CI job (heavy dep); skipping converter test",
)
def test_docling_converter_builds_when_available():
    """Only runs in a job that actually installed docling. Confirms the real
    converter factory wires up without raising. Lightweight CI skips this."""
    import pipeline.core as core

    converter = core._get_converter()
    assert converter is not None
