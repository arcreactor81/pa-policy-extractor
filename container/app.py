"""
app.py — HTTP service that the Cloudflare Worker proxies to.

Endpoints (the Worker forwards /api/* here):
  GET  /health        liveness + resolved (non-secret) LLM config + warm state
  GET  /brands        the 15 in-scope brands (for the UI dropdown)
  POST /extract       multipart: `file` (PDF) + `brand`  ->  rich result JSON
  POST /analyze       multipart: `file` (PDF) + `brands` (comma-sep, 1..15)
                      ->  application/x-ndjson stream of progress + result events

Runs a CPU-only Docling + Surya OCR pass (ONCE per PDF, cached), the brand
reducer, then DeepSeek v4-pro extraction + access scoring. See pipeline/core.py.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import traceback

from flask import Flask, Response, jsonify, request, stream_with_context

from pipeline import core, llm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pa-extractor")

app = Flask(__name__)
MAX_BYTES = int(os.environ.get("MAX_PDF_BYTES", str(20 * 1024 * 1024)))  # 20 MB

# Hard body cap at the WSGI layer. Flask aborts with 413 before buffering the body,
# which defeats the chunked / no-Content-Length oversized-body bypass that the
# in-handler len(pdf_bytes) check alone can't catch (it only sees bytes already
# read). We add a small headroom over MAX_BYTES for multipart framing overhead so
# a legitimately max-sized PDF isn't rejected for its form boundaries.
_MULTIPART_OVERHEAD = 1 * 1024 * 1024  # 1 MB
app.config["MAX_CONTENT_LENGTH"] = MAX_BYTES + _MULTIPART_OVERHEAD

# Shared logical LLM-call budget (see SHARED CONTRACTS): reject up front when
# the per-brand call estimate, summed over brands, would exceed this.
# This estimate intentionally excludes physical HTTP attempts made by either
# retry layer; those attempts are recorded by pipeline.llm's structured logs.
#
# Per-brand calls (the /extract + /analyze "consensus-on" formula):
#     runs(extract) + runs(score) + (explain?1:0) + (consensus? num_validators*runs : 0)
# The W3 3-MODEL consensus generalizes the old single-secondary term: enabling
# consensus adds one extraction PER VALIDATOR PER RUN (num_validators * runs),
# since every validator in llm.VALIDATOR_MODELS runs the extraction `runs` times.
# Default 200 fits the worst legal request: 15 brands x (2*3 deep runs + 1 spans
# + 2 validators * 3 runs) = 195 calls — i.e. a full-width Deep-Confidence batch
# with the default-on consensus validators. Requests that OMIT `runs` default to
# core.DEFAULT_CONFIDENCE_RUNS (env CONFIDENCE_RUNS, default 1 — interactive
# uploads stay fast; the UI toggle / batch path send runs explicitly).
#
# BATCH PATH NOTE: the batch path (Worker JobCoordinator -> /analyze) forwards the
# job's `consensus` flag per PDF alongside `file`, `brands`, `runs`, and `explain`,
# so a batch job that opts in pays the validator term exactly like an interactive
# request. The Worker's up-front job budget check mirrors this formula (including
# its numValidators() gate matching llm.secondary_enabled()).
MAX_LLM_CALLS = int(os.environ.get("MAX_LLM_CALLS", "200"))


def _llm_call_count(num_brands: int, runs: int, explain_spans: bool,
                    num_validators: int = 0) -> int:
    """Per-contract logical LLM-call estimate, summed over brands:
        runs(extract) + runs(score) + (explain?1:0) + (consensus? num_validators*runs : 0)
    i.e. brands * (2*runs + (1 if spans) + num_validators*runs). Consensus only
    adds calls when it is BOTH requested AND the secondary provider is configured;
    callers pass num_validators=0 in every other case (it silently no-ops, 0 calls),
    and num_validators>0 only when consensus is genuinely active."""
    per_brand = 2 * runs + (1 if explain_spans else 0)
    per_brand += num_validators * runs
    return num_brands * per_brand


@app.errorhandler(413)
def _too_large(_err):
    """Clean JSON for an over-cap body (Flask's MAX_CONTENT_LENGTH abort)."""
    return jsonify({"error": f"request body too large (max {MAX_BYTES} bytes)"}), 413

# Warm up (load notebooks + build the Docling converter, which loads OCR models)
# in the background so the process reports healthy quickly and the first real
# request is as fast as possible.
_warm = {"ready": False, "error": None}


def _warmup():
    try:
        core.warmup()
        _warm["ready"] = True
        log.info("warmup complete: notebooks loaded, Docling converter built")
    except Exception as e:  # noqa: BLE001
        _warm["error"] = str(e)
        log.exception("warmup failed")


threading.Thread(target=_warmup, daemon=True).start()


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        # Degraded = the process is alive but warmup failed (notebooks/converter
        # didn't load); ok stays true so the liveness probe doesn't kill us.
        "degraded": bool(_warm["error"]),
        "warm": _warm["ready"],
        "warm_error": _warm["error"],
        "brands": core.ALL_BRANDS,
        "llm": llm.selftest_payload(),
    })


