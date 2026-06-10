"""
Golden tests for the Access Score majority-bucket vote (core._vote_access_score).

When runs > 1, the canonical Access Score is no longer the primary run's bucket:
the per-run integer buckets are voted —
  1. the majority bucket wins outright,
  2. a count tie resolves to the tied bucket CLOSEST TO THE MEDIAN of all run
     scores,
  3. buckets equidistant from the median fall back to the EARLIEST run
     (mirroring _majority's deterministic tie-break).
Determinism is contract-critical: same runs in, same bucket out, every time.
"""
from __future__ import annotations

import pytest


# ───────────────────────────── majority wins ──────────────────────────────────
def test_majority_bucket_wins(core_mod):
    assert core_mod._vote_access_score([25, 25, 75]) == 25


def test_majority_beats_median_proximity(core_mod):
    # 75 has the majority even though 0 drags the median down.
    assert core_mod._vote_access_score([75, 75, 0]) == 75


def test_unanimous(core_mod):
    assert core_mod._vote_access_score([50, 50, 50]) == 50


def test_single_run_is_identity(core_mod):
    assert core_mod._vote_access_score([100]) == 100


def test_empty_input_is_zero(core_mod):
    assert core_mod._vote_access_score([]) == 0


# ───────────────── tie -> bucket closest to the run median ────────────────────
def test_three_way_tie_resolves_to_median_adjacent(core_mod):
    # [0, 50, 75]: all tied at count 1; median 50 -> 50 wins (distance 0).
    assert core_mod._vote_access_score([0, 50, 75]) == 50


def test_tie_closest_to_median_wins(core_mod):
    # [0, 25, 100]: median 25 -> 25 wins.
    assert core_mod._vote_access_score([0, 25, 100]) == 25


def test_two_way_tie_equidistant_falls_to_earliest(core_mod):
    # [25, 75]: median 50, both 25 away -> earliest run wins.
    assert core_mod._vote_access_score([25, 75]) == 25
    assert core_mod._vote_access_score([75, 25]) == 75


def test_equidistant_pair_in_larger_tie(core_mod):
    # Counts: 25 x2, 75 x2, tie. Median of [0,25,25,75,75] is 25 -> 25 wins.
    assert core_mod._vote_access_score([0, 25, 25, 75, 75]) == 25


def test_earliest_run_final_tiebreak(core_mod):
    # [0, 100]: median 50, both 50 away -> earliest run (0) wins; order matters.
    assert core_mod._vote_access_score([0, 100]) == 0
    assert core_mod._vote_access_score([100, 0]) == 100


def test_vote_is_deterministic_across_calls(core_mod):
    seq = [25, 75, 0, 100, 75]
    results = {core_mod._vote_access_score(seq) for _ in range(50)}
    assert len(results) == 1
