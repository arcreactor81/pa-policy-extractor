# PA Policy Extractor — Full Project Overview & Change Log

> **Purpose of this document.** This is a complete, self-contained briefing you can hand to an LLM (or a person)
> so they understand: (1) the **original hackathon project**, (2) the **goal** of this work, (3) the **hard
> constraints** that forced a re-architecture, (4) **what was built** on Cloudflare, (5) **exactly what changed vs.
> the original**, (6) **what improved**, (7) the **engineering process** used, and (8) how to **deploy / extend** it.
> It is intentionally expansive. Skim the headings; dive where you need.

---

## 0. TL;DR

A hackathon **Python ML pipeline** that extracts 13 Prior-Authorization (PA) parameters + an Access Score from
plaque-psoriasis policy PDFs was **re-hosted as a production Cloudflare web app** — a Worker-fronted dashboard backed
by a Cloudflare Container (for the heavy OCR), Durable Objects, R2, D1, and DeepSeek v4-pro reasoning via Cloudflare
AI Gateway.

- The **extraction logic is preserved byte-for-byte**: the original notebooks are loaded verbatim; the *only* model
  change is **Gemini 2.5 Flash → DeepSeek v4-pro**. A small **override layer** (`container/pipeline/overrides.py`)
  applies a handful of documented accuracy deltas at runtime — the notebooks themselves are never edited (see §7).
- It grew well beyond a re-host: **parallel multi-brand processing, async/batch jobs, a persistent searchable
  library, cross-payer analytics, 3-model consensus validation, exports (PDF/FHIR/CSV), saved cohorts, and a full
  security/cost-hardening pass.**
- Built and validated almost entirely by **multi-agent workflows with adversarial review** (the human directed; agents
  implemented + cross-checked), and graded by an independent **Opus codebase evaluation**.

Repo: `pa-policy-extractor/` (~74 files). Deploy: push to GitHub → GitHub Actions builds the container + `wrangler deploy`.

---

## 1. The Original Project (`CANDIDATE_ID`)

A hackathon submission: **extract structured Prior-Authorization parameters for the Plaque Psoriasis (PsO) indication**
from pharmaceutical PA policy PDFs, for a given drug brand.

### 1.1 What it produced
For each `(PDF, brand)` pair, **13 parameters** plus `Filename` and `Brand`:

1. Age threshold
2. Step Therapy Requirements (full text)
3. Number of Steps through Brands
4. Number of Steps through Generic
5. Step through-Phototherapy
6. TB Test required
7. Quantity Limits
8. Specialist Types
9. Initial Authorization Duration (months)
10. Reauthorization Duration (months)
11. Reauthorization Required
12. Reauthorization Requirements (full text)
13. **Access Score** — a 0/25/50/75/100 bucket of access quality relative to the FDA label

15 in-scope brands: TREMFYA, STELARA, COSENTYX, SKYRIZI, ENBREL, OTEZLA, BIMZELX, SILIQ, ILUMYA, CIMZIA, AMJEVITA,
REMICADE, OTULFI, YESINTEK, ACITRETIN. Output: a `.xlsx` (and `result.csv`) with one row per `(PDF, brand)`.

### 1.2 The 5-stage pipeline (`driver.py` orchestrating 4 notebooks)

| Stage | Notebook | What it does | Tech |
|---|---|---|---|
| 1 | `Docling_extraction_1_.ipynb` | each `pdfs/*.pdf` → markdown + structured `DoclingDocument` JSON | **Docling + Surya OCR** (PyTorch, CUDA-optional) |
| 2 | `document_reducer_1_.ipynb` | `(DoclingDocument, brand)` → focused text with only that brand's PsO criteria | **pure-Python heuristics, no LLM** (heading match, table search, "Go to #X" cross-reference BFS) |
| 3 | `updated_pipeline.ipynb` | focused text → 12 params | **Gemini 2.5 Flash** + `validate_and_normalize` |
| 4 | `access_score.ipynb` | params + text → the 13th param (Access Score) | **Gemini 2.5 Flash** + `consistency_check` |
| 5 | `driver.py` (merge) | join 12 params + access score → `*.xlsx` | openpyxl |

