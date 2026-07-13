"""
conftest.py — test fixtures + heavy-dependency stubbing for the container tests.

These tests run in GitHub Actions (CI), never on the slow local box. They cover
the VERBATIM-loaded notebook logic (validate_and_normalize, consistency_check,
CSV_COLUMNS) and the new aggregation / explainability code in pipeline.core /
pipeline.explain — WITHOUT installing torch / docling / surya / transformers /
google-genai.

How the no-heavy-deps import works
----------------------------------
pipeline.core lazily loads the three notebooks (via the AST notebook_loader) to
pick up the verbatim prompts + validators. Those notebook cells `import` a few
third-party modules at module scope:

    from google import genai
    from google.genai import types
    import openpyxl
    from docling_core.types.doc.document import DoclingDocument

None of these are *called* when only the pure validator/CSV definitions execute
(the loader filters out orchestration + bare expression cells), but the imports
themselves must resolve. So before anything imports `pipeline`, we install
lightweight stand-in modules into sys.modules for exactly those names (+ requests,
which pipeline.llm imports at module scope). docling / docling-surya / torch are
imported by pipeline.core ONLY lazily inside _get_converter(), which these tests
never call — so they need no stub at all.

This runs at import time of conftest (before test modules are collected), so the
stubs are in place no matter which test module triggers the first
`import pipeline...`.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest


# ── Make the `pipeline` package importable (tests live in container/tests/) ──
_CONTAINER_DIR = Path(__file__).resolve().parent.parent
if str(_CONTAINER_DIR) not in sys.path:
    sys.path.insert(0, str(_CONTAINER_DIR))


def _stub(name: str) -> types.ModuleType:
    """Register (or reuse) a stub module under `name` in sys.modules."""
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    return mod


def _install_heavy_dep_stubs() -> None:
    """Install minimal stand-ins for the heavy/3rd-party modules the verbatim
    notebook cells import at module scope, so the loader can exec the validator /
    CSV definitions without torch/docling/google-genai/openpyxl present.

    Only installs a stub when the real module is NOT importable, so a CI image
    that happens to have (say) requests installed keeps using the real one.
    """
    # google + google.genai + google.genai.types (notebook Gemini client cells).
    if importlib.util.find_spec("google") is None:
        google = _stub("google")
        genai = _stub("google.genai")
        gtypes = _stub("google.genai.types")
        google.genai = genai
        genai.types = gtypes
        # Referenced only inside functions we never call; provide harmless attrs
        # so any def-time decorator/annotation resolution can't trip.
        genai.Client = lambda *a, **k: None  # noqa: E731
        gtypes.GenerateContentConfig = object
        gtypes.ThinkingConfig = object

    # openpyxl (load_submissions cell imports it at module scope).
    if importlib.util.find_spec("openpyxl") is None:
        _stub("openpyxl")

    # docling_core.types.doc.document.DoclingDocument (reducer type hints).
    if importlib.util.find_spec("docling_core") is None:
        dc = _stub("docling_core")
        dc_types = _stub("docling_core.types")
        dc_doc = _stub("docling_core.types.doc")
        dc_document = _stub("docling_core.types.doc.document")
        dc.types = dc_types
        dc_types.doc = dc_doc
        dc_doc.document = dc_document

        class DoclingDocument:  # noqa: D401 - inert placeholder type
            """Inert stand-in for docling_core's DoclingDocument."""

        dc_document.DoclingDocument = DoclingDocument

    # requests (pipeline.llm imports it at module scope). Retry tests exercise
    # its exception taxonomy directly, so the no-requests CI path needs the same
    # four retryable transport classes that production code references.
    if importlib.util.find_spec("requests") is None:
        req = _stub("requests")

        class RequestException(Exception):
            """Minimal base matching requests.exceptions.RequestException."""

        class Timeout(RequestException):
            """Minimal timeout stand-in."""

        class ConnectionError(RequestException):
            """Minimal connection-error stand-in."""

        class ChunkedEncodingError(RequestException):
            """Minimal chunked-transfer stand-in."""

        class ContentDecodingError(RequestException):
            """Minimal content-decoding stand-in."""

        req.exceptions = types.SimpleNamespace(
            RequestException=RequestException,
            Timeout=Timeout,
            ConnectionError=ConnectionError,
            ChunkedEncodingError=ChunkedEncodingError,
            ContentDecodingError=ContentDecodingError,
        )
        req.post = lambda *a, **k: (_ for _ in ()).throw(  # pragma: no cover
            RuntimeError("network disabled in tests")
        )


_install_heavy_dep_stubs()


# Import AFTER the stubs are installed.
from pipeline import core, explain  # noqa: E402


@pytest.fixture(scope="session")
def pipeline_ns():
    """The verbatim definitions loaded from updated_pipeline.ipynb.

    Contains validate_and_normalize, parse_json_response, CSV_COLUMNS,
    SYSTEM_PROMPT — exactly as the production code consumes them.
    """
    return core._namespaces()["pipeline"]


@pytest.fixture(scope="session")
def reducer_ns():
    """The definitions loaded from document_reducer_1_.ipynb, with the override
    layer (pipeline.overrides.apply_reducer_overrides) already applied by
    core._namespaces() — i.e. PSO_PATTERNS is patched and reduce_document is
    the WRAPPED (deployed) function. Also contains BRAND_ALIASES/alias_in_text.
    """
    return core._namespaces()["reducer"]


@pytest.fixture(scope="session")
def access_ns():
    """The definitions loaded from access_score.ipynb, with the override layer
    (pipeline.overrides.apply_access_overrides) already applied by
    core._namespaces() — i.e. consistency_check is the WRAPPED (deployed)
    function. Also contains format_row_for_model, _parse_json,
    METHODOLOGY_PROMPT (verbatim).
    """
    return core._namespaces()["access"]


@pytest.fixture(scope="session")
def validate_and_normalize(pipeline_ns):
    return pipeline_ns["validate_and_normalize"]


@pytest.fixture(scope="session")
def consistency_check(access_ns):
    # The override-WRAPPED consistency_check (extended coverage + abstain) —
    # exactly the object production scoring calls, not the raw notebook one.
    return access_ns["consistency_check"]


@pytest.fixture(scope="session")
def csv_columns(pipeline_ns):
    return pipeline_ns["CSV_COLUMNS"]


@pytest.fixture
def core_mod():
    return core


@pytest.fixture
def explain_mod():
    return explain
