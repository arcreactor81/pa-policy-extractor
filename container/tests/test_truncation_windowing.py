"""
Tests for brand-aware window packing in core._truncate_policy_text.

Background: the cap (SCORING_MAX_CHARS, mirroring access_score.ipynb's
MAX_CHARS) used to blind head-truncate. On big payer documents whose per-drug
criteria modules live DEEP in the file (observed live: 705k chars, criteria at
pages 45-71) that amputated every criteria section -> all-NA extraction. The
packer keeps the document head + windows around brand-alias mentions instead.

Geometry-sensitive tests pin their own alias pattern via monkeypatch so they
don't depend on the notebook's BRAND_ALIASES content; the fallback/real-path
tests exercise the alias lookup as deployed.
"""
from __future__ import annotations

import re

import pytest

from pipeline import core


_STELARA_PAT = [re.compile(r"(?<![A-Za-z0-9])STELARA(?![A-Za-z0-9])", re.IGNORECASE)]


def _pin(monkeypatch, cap=400, head=50, before=20, after=80, pats=_STELARA_PAT):
    monkeypatch.setattr(core, "SCORING_MAX_CHARS", cap)
    monkeypatch.setattr(core, "WINDOW_HEAD_CHARS", head)
    monkeypatch.setattr(core, "WINDOW_BEFORE_CHARS", before)
    monkeypatch.setattr(core, "WINDOW_AFTER_CHARS", after)
    if pats is not None:
        monkeypatch.setattr(core, "_brand_alias_patterns", lambda brand: pats)


# ── under-cap: untouched, no mode ─────────────────────────────────────────────
def test_under_cap_is_untouched(monkeypatch):
    _pin(monkeypatch, cap=100)
    text = "x" * 99
    assert core._truncate_policy_text(text, "p.pdf", "STELARA") is text
    assert core.consume_truncation_mode() is None


# ── no alias anywhere: head fallback (the original behavior) ──────────────────
def test_no_alias_falls_back_to_head(monkeypatch):
    _pin(monkeypatch, cap=100)
    text = "x" * 250
    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert out == text[:100]
    assert core.consume_truncation_mode() == "head"


# ── alias only inside the head: still plain head truncation ──────────────────
def test_alias_only_in_head_is_head_mode(monkeypatch):
    # head=200 so the mention's window (end ~87) sits ENTIRELY inside the head:
    # nothing beyond the head to rescue -> plain head truncation.
    _pin(monkeypatch, cap=100, head=200)
    text = "STELARA appears early " + "x" * 300
    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert out == text[:100]
    assert core.consume_truncation_mode() == "head"


# ── the fix: deep criteria reachable through an alias window ──────────────────
def test_deep_alias_window_is_packed_in(monkeypatch):
    _pin(monkeypatch)
    head = "POLICY TITLE AND GLOBAL CRITERIA " + "h" * 30
    filler = "z" * 1000 + " "  # trailing space: the alias needs a word boundary
    deep = "STELARA criteria: TB test required before approval."
    text = head + filler + deep + "z" * 500
    assert len(text) > 400  # over the pinned cap

    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert core.consume_truncation_mode() == "alias-windowed"
    assert len(out) <= 400
    assert out.startswith("POLICY TITLE")            # head survives
    assert "TB test required" in out                  # deep criteria survive
    assert "[... unrelated policy sections omitted ...]" in out
    assert "zzzzzzzzzz" * 20 not in out               # bulk filler dropped


# ── word boundaries: embedded matches must not create windows ─────────────────
def test_embedded_alias_token_does_not_match(monkeypatch):
    _pin(monkeypatch, cap=100, head=50)
    text = "x" * 60 + "XSTELARAX" + "x" * 300        # embedded, not a word hit
    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert core.consume_truncation_mode() == "head"
    assert out == text[:100]


# ── overlapping mentions merge into one window (one gap marker max) ──────────
def test_overlapping_windows_merge(monkeypatch):
    _pin(monkeypatch, cap=600)
    text = ("h" * 60) + ("z" * 500) + "STELARA aaa STELARA bbb" + ("z" * 400)
    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert core.consume_truncation_mode() == "alias-windowed"
    # head piece + ONE merged deep piece -> exactly one gap marker
    assert out.count("[... unrelated policy sections omitted ...]") == 1
    assert "aaa" in out and "bbb" in out


# ── budget is a hard ceiling no matter how many mentions ─────────────────────
def test_budget_is_respected_with_many_mentions(monkeypatch):
    _pin(monkeypatch, cap=500)
    blocks = []
    for i in range(40):
        blocks.append(" STELARA mention %d " % i + "y" * 120)
    text = "h" * 60 + "".join(blocks)
    out = core._truncate_policy_text(text, "p.pdf", "STELARA")
    assert len(out) <= 500
    assert core.consume_truncation_mode() == "alias-windowed"


# ── real alias path: unknown brand falls back to the literal brand token ─────
def test_unknown_brand_uses_literal_token(monkeypatch):
    _pin(monkeypatch, pats=None)  # real _brand_alias_patterns
    deep = "ZZZDRUG requires a TB test."
    text = "h" * 60 + "z" * 900 + " " + deep + " " + "z" * 300
    out = core._truncate_policy_text(text, "p.pdf", "ZZZDRUG")
    assert core.consume_truncation_mode() == "alias-windowed"
    assert "TB test" in out


# ── consume-once semantics ────────────────────────────────────────────────────
def test_consume_truncation_mode_resets(monkeypatch):
    _pin(monkeypatch, cap=100)
    core._truncate_policy_text("x" * 250, "p.pdf", "STELARA")
    assert core.consume_truncation_mode() == "head"
    assert core.consume_truncation_mode() is None


# ── explicit cap argument (two-tier: PRIMARY vs SCORING) ─────────────────────
def test_explicit_cap_overrides_default(monkeypatch):
    _pin(monkeypatch, cap=100)  # SCORING_MAX_CHARS pinned to 100
    text = "x" * 250
    # Same text: default cap truncates, an explicit larger cap passes through.
    assert core._truncate_policy_text(text, "p.pdf", "STELARA", cap=300) is text
    assert core.consume_truncation_mode() is None
    assert len(core._truncate_policy_text(text, "p.pdf", "STELARA")) == 100


def test_primary_cap_is_above_scoring_cap():
    # The two-tier contract: extraction/spans (PRIMARY, 1M-token DeepSeek ctx)
    # must never be bounded tighter than scoring/validators.
    assert core.PRIMARY_MAX_CHARS > core.SCORING_MAX_CHARS
