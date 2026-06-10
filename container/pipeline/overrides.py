"""
overrides.py — the accuracy override layer over the VERBATIM notebook namespaces.

The step notebooks (notebooks/*.ipynb) are provenance artifacts and must stay
byte-identical to the graded submission, so every behavioural fix lands HERE
instead. The mechanism: load_notebook_namespace exec's each notebook's
definitions into a plain dict, and that dict IS the __globals__ of every
function it defines — patching a key in the dict therefore retunes the
already-defined notebook functions without touching the .ipynb sources.
core._namespaces() applies these overrides under its init lock, after each
namespace loads and BEFORE the dicts are published, so no caller can ever
observe the unpatched behaviour.

Fixes applied (each logged when it is installed and when it fires):

  1. PsO regex (apply_reducer_overrides): PSO_PATTERNS[1] is
     re.compile(r'\\bPsO\\b') — case-SENSITIVE, provably dead against the
     .lower()ed haystacks reducer strategies B/C search. Re-compiled
     case-insensitive so 'pso' matches in lowercased text.

  2. Reducer threshold + relevance guard (apply_reducer_overrides):
     reduce_document is wrapped with an env-tunable passthrough threshold
     (REDUCER_PASSTHROUGH_CHARS) and a RELEVANCE GUARD — a reduced output that
     lacks the brand, a PsO keyword, or any criteria language is rejected in
     favour of the full markdown. The fallback is observable via
     consume_relevance_fallback() (core.py tags source="relevance-fallback").

  3. Clamp -> abstain (apply_access_overrides): consistency_check is wrapped so
     coverage is judged over an EXTENDED field set (the notebook's
     _COVERAGE_FIELDS plus Age / Quantity Limits / the Reauth* columns), and an
     UNCOVERED row with a positive model score ABSTAINS (score preserved, reason
     flags the row for review) instead of being clamped to 0 — an all-NA
     extraction could equally be an extraction miss on a covered policy.
"""
from __future__ import annotations

import logging
import os
import re
import threading

log = logging.getLogger("pa-extractor.overrides")

# ── Module constants (env-overridable) ───────────────────────────────────────
# Documents below this many full-markdown chars skip the reducer entirely (the
# raw markdown is the better LLM input for small files). Default mirrors the
# notebook's own `if full_len < 100_000` literal; see the wrapper note below.
REDUCER_PASSTHROUGH_CHARS = int(os.environ.get("REDUCER_PASSTHROUGH_CHARS", "100000"))

# The dead pattern as written in the notebook, and its working replacement.
_PSO_DEAD_PATTERN = r"\bPsO\b"
_PSO_FIXED = re.compile(r"\bpso\b", re.IGNORECASE)

# Criteria-language tokens the relevance guard requires in a reduced output.
_CRITERIA_TOKENS = re.compile(r"step|trial|approv|authoriz|criteria|requir")

# Coverage columns ADDED to the notebook's _COVERAGE_FIELDS for the extended
# coverage test (the notebook list excludes Age / Quantity Limits / Reauth*).
_EXTENDED_COVERAGE_FIELDS = [
    "Age",
    "Quantity Limits",
    "Reauthorization Duration(in-months)",
    "Reauthorization Required",
    "Reauthorization Requirements Documented in Policy",
]

# Same NA convention the notebook's _has_coverage uses.
_NA_VALUES = ("NA", "N/A", "NONE", "")

# Reason string returned when the wrapped consistency_check abstains.
ABSTAIN_REASON = "abstain: extraction-empty, score derived from policy text (needs review)"

# ── Relevance-fallback observability ──────────────────────────────────────────
# The wrapped reduce_document runs deep inside the verbatim call chain, so it
# can't return a source tag. It flips this per-thread flag instead; core.py
# consumes it right after the reduce call (same thread) to tag the source.
_fallback_state = threading.local()


def consume_relevance_fallback() -> bool:
    """True iff the relevance guard fell back to full markdown on THIS thread
    since the last call (consume-once; the wrapper resets it on entry)."""
    fired = getattr(_fallback_state, "fired", False)
    _fallback_state.fired = False
    return fired