@app.get("/brands")
def brands():
    return jsonify({"brands": core.ALL_BRANDS})


def _read_pdf():
    """Pull the uploaded PDF off the request and run the size / magic-byte guards.

    Returns (pdf_bytes, filename, None) on success or (None, None, (resp, status))
    on a guard failure, so callers can `return resp, status`.
    """
    f = request.files.get("file") or request.files.get("pdf")
    if f is None:
        return None, None, (jsonify({"error": "no PDF uploaded under field 'file'"}), 400)
    pdf_bytes = f.read()
    if not pdf_bytes:
        return None, None, (jsonify({"error": "uploaded file is empty"}), 400)
    if len(pdf_bytes) > MAX_BYTES:
        return None, None, (jsonify({"error": f"PDF too large ({len(pdf_bytes)} bytes > {MAX_BYTES})"}), 413)
    if pdf_bytes[:5] != b"%PDF-":
        return None, None, (jsonify({"error": "uploaded file is not a PDF"}), 415)
    return pdf_bytes, (f.filename or "upload.pdf"), None


def _parse_runs(raw):
    """Parse the optional `runs` form field; clamping to 1..5 happens in core."""
    return core._clamp_runs(raw)


_TRUTHY = {"1", "true", "yes", "on", "y", "t"}
_FALSY = {"0", "false", "no", "off", "n", "f"}


def _parse_explain(raw):
    """Parse the optional `explain` form field into a bool.

    Truthy/falsy strings are honoured; anything missing/unrecognised falls back to
    core.DEFAULT_SOURCE_SPANS (env SOURCE_SPANS), so omitting the field keeps the
    current default behaviour.
    """
    if raw is None:
        return core.DEFAULT_SOURCE_SPANS
    s = str(raw).strip().lower()
    if s in _TRUTHY:
        return True
    if s in _FALSY:
        return False
    return core.DEFAULT_SOURCE_SPANS


def _parse_consensus(raw):
    """Parse the optional `consensus` (W3 cross-check) form field into a bool.

    Truthy/falsy strings are honoured; anything missing/unrecognised falls back to
    core.DEFAULT_CONSENSUS (env CONSENSUS, OFF by default), so omitting the field
    keeps the current default behaviour. Note: even when True this only takes
    effect if the secondary provider is configured (CF_API_TOKEN) — core gates it.
    """
    if raw is None:
        return core.DEFAULT_CONSENSUS
    s = str(raw).strip().lower()
    if s in _TRUTHY:
        return True
    if s in _FALSY:
        return False
    return core.DEFAULT_CONSENSUS


def _parse_brands(raw: str):
    """Parse the comma-separated `brands` field -> (brands_list, error_str).

    Validates each token is one of the 15 (UPPERCASE), dedupes while preserving
    first-seen order, and enforces the 1..15 count. Exactly one of the two return
    values is truthy.
    """
    valid = set(core.ALL_BRANDS)
    seen, brands = set(), []
    for tok in (raw or "").split(","):
        b = tok.strip().upper()
        if not b:
            continue
        if b not in valid:
            return None, f"unknown brand {b!r}; expected one of {core.ALL_BRANDS}"
        if b not in seen:
            seen.add(b)
            brands.append(b)
    if not brands:
        return None, "missing 'brands' (comma-separated list of 1..15 brand names)"
    if len(brands) > 15:
        return None, f"too many brands ({len(brands)}); max 15"
    return brands, None


