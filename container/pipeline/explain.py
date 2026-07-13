"""
explain.py — source-span explainability pass (ADDITIVE, separate from extraction).

This module asks the LLM (DeepSeek, via llm.chat in JSON mode) for the VERBATIM
supporting quotes in the focused policy text for each of the 13 deliverable
fields that the extraction + scoring stages produced. It is a SEPARATE pass with
its OWN prompt — it does NOT reuse or derive from the notebook prompts
(SYSTEM_PROMPT / METHODOLOGY_PROMPT) and it NEVER alters the extraction output.
The extracted values are passed in purely as context so the model knows what to
locate; the returned spans are advisory evidence only.

Public API:
  extract_spans(policy_text, params_or_row, brand)
      -> { "<column display name>": {"found": bool, "quotes": [str, ...]}, ... }
    keyed by the 13 deliverable column display names (DELIVERABLE_COLUMNS +
    "Access Score"). Robust to a missing / garbled model response: on any failure
    it returns a fully-populated map of found=false rather than raising.
"""
from __future__ import annotations

import json
import re

from . import llm

# The 13 deliverable column DISPLAY names we ask the model to find spans for.
# These match the Submissions-tab headers used by core.FINAL_COLUMNS (minus the
# non-clinical Filename / Brand columns) plus "Access Score". The access span is
# optional — a policy rarely "states" a numeric access score verbatim, so an
# empty / found=false for it is normal and acceptable.
DELIVERABLE_COLUMNS = [
    "Age",
    "Step Therapy Requirements Documented in Policy",
    "Number of Steps through Brands",
    "Number of Steps through Generic",
    "Step through-Phototherapy",
    "TB Test required",
    "Quantity Limits",
    "Specialist Types",
    "Initial Authorization Duration(in-months)",
    "Reauthorization Duration(in-months)",
    "Reauthorization Required",
    "Reauthorization Requirements Documented in Policy",
    "Access Score",
]

# Our OWN explainability prompt. Deliberately independent of the notebook
# extraction/scoring prompts. The word "json" appears (DeepSeek JSON-mode
# requirement) and the verbatim-only instruction is explicit.
_SPANS_SYSTEM_PROMPT = """You are a source-attribution assistant for prior authorization (PA) policy analysis.

You are given a policy excerpt, a target brand, and a set of parameter values that were already extracted from that excerpt for the Plaque Psoriasis (PsO) indication. Your ONLY job is to locate, for each parameter, the supporting evidence in the policy excerpt.

STRICT RULES:
- Quote VERBATIM. Each quote MUST be an exact, contiguous substring copied character-for-character from the policy excerpt. Do NOT paraphrase, summarize, correct, translate, normalize whitespace, or invent text.
- If the policy excerpt does not state anything about a parameter, set "found" to false and return an empty "quotes" list for it. Never fabricate a quote to fill a gap.
- Keep each quote focused (a sentence or clause is ideal). You may return more than one quote for a parameter when multiple passages are relevant.
- Do not add commentary, explanations, or fields beyond the JSON shape requested.
- The extracted values are provided only to tell you WHAT to look for. Your spans must reflect the policy text, not the extracted values.

Return ONLY a json object with this exact shape:
{
  "spans": {
    "<parameter display name>": { "found": true | false, "quotes": ["verbatim substring", ...] },
    ...
  }
}
Include an entry for every parameter display name listed in the user message. Output valid json and nothing else."""


def _row_value(params_or_row: dict, column: str) -> str:
    """Best-effort display value for a deliverable column.

    Accepts either the canonical `result`/`row` dict (keyed by display column
    names) OR the raw extraction `params` dict (keyed by snake_case fields).
    Used only to give the model context about what was extracted; it never
    affects the returned canonical values.
    """
    if not isinstance(params_or_row, dict):
        return "NA"
    if column in params_or_row:
        return str(params_or_row.get(column, "")).strip() or "NA"
    # Fall back to the snake_case params keys.
    snake = _COLUMN_TO_PARAM.get(column)
    if snake and snake in params_or_row:
        return str(params_or_row.get(snake, "")).strip() or "NA"
    return "NA"


# Display column -> raw extraction param key (mirrors CSV_COLUMNS in the notebook).
_COLUMN_TO_PARAM = {
    "Age": "age",
    "Step Therapy Requirements Documented in Policy": "step_therapy_requirements",
    "Number of Steps through Brands": "number_of_steps_through_brands",
    "Number of Steps through Generic": "number_of_steps_through_generic",
    "Step through-Phototherapy": "step_through_phototherapy",
    "TB Test required": "tb_test_required",
    "Quantity Limits": "quantity_limits",
    "Specialist Types": "specialist_types",
    "Initial Authorization Duration(in-months)": "initial_authorization_duration",
    "Reauthorization Duration(in-months)": "reauthorization_duration",
    "Reauthorization Required": "reauthorization_required",
    "Reauthorization Requirements Documented in Policy": "reauthorization_requirements",
    "Access Score": "access_score",
}