# ── Fix 2: reduce_document wrapper (threshold + relevance guard) ─────────────
def _make_reduce_document_override(original, brand_aliases, alias_in_text, pso_patterns):
    """Build the wrapped reduce_document around the verbatim `original`.

    A factory (rather than patching inline) so the guard logic is unit-testable
    with a stub `original` and synthetic strings — no docling needed. The
    collaborators (BRAND_ALIASES / alias_in_text / PSO_PATTERNS) come from the
    loaded reducer namespace; pso_patterns must be the PATCHED list so the
    guard's PsO check works against lowercased text.
    """

    def reduce_document(doc, brand):
        _fallback_state.fired = False
        full_md = doc.export_to_markdown()
        # Passthrough threshold. NOTE: values BELOW 100_000 behave identically
        # to today — the notebook's own `if full_len < 100_000` literal still
        # gates inside `original` — so this wrapper can only RAISE the cutoff.
        if len(full_md) < REDUCER_PASSTHROUGH_CHARS:
            return full_md
        result = original(doc, brand)
        if result is full_md or len(result) >= len(full_md):
            # Not a reduced output (the original already fell back to the full
            # markdown itself) — nothing to guard.
            return result

        # RELEVANCE GUARD: a trustworthy reduction must mention the brand, a PsO
        # keyword, and at least one criteria token. Anything less means the
        # reducer focused on the wrong drug/indication; the full markdown is the
        # safer LLM input (core.py treats it like a passthrough, tagged
        # source="relevance-fallback" via consume_relevance_fallback()).
        lowered = result.lower()
        aliases = brand_aliases.get(brand.upper(), [brand.lower()])
        missing = []
        if not any(alias_in_text(a, lowered) for a in aliases):
            missing.append("brand")
        if not any(p.search(lowered) for p in pso_patterns):
            missing.append("pso-keyword")
        if not _CRITERIA_TOKENS.search(lowered):
            missing.append("criteria-language")
        if not missing:
            return result
        log.warning(
            "relevance guard: reduced output for brand %s is missing %s "
            "(%d chars); falling back to full markdown (%d chars)",
            brand, "+".join(missing), len(result), len(full_md))
        _fallback_state.fired = True
        return full_md

    return reduce_document


def apply_reducer_overrides(ns: dict) -> None:
    """Patch the reducer namespace in place (PsO regex + reduce_document wrapper)."""
    # Fix 1: re-compile the dead case-sensitive PsO pattern case-insensitively.
    # Located by its pattern string (not a blind index) so a drifted list still
    # patches correctly; mutated in place so every notebook function that closed
    # over the list sees the fix.
    patterns = ns["PSO_PATTERNS"]
    patched = 0
    for i, pat in enumerate(patterns):
        if pat.pattern == _PSO_DEAD_PATTERN and not (pat.flags & re.IGNORECASE):
            patterns[i] = _PSO_FIXED
            patched += 1
            log.info("override: PSO_PATTERNS[%d] %r -> %r (case-insensitive)",
                     i, _PSO_DEAD_PATTERN, _PSO_FIXED.pattern)
    if not patched:
        log.warning("override: case-sensitive %r not found in PSO_PATTERNS; "
                    "regex fix skipped", _PSO_DEAD_PATTERN)

    # Fix 2: wrap reduce_document (passthrough threshold + relevance guard).
    ns["reduce_document"] = _make_reduce_document_override(
        ns["reduce_document"], ns["BRAND_ALIASES"], ns["alias_in_text"], patterns)
    log.info("override: reduce_document wrapped (passthrough < %d chars + "
             "relevance guard)", REDUCER_PASSTHROUGH_CHARS)


# ── Fix 3: consistency_check wrapper (extended coverage + abstain) ───────────
def _make_consistency_check_override(original, coverage_fields):
    """Build the wrapped consistency_check around the verbatim `original`.

    `coverage_fields` is the EXTENDED list (notebook _COVERAGE_FIELDS +
    _EXTENDED_COVERAGE_FIELDS). Behaviour:
      * covered + score 0   -> preserve the reverse clamp (0 -> 25),
      * uncovered + score>0 -> ABSTAIN: keep the score, flag for review,
      * anything else       -> no boundary contradiction; score unchanged.
    """

    def consistency_check(row, access_score):
        covered = any(
            str(row.get(f, "")).strip().upper() not in _NA_VALUES
            for f in coverage_fields
        )
        if covered and access_score == 0:
            # Preserve the reverse clamp (covered drug cannot score 0). Defer to
            # the verbatim function when its own (narrower) coverage test agrees
            # so the result is byte-identical; when the row is covered ONLY via
            # the extended fields (e.g. Age- or Reauth-only) replicate its
            # 0 -> 25 outcome and reason.
            score, reason = original(row, access_score)
            if reason is None:
                score, reason = 25, "consistency: covered drug cannot score 0"
            return score, reason
        if not covered and access_score > 0:
            # ABSTAIN instead of clamping to 0: an all-NA extraction could
            # equally be an extraction MISS on a covered policy, and the model's
            # positive score was derived from the policy text itself. Keep the
            # score and flag the row for human review.
            log.warning("override: abstain - uncovered row, model score %s "
                        "preserved (needs review)", access_score)
            return access_score, ABSTAIN_REASON
        # No contradiction at the (extended) coverage boundary: keep the score.
        # Deliberately NOT the verbatim function here — its narrower coverage
        # test would clamp a positive score on an Age/Reauth-only row, which is
        # exactly the clamp this override removes.
        return access_score, None

    return consistency_check


def apply_access_overrides(ns: dict) -> None:
    """Patch the access namespace in place (consistency_check clamp -> abstain)."""
    coverage_fields = list(ns["_COVERAGE_FIELDS"]) + _EXTENDED_COVERAGE_FIELDS
    ns["consistency_check"] = _make_consistency_check_override(
        ns["consistency_check"], coverage_fields)
    log.info("override: consistency_check wrapped (extended coverage over %d "
             "fields; uncovered + positive score -> abstain)", len(coverage_fields))