@app.post("/extract")
def extract():
    brand = (request.form.get("brand") or "").strip()
    pdf_bytes, filename, err = _read_pdf()
    if err is not None:
        return err
    if not brand:
        return jsonify({"error": "missing 'brand'"}), 400

    runs = _parse_runs(request.form.get("runs"))
    explain_spans = _parse_explain(request.form.get("explain"))
    consensus = _parse_consensus(request.form.get("consensus"))

    # LLM-call budget (single brand on /extract). The W3 validators only add calls
    # when consensus is requested AND the secondary provider is wired up; then each
    # of the num_validators validators runs the extraction `runs` times.
    num_validators = len(llm.VALIDATOR_MODELS) if (consensus and llm.secondary_enabled()) else 0
    calls = _llm_call_count(1, runs, explain_spans, num_validators)
    if calls > MAX_LLM_CALLS:
        return jsonify({
            "error": f"too many LLM calls ({calls} > {MAX_LLM_CALLS}); reduce brands or runs"
        }), 400

    try:
        log.info("extract: %s | %s (%d bytes) runs=%d explain=%s consensus=%s calls=%d",
                 filename, brand, len(pdf_bytes), runs, explain_spans, consensus, calls)
        out = core.extract_one(pdf_bytes, filename, brand,
                               runs=runs, explain_spans=explain_spans,
                               consensus=consensus)
        return jsonify(out)
    except ValueError as e:
        # Client-supplied bad input (e.g. unknown brand) — safe to echo.
        return jsonify({"error": str(e)}), 400
    except Exception as e:  # noqa: BLE001
        # Sanitized: full detail (incl. any gateway text) stays in server logs.
        log.error("extract failed: %s\n%s", e, traceback.format_exc())
        return jsonify({"error": "extraction failed"}), 500


@app.post("/analyze")
def analyze():
    """OCR the PDF once and STREAM stage-by-stage progress + per-brand results as
    newline-delimited JSON (one JSON object per line, flushed as produced)."""
    pdf_bytes, filename, err = _read_pdf()
    if err is not None:
        return err
    brands, berr = _parse_brands(request.form.get("brands") or "")
    if berr is not None:
        return jsonify({"error": berr}), 400

    # Additive optional toggles. Unknown / missing values fall back to defaults,
    # so existing clients (which send none) are unaffected.
    runs = _parse_runs(request.form.get("runs"))
    explain_spans = _parse_explain(request.form.get("explain"))
    consensus = _parse_consensus(request.form.get("consensus"))

    # LLM-call budget: reject up front (HTTP 400) before any OCR / LLM work. The
    # W3 validators only add calls when consensus is requested AND the secondary
    # provider is configured (else it silently no-ops); each of num_validators
    # validators then runs the extraction `runs` times. Both interactive and
    # batch requests may send `consensus` (the JobCoordinator forwards it).
    num_validators = len(llm.VALIDATOR_MODELS) if (consensus and llm.secondary_enabled()) else 0
    calls = _llm_call_count(len(brands), runs, explain_spans, num_validators)
    if calls > MAX_LLM_CALLS:
        return jsonify({
            "error": f"too many LLM calls ({calls} > {MAX_LLM_CALLS}); reduce brands or runs"
        }), 400

    log.info("analyze: %s | %s (%d bytes) runs=%d explain=%s consensus=%s calls=%d",
             filename, ",".join(brands), len(pdf_bytes), runs, explain_spans,
             consensus, calls)

    def _ndjson():
        try:
            for event in core.analyze_stream(pdf_bytes, filename, brands,
                                             runs=runs, explain_spans=explain_spans,
                                             consensus=consensus):
                yield json.dumps(event) + "\n"
        except Exception as e:  # noqa: BLE001 — last-resort: surface as a fatal event
            # Sanitized: keep the detail server-side, send a generic fatal event.
            log.error("analyze stream crashed: %s\n%s", e, traceback.format_exc())
            yield json.dumps({"event": "error", "error": "extraction failed"}) + "\n"

    return Response(stream_with_context(_ndjson()), mimetype="application/x-ndjson")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    try:
        from waitress import serve
        log.info("serving on 0.0.0.0:%d (waitress)", port)
        # One blocking OCR job at a time is fine for the interactive demo; a few
        # threads let health checks and queued requests through.
        serve(app, host="0.0.0.0", port=port, threads=int(os.environ.get("THREADS", "4")))
    except ImportError:
        log.warning("waitress not installed; using Flask dev server")
        app.run(host="0.0.0.0", port=port)