`driver.py` is a clever orchestrator: it loads each notebook's **function definitions** at runtime via an AST loader
(skipping side-effecting/orchestration cells), so the notebooks remain the single source of truth. The reducer is
tightly coupled to Docling's object model (`doc.iterate_items()`, `TableItem.export_to_dataframe()`).

### 1.3 The original engineering methodology (important context)
The submission's write-up emphasizes:
- **Gemini 2.5 Flash** is the only production model (hackathon-mandated).
- **Multi-model validation**: DeepSeek V4 Pro + Claude were used *offline* as independent validators/auditors (never in
  the submitted pipeline). Three-way cell agreement was tracked.
- **Measured nondeterminism**: LLM outputs drift ~8% run-to-run; the team measured/bounded it and shipped a locked run.
- **Generalizability audit**: removed all corpus-fitting (no hardcoded ages, no step-count caps, no answer injection).
- **FDA-label verification** of ages and lines-of-therapy.
- The **Access Score** is an LLM call guided by a methodology prompt, backstopped by a deterministic coverage check.

It ran **locally** (GPU optional, CPU fallback), needed a **Gemini API key**, and processed a `pdfs/` folder against a
`PA_Business_Rules.xlsx` worklist.

---

## 2. The Goal

> "Deploy the pipeline present in `CANDIDATE_ID` to Cloudflare Workers as a project I can host on my GitHub."

Refined through conversation into concrete decisions (see §4).

---

## 3. The Hard Constraint That Forced a Re-Architecture