# ── Prompt-injection framing ──────────────────────────────────────────────────
# Same intentional, security-motivated framing as core.py: the policy excerpt is
# UNTRUSTED (OCR'd from a user PDF), so we fence it in explicit <POLICY_DOCUMENT>
# delimiters before it reaches the spans prompt. Our own _SPANS_SYSTEM_PROMPT is
# unchanged; we only delimit the data we pass in.
_POLICY_OPEN = "<POLICY_DOCUMENT>"
_POLICY_CLOSE = "</POLICY_DOCUMENT>"


def _wrap_policy(policy_text: str) -> str:
    """Fence untrusted policy text in delimiters (prompt-injection defense)."""
    return f"{_POLICY_OPEN}\n{policy_text}\n{_POLICY_CLOSE}"


def _empty_spans() -> dict:
    """A fully-populated found=false map (the graceful-degradation default)."""
    return {col: {"found": False, "quotes": []} for col in DELIVERABLE_COLUMNS}


def _parse_spans_json(text: str) -> dict | None:
    """Parse the model's JSON, tolerating markdown fences / preamble.

    Returns the parsed dict, or None if nothing usable could be parsed.
    """
    if not text or not str(text).strip():
        return None
    cleaned = str(text).strip()
    # Direct parse first.
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        pass
    # Strip markdown fences if present.
    fence = re.search(r"```(?:json)?\s*\n(.*?)\n```", cleaned, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except (json.JSONDecodeError, ValueError):
            pass
    # First { ... } block.
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(cleaned[start:end + 1])
        except (json.JSONDecodeError, ValueError):
            pass
    return None


def _coerce_quotes(raw, policy_text: str) -> list:
    """Normalize a model 'quotes' value into a list of verbatim policy substrings.

    Drops anything that is not a non-empty string, and (defensively) keeps only
    quotes that actually appear in the policy text so paraphrase/invention can't
    leak through. Matching is exact first, then whitespace-tolerant.
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple)):
        return []

    out: list = []
    seen = set()
    # Whitespace-collapsed view of the policy for tolerant containment checks.
    norm_policy = re.sub(r"\s+", " ", policy_text)
    for q in raw:
        if not isinstance(q, str):
            continue
        quote = q.strip()
        if not quote or quote in seen:
            continue
        # Verbatim guard: keep only quotes that are substrings of the policy.
        if quote in policy_text:
            pass
        elif re.sub(r"\s+", " ", quote) in norm_policy:
            pass
        else:
            continue  # not present verbatim -> drop (no paraphrase/invention)
        seen.add(quote)
        out.append(quote)
    return out


def extract_spans(policy_text: str, params_or_row: dict, brand: str) -> dict:
    """Source-span pass: verbatim supporting quotes per deliverable field.

    Returns { "<column>": {"found": bool, "quotes": [str, ...]} } keyed by the 13
    deliverable column display names. NEVER raises: any failure (no policy text,
    LLM error, garbled / non-conforming JSON) degrades to a found=false map.

    llm.chat retries its explicit transport/status/length transient classes, but
    a malformed successful response raises InvalidLLMResponseError after exactly
    one HTTP attempt. This advisory pass catches that error here and returns the
    empty map rather than adding an outer retry layer.
    """
    spans = _empty_spans()
    if not policy_text or not str(policy_text).strip():
        return spans

    brand = (brand or "").strip().upper()

    # Build the per-parameter context block (extracted value is context only).
    params_block = "\n".join(
        f'  - "{col}": {_row_value(params_or_row, col)}'
        for col in DELIVERABLE_COLUMNS
    )
    user_prompt = (
        f'Brand: "{brand}" (Plaque Psoriasis indication).\n\n'
        f"Already-extracted parameter values (context only — locate the evidence, "
        f"do not echo these as quotes):\n{params_block}\n\n"
        f"For each parameter display name above, return its verbatim supporting "
        f"quote(s) from the policy excerpt below, or found=false if the policy "
        f"does not state it. Return the json object described in the system "
        f"instructions.\n\n"
        # Untrusted policy excerpt fenced in delimiters (prompt-injection defense).
        f"POLICY EXCERPT:\n{_wrap_policy(policy_text)}"
    )

    try:
        text = llm.chat(_SPANS_SYSTEM_PROMPT, user_prompt, temperature=0.0, json_output=True,
                        metadata={"feature": "spans", "brand": brand})
    except Exception:  # noqa: BLE001 — never let the advisory pass break a brand
        return spans

    data = _parse_spans_json(text)
    if not isinstance(data, dict):
        return spans

    # Accept either {"spans": {...}} or a bare {col: {...}} mapping.
    inner = data.get("spans") if isinstance(data.get("spans"), dict) else data
    if not isinstance(inner, dict):
        return spans

    for col in DELIVERABLE_COLUMNS:
        entry = inner.get(col)
        if not isinstance(entry, dict):
            continue
        quotes = _coerce_quotes(entry.get("quotes"), policy_text)
        found = bool(entry.get("found", False)) and bool(quotes)
        # If the model said found=true but supplied no surviving verbatim quote,
        # downgrade to found=false (no evidence we can stand behind).
        spans[col] = {"found": found, "quotes": quotes}

    return spans
