# Pipeline accuracy benchmark

`run_benchmark.py` runs the **real container pipeline end-to-end** (Docling +
Surya OCR → reducer with the override layer → DeepSeek extraction → DeepSeek
access scoring, via `pipeline.core.extract_one`) over a worklist of
`(filename, brand)` pairs and grades the 12 deliverable parameters + the Access
Score against the PDF-derived truth verdicts produced by the eval harness.

## Requirements

- The **full container dependency stack** (docling / surya / torch / etc. —
  `pip install -r container/requirements.txt -c container/constraints.txt`).
  This is NOT a CI-stub test; it OCRs real PDFs.
- The **DeepSeek env at runtime**: `DEEPSEEK_API_KEY` is required (plus the
  optional gateway vars — see `pipeline/llm.py` for the full contract). The
  script fails fast with a clear error if the key is missing.
- Importing the module performs **no LLM call and no heavy import**; everything
  expensive happens inside `main()` after argument parsing.

## Usage

```
python container/benchmark/run_benchmark.py \
    --pdf-dir   <directory containing the policy PDFs> \
    --worklist  <PA_Business_Rules.xlsx | pairs.csv> \
    --truth-dir <workdir>\_analysis\eval\verdicts \
    --out       benchmark_report.md \
    --runs      1
```

- `--worklist` accepts the original `PA_Business_Rules.xlsx` (its `Submissions`
  tab's `Filename`/`Brand` columns) or a plain csv of `filename,brand` rows
  (header optional).
- `--truth-dir` defaults to `<workdir>\_analysis\eval\verdicts`; each pair
  is graded against `<pdf-stem>__<BRAND>.json`. Pairs with no verdict file are
  skipped and listed in the report.
- `--runs` forwards the confidence-runs count to the pipeline (1..5).

## Grading semantics

Matching reimplements the `norm()` / `struct_match()` helpers from
`_analysis/eval/rescore_full.py`, so a cell counts as a match against the
verdict's `derived` value exactly when the validated rescore would have counted
it: exact match after normalization (lowercase, non-alphanumerics collapsed),
leading-number equivalence, "absent" equivalence (NA/No/none/not specified/
unspecified), yes/required equivalence, or containment either way. The Access
Score is compared as a bucket (first integer in each value).

Structural parameters (Age, step counts, phototherapy, TB, durations, reauth
required) are a high-confidence mechanical grade; the free-text parameters
share the same matcher but its containment clause makes them a **lenient**
grade — the report labels each parameter accordingly.

## Output

A markdown report (`--out`) with:

1. a per-parameter accuracy matrix (per-param % + OK/total, grade label),
2. the Access Score bucket-agreement rate,
3. a per-row table (Y/N per parameter, params-OK count, predicted vs truth
   access bucket),
4. skipped pairs (no truth verdict) and pipeline errors.

## Cost / runtime warning

Every row costs one full OCR pass (minutes per new PDF on CPU; the OCR cache
dedupes repeated files within one process) plus `2 * runs` DeepSeek calls.
Budget accordingly before pointing it at a large worklist.