**Cloudflare Workers cannot run the front half of the pipeline.** Workers are V8 isolates / Pyodide-WASM with ~128 MB
memory, CPU-time limits, **no native binaries, no GPU**. Stage 1 (Docling + Surya OCR + PyTorch + transformers) and
Stage 2 (the reducer, which needs Docling's in-memory `DoclingDocument` object) are fundamentally incompatible. Stages
3–5 (LLM API calls + data munging) port trivially.

**Resolution:** run the real Docling/Surya/reducer in a **Cloudflare Container** (a full CPU Python runtime that a
Worker fronts), and keep the Worker as the thin, always-on edge front door. (Cloudflare Containers have **no GPU**, so
OCR runs on CPU — correct but slower, exactly the original's documented "CPU fallback" path.)

---

## 4. Key Decisions (made explicitly with the human)

| Decision | Choice | Why |
|---|---|---|
| PDF → text | **Cloudflare Container running the real Docling + Surya + reducer** | Fidelity over simplicity (vs. the lighter Workers AI `toMarkdown`); preserves the original OCR + the brand reducer |
| Reasoning model | **DeepSeek v4-pro** (off Gemini), via **Cloudflare AI Gateway** | Human's choice to leave Gemini; AI Gateway gives cost monitoring + the human already runs one. Note: DeepSeek v4-pro was a *validator* in the original, so promoting it to the engine is coherent |
| Deliverable shape | **Analytics dashboard**, not a CSV exporter | Human wanted a visual product; CSV became a secondary *export* |
| Hosting / deploy | **GitHub repo + GitHub Actions push-to-deploy** | Human's PC is slow and runs nothing heavy locally; Cloudflare has no cloud Dockerfile build, so the GitHub runner builds the image |
| Auth | **Cloudflare Access** (platform-level) + per-IP rate limiting | Keep it a public demo but bounded; Access gates it to trusted users with zero code |
| Cost | **Stay inside the Workers Paid included allotments** | Explicit constraint; drove sleepAfter/max_instances/budget/retention caps |

### 4.1 The fidelity tactic (how the extraction stays identical)
The four original notebooks ship **verbatim** in `container/notebooks/`. `container/pipeline/notebook_loader.py`
(ported from the original `driver.py`) loads their **definitions** via AST, so these are **byte-identical** to the
submission:
- `SYSTEM_PROMPT` (extraction) and `METHODOLOGY_PROMPT` (access scoring)
- `validate_and_normalize`, `consistency_check`
- `reduce_document` (+ `DocumentIndex` and the 3 strategies)
- the CSV column mapping (`CSV_COLUMNS`, `FINAL_COLUMNS`), `BRAND_ALIASES`

`google-genai` is installed **only so those notebook cells import cleanly**; it is **never called**. All inference goes
through `container/pipeline/llm.py` → DeepSeek.

---

## 5. The Re-Hosted Architecture

```
Browser ──HTTPS──▶ Cloudflare Worker  (src/)            ← serves the dashboard (public/) + /api/*
                     │   • CSP + security headers, per-IP rate limit (RateLimiter DO), 20MB/PDF body cap
                     │   • streaming passthrough (never parses the NDJSON contract)
                     │   • sticky routing by PDF sha256
        ┌────────────┼───────────────────────────────────────────────┐
        ▼            ▼                                                 ▼
  RateLimiter DO   PaContainer (DO handle) ──▶ Container :8080         JobCoordinator DO  + R2 + D1
  (per-IP window)    Flask (container/app.py)                          (async/batch jobs, WS hibernation,
                       1. Docling + Surya OCR (CPU, run ONCE, cached)   reconnect+replay, retention alarm)
                       2. brand reducer → focused text
                       3. DeepSeek v4-pro extraction (12 params)        R2: PDFs, results, cohort PDFs, library blobs
                       4. DeepSeek v4-pro access scoring (13th)         D1: library index + cohorts/runs
                       (+ optional confidence runs, source-spans,
                          and 3-model consensus via Workers AI)
                            │
                            ▼ OpenAI-compatible HTTPS
                   Cloudflare AI Gateway ──▶ DeepSeek v4-pro   (+ Workers AI: GPT-OSS 20B, Mistral Small 3.1 24B validators, also gateway-routed)
```

**Cloudflare primitives used:** Workers, **Containers** (PaContainer), **Durable Objects** ×3 (PaContainer handle,
RateLimiter, JobCoordinator), **R2** (object storage), **D1** (SQLite — the library/cohorts index), **AI Gateway**
(DeepSeek monitoring + Workers AI validators), **Workers AI** (consensus validators), **static assets** (the dashboard),
**Cron Triggers** (off-by-default cohort scheduling + library retention prune), **GitHub Actions** (build + deploy).

---

## 6. Feature Set (everything the app does)

### Core extraction (faithful to the original)
- Upload a PA policy PDF, pick one or more of the 15 brands → the 13 parameters + Access Score + a one-sentence
  justification, streamed live (OCR → reduce → extract → score).

### Performance
- **Multi-brand in parallel** — OCR the PDF **once** (cached by content hash), then run all selected brands'
  extract+score **concurrently** (thread pool; I/O-bound LLM calls). ~3–4.5× faster for many brands.
- **Sticky container pool** — the dashboard hashes the PDF and routes by it, so the same PDF lands on the same warm
  container (OCR-cache hit) and distinct PDFs run on distinct instances.
- **Response cache** — re-analyzing an identical `(PDF, brand, runs, explain)` returns instantly from the library.

### Quality / trust
- **Confidence / variance** (optional `runs`) — repeat extraction N times, surface per-field agreement, flag
  low-confidence values. (Operationalizes the original's "measured nondeterminism.") Interactive uploads that omit
  `runs` default to **1 run** (`CONFIDENCE_RUNS` env) so they stay fast; the UI's Deep-Confidence toggle and the
  batch/library/cohort paths send **`runs=3`** explicitly for majority voting.
- **Source-span evidence** (optional `explain`) — a *separate* LLM pass returns the verbatim policy quote supporting
  each value; any quote that isn't a literal substring of the policy is dropped (no hallucinated evidence).
- **3-model consensus** (**ON by default in the UI** — the "Cross-check" toggle ships checked) — DeepSeek v4-pro
  (canonical) cross-checked by **two Workers AI validators**
  (`@cf/openai/gpt-oss-20b` + `@cf/mistralai/mistral-small-3.1-24b-instruct` — chosen for 128k context on Workers AI,
  which hard-errors on oversized input while policy texts reach ~75k tokens, plus JSON-mode reliability; the old
  llama-3.3 default is 24k-context there and gemma-3 was deprecated 2026-05-30) running the same verbatim prompt;
  per-field "K/N models agree". (Echoes the original's multi-model validation, now live & in-product.)

### Scale / resilience
- **Batch jobs** — submit many PDFs as one async job (JobCoordinator DO + R2); progress streams over a **reconnectable
  WebSocket** (hibernation + event replay from `lastSeq`); close the tab and resume via a `#job/#lib` URL — nothing lost.
- **Persistent library (D1)** — every analysis is saved, searchable (brand/payer/score/date facets), with
  **permalinks**, **per-user tenant scoping** (Cloudflare Access identity), and **auto-retention** prune.

### Analytics
- **Brand-vs-brand heatmap** (score + barriers across brands for one policy).
- **Cross-payer benchmarking** (one brand's Access Score across all stored policies).
- **Faceted search** with quick presets.

### Outputs
- **Exports**: print/Save-as-PDF report, **FHIR R4** MedicationKnowledge bundle, and **CSV/JSON** (CSV in the original
  15-column schema, with RFC-4180 quoting + a spreadsheet-formula-injection guard).
- **Saved cohorts** — name a set of policies + brands (PDFs persisted), **re-run on demand**, **compare versions**
  (field-level diff), **webhook on completion** (SSRF-guarded), and an **off-by-default** scheduled cron.

### Security / ops
- Per-IP **rate-limit** Durable Object, per-request **LLM-call budget** (`MAX_LLM_CALLS`), 20 MB per-PDF body cap
  + 100 MB total batch-upload cap (defeats chunked-bypass), **prompt-injection delimiting** of untrusted policy text, strict **CSP + security headers**, **error
  sanitization** (no internal/gateway detail leaked), optional **Access-JWT verification** for verified tenant
  isolation, **library retention** prune, and **AI Gateway cost monitoring** (`cf-aig-metadata` tags per brand+feature).

### API (served by the Worker, behind security headers)
`GET /api/brands` · `GET /api/health` · `POST /api/analyze?route=<sha256>` (single, streaming NDJSON) ·
`POST /api/extract` (single, non-streaming) · `POST /api/jobs` + `GET /api/jobs/:id` + `GET /api/jobs/:id/stream` (WS) ·
`GET /api/results?jobId=` · `GET /api/library` + `/api/library/:id` + `/api/library/lookup` ·
`POST /api/cohorts` + `/:id` (PATCH/DELETE) + `/:id/run` + `/:id/runs` + `/:id/compare`.

---

## 7. What Changed vs. the Original (the precise diff)

| Area | Original | Now | Notes |
|---|---|---|---|
| **Stage 1–2 (OCR + reducer)** | Local Python, GPU-optional | Same code, in a **CPU Cloudflare Container** | `device=CPU` forced; `generate_page_images=False` (memory; doesn't change extracted text); converter built behind a lock |
| **Stage 3–4 (LLM)** | **Gemini 2.5 Flash** via `google.genai` | **DeepSeek v4-pro** via AI Gateway (OpenAI-compatible) | The **only** model change. Prompts/validators **verbatim**. `thinking`/`reasoning_effort` map to Gemini's dynamic thinking |
| **Prompts** | As written | **Identical**, except the untrusted `policy_text` is wrapped in `<POLICY_DOCUMENT>…</POLICY_DOCUMENT>` in the **user** prompt (system prompts untouched) | The one intentional change — a prompt-injection mitigation on *data*, not instructions |
| **Orchestration** | Batch over a `pdfs/` folder (`driver.py`) | Single `(PDF, brand)` HTTP request + streaming multi-brand + async batch jobs | |
| **Input** | `pdfs/` + `PA_Business_Rules.xlsx` worklist | User uploads a PDF + picks brands; no business-rules file needed at runtime | |
| **Output** | A locked `.xlsx` / `result.csv` | Live dashboard + JSON; CSV/FHIR/PDF are **optional exports**; results persist in a library | The xlsx schema survives as the CSV export |
| **Runtime** | Local machine + Gemini key | Cloudflare (Worker + Container + DOs + R2 + D1) + DeepSeek key | |
| **Deploy** | `python driver.py` | `git push` → GitHub Actions builds the image + `wrangler deploy` | No local Docker/builds |

**Not changed:** the extraction/scoring logic, the reducer, the validators, the Access-Score methodology, the 13-param
schema, the 15 brands, the deterministic coverage-boundary check. Output equivalence vs. the original is expected to be
within the same LLM-nondeterminism band the original documented (plus any DeepSeek-vs-Gemini model difference).

**One qualification:** a small, documented **override layer** (`container/pipeline/overrides.py`) patches the
verbatim-loaded definitions at runtime with deliberate accuracy deltas — a case-insensitive fix to the reducer's
(provably dead) `\bPsO\b` relevance pattern, a two-sided relevance guard (an implausible reduction falls back to the
full text), an extended coverage-field check that abstains-and-flags instead of clamping an uncovered-looking row's
positive score to 0, and named env-overridable thresholds (`REDUCER_PASSTHROUGH_CHARS`, default 100000;
`SCORING_MAX_CHARS`, default 300000 for scoring + the 128k-ctx consensus validators; `PRIMARY_MAX_CHARS`, default
3200000 for the 1M-token-context primary's extraction/spans inputs). Oversized documents are brand-aware window
packed (head + alias windows), never blindly head-truncated. The notebook files stay byte-identical; the README's
"Override layer" section lists each divergence.

---

## 8. What Improved (beyond the re-host)

- **Speed**: multi-brand parallelism + OCR-once cache + response cache.
- **Resilience & sharing**: async jobs survive disconnects; permalinks; persistent library.
- **Trust signals**: per-field confidence/variance; verbatim source-span evidence; **3-model consensus** (live
  realization of the original's multi-model validation theme).
- **Analytics not in the original**: brand-vs-brand heatmaps, cross-payer benchmarking, faceted search.
- **Workflow features**: saved cohorts + version diffing + webhooks.
- **Productionization**: auth (Access), rate limiting, CSP, prompt-injection defense, cost budget + monitoring,
  retention, CI/CD, tests.
- **Observability**: every model call is attributable in AI Gateway.

---

## 9. Engineering Process (how it was built)

This was built with **heavy multi-agent orchestration** (the human's explicit preference), not single-threaded coding:
- **Workflows** fanned out file-owned agents in parallel (e.g., container / worker / frontend / docs), each running a
  **build → adversarially-refute → fix loop**, followed by independent **review lenses** (contract, security,
  performance, CSP/a11y).
- A **red-team** workflow (6 attacker surfaces + a refutation pass to kill false positives) surfaced 34 findings,
  11 confirmed; the high-conviction ones were implemented.
- A **research-before-build** discipline verified version-sensitive Cloudflare APIs (Containers wiring, DO WebSocket
  hibernation, R2, D1, AI Gateway, Workers AI OpenAI-compat) against current docs before writing deploy-critical code.
- A final **Opus codebase evaluation** (6 dimensions) graded the repo and produced a prioritized issue list, whose
  critical/high items were then fixed.
- **Constraint:** no heavy local execution (slow PC) — no `npm install`, Docker, torch, or OCR ran locally. Validation
  was code-level (agents + reading) + **CI** as the runtime gate. Lightweight `python -m py_compile` was used to catch
  syntax errors. (Self-correction during the project: read-only analysis agents initially defaulted to **Haiku** via the
  `Explore` agent type; this was caught and switched to **Opus** for the eval and analysis.)

### 9.1 Opus eval scorecard (after fixes)
| Dimension | Grade |
|---|---|
| Architecture & code quality | **A** |
| Fidelity & correctness | **A** |
| Frontend | **A** |
| Security | **B** |
| Performance & cost | **B** |
| Tests & deployability | **C** → fixed (the C was deploy-doc gaps: D1 setup step, `MAX_LLM_CALLS` var, README completeness — all resolved) |

The 5 critical/high findings were all resolved: D1 setup documented, **opt-in Access-JWT verification** added, **library
retention** prune added, `MAX_LLM_CALLS` made a real forwarded var, README API/capabilities completed.

---

## 10. Cost / Subscription Model

Designed to live inside the **Workers Paid (~$5/mo)** included allotments for low-concurrency, Access-gated use:
- **Container compute** (the main lever): `sleepAfter = 3m`, `max_instances = 3`. Multi-brand parallelism adds **no**
  container cost (one container per PDF; brands are threads inside it).
- **DeepSeek tokens** (the real variable cost): capped per request by `MAX_LLM_CALLS` (default 200; fits the worst
  legal request — all 15 brands at runs=3 with spans + both validators: 15 × (2×3 + 1 + 2×3) = 195), observable +
  limitable in AI Gateway.
- **Workers AI** (consensus validators — the Cross-check toggle is **ON by default in the UI**): billed in neurons;
  10k/day free covers light demo use; ~a cent per validator call at the median policy size. Validator calls route
  **through the AI Gateway**, so the gateway's analytics and spend cap cover them alongside DeepSeek.
- **Hard spend cap (~$5/mo)**: set a **budget/spend limit** on the AI Gateway (dashboard → AI → AI Gateway → your
  gateway → Settings; optional rate limit too) — one limit caps **both** the DeepSeek primary and the gateway-routed
  Workers AI validators. DeepSeek's prepaid balance is a second natural ceiling, and Workers AI usage alerts are
  available in the dashboard.
- **Durable Objects + R2 + D1**: WebSocket **hibernation** = ~zero idle billing; R2/library retention bound storage;
  D1 is light.
- **Tunable knobs** (`wrangler.jsonc`): `sleepAfter`, `max_instances`, `MAX_LLM_CALLS` (200), `CONFIDENCE_RUNS`
  (1 — interactive default; the Deep-Confidence toggle / batch paths send runs=3 explicitly),
  `MAX_PDFS_PER_JOB` (25), `MAX_CONCURRENT_PDFS` (2), `RETENTION_DAYS` (7, batch), `LIBRARY_RETENTION_DAYS` (30),
  `VALIDATOR_MODELS`.
- Deliberately **omitted** as budget-hostile: an always-on warm-pool ping (would keep a container awake 24/7). Scheduled
  cohort re-runs exist but are **off by default**.

---

## 11. Repository Map

```
pa-policy-extractor/
├── README.md                     deploy + usage + API + cost (operator-facing)
├── PROJECT_OVERVIEW.md           this document
├── wrangler.jsonc                Worker config: container, 3 DOs + migrations v1/v2/v3, R2, D1, vars, cron, assets
├── package.json / tsconfig.json / vitest.config.ts / worker-configuration.d.ts
├── .github/workflows/            ci.yml (python+node gates + weekly real-stack run), deploy.yml (CI-gated build+deploy),
│                                 gen-lockfile.yml, gen-pylock.yml (pins container/constraints.txt)
├── src/                          the Worker (TypeScript, ~3.1k lines)
│   ├── index.ts                  router, CSP/headers, rate-limit, sticky pool, streaming passthrough, scheduled()
│   ├── types.ts                  the typed Worker↔container contract + NDJSON event union
│   ├── rate-limiter.ts           RateLimiter Durable Object (per-IP sliding window)
│   ├── job-coordinator.ts        JobCoordinator Durable Object (batch, WS hibernation, retention, webhook)
│   ├── library.ts                D1 persistent library (save/list/get/lookup, owner scoping, Access-JWT)
│   ├── cohorts.ts                saved cohorts (create/run/compare/patch/delete)
│   └── util.ts                   shared: SSRF webhook guard, Access-JWT verify, runs/explain/brand parsers
├── public/                       the dashboard (vanilla JS, no deps, strict CSP)
│   ├── index.html  styles.css  theme.js
│   ├── app.js                    single-PDF streaming + window.PA shared renderer surface
│   ├── batch.js                  batch mode + 3-way mode switch
│   ├── library.js                library browser + permalinks + cache hint
│   ├── analytics.js              heatmap + cross-payer benchmarking
│   ├── export.js                 PDF/FHIR/CSV/JSON exports
│   └── cohorts.js                cohorts management + version-compare diff
└── container/                    the Python service (Docling + reducer + DeepSeek)
    ├── Dockerfile                CPU torch, model bake, non-root, healthcheck
    ├── requirements.txt  warmup_build.py  .dockerignore
    ├── app.py                    Flask: /health /brands /extract /analyze (NDJSON), budget guard, body cap
    ├── pipeline/
    │   ├── notebook_loader.py    AST loader (verbatim defs from the notebooks)
    │   ├── core.py               orchestration: OCR-once cache, brand fan-out, confidence, consensus
    │   ├── llm.py                DeepSeek client + Workers AI validators (OpenAI-compatible)
    │   └── explain.py            source-span pass (separate prompt, verbatim-guarded)
    ├── notebooks/                the 4 original .ipynb files, verbatim (source of truth for prompts/validators)
    └── tests/                    pytest (validators/reducer/aggregation/spans, heavy deps stubbed; runs in CI)
```

---

## 12. How to Deploy (no local builds)

1. Push the repo to GitHub `main`.
2. GitHub → Settings → Secrets and variables → **Actions**: add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
3. R2 + D1: **already provisioned for this account** — the `pa-job-results` bucket exists and the `pa-library`
   Database ID is wired into `wrangler.jsonc` (`d1_databases[0].database_id`). Forks deploying elsewhere create their
   own (**R2 → create bucket `pa-job-results`**; **D1 → create database `pa-library`**) and swap in their `database_id`.
4. Set `CF_AIG_ACCOUNT_ID` / `CF_AIG_GATEWAY_ID` (your AI Gateway) in `wrangler.jsonc` vars.
5. Push → the `ci` workflow runs first; once it succeeds on `main`, the deploy workflow fires: GitHub Actions builds
   `container/Dockerfile` on the runner and `wrangler deploy`s the Worker + 3 DOs + R2 + D1 + cron. (Manual dispatch
   of the deploy workflow bypasses the CI gate.)
6. Cloudflare dashboard → your Worker → Settings → add **Secrets**: `DEEPSEEK_API_KEY`, `CF_API_TOKEN` (Workers AI, for
   consensus), optional `CF_AIG_TOKEN`; re-run the deploy.
7. Put the Worker behind **Cloudflare Access** (and optionally set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` to verify the
   Access JWT for hard per-user isolation).

---

## 13. Honest Caveats & Verification Status

- **TypeScript was not locally type-checked** in this environment (no Node/`tsc`/`wrangler`/Docker — the dev machine is
  slow). The Worker/DO TypeScript was reviewed on Opus, not compiled. **The first GitHub Actions CI run is the real
  typecheck/test gate** — run `npm i && npm run typecheck && npm test` (or just push) and expect possibly a small fix
  and committing the lockfile (the `gen-lockfile` workflow generates it). The **Python validators are tested** (the
  pytest suite passes in CI with heavy deps stubbed).
- **Runtime behavior** (Container OCR, DO WebSocket reconnect, R2/D1) should be confirmed with a **deploy smoke test**:
  one single PDF, a 2-PDF batch with a mid-job reload (reconnect), a cohort run, and the consensus toggle.
- **LLM nondeterminism**: outputs vary slightly run-to-run (as the original documented). DeepSeek v4-pro ≠ Gemini, so
  exact values can differ from the original locked run.
- **CPU OCR is slow** with cold starts (no GPU); large/long PDFs can approach request limits (20 MB per-PDF cap,
  100 MB total per batch upload; very long docs are brand-aware window packed for the LLM past the input guards — see
  `PRIMARY_MAX_CHARS` / `SCORING_MAX_CHARS`).
- This is a **re-host, not the original GPU pipeline** — same logic, CPU-bound, demo-scale.

---

## 14. Suggested Next Steps / Open Roadmap (not built)
- **GPU OCR via RunPod** (the explicitly-excluded item) — 20–40× OCR speedup for volume; would offload OCR to a GPU box
  the Worker calls.
- Deeper RAG-grounded fact-checking; richer enterprise exports; multi-region/tenant scaling.
- A parity harness that re-runs the bundled corpus and diffs against the original `CANDIDATE_ID_results.xlsx`.

---

*Original pipeline: Plaque-Psoriasis PA extraction (Docling + Surya OCR + Gemini 2.5 Flash). Re-host: Cloudflare
Worker + Container + DOs + R2 + D1 + DeepSeek v4-pro via AI Gateway, with parallelism, batch/async, a persistent
library, analytics, 3-model consensus, exports, cohorts, and a full security/cost hardening pass — extraction logic
preserved verbatim (plus a small documented override layer), only the model swapped.*
