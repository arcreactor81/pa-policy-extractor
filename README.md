# PA Policy Extractor

![ci](https://github.com/arcreactor81/pa-policy-extractor/actions/workflows/ci.yml/badge.svg)

A Cloudflare-hosted tool that reads a payer **Prior Authorization (PA) policy PDF** for a plaque-psoriasis (PsO) brand, OCRs it, and extracts a structured PA profile plus a 0–100 **Access Score**. A Cloudflare **Worker** serves the dashboard UI and a small JSON API; the heavy lifting (Docling + Surya OCR on CPU, a brand-focused text reducer, and DeepSeek v4-pro reasoning via Cloudflare AI Gateway) runs inside a Cloudflare **Container** that the Worker proxies to. It is a faithful re-host of an existing hackathon pipeline: the original notebooks are reused verbatim so the prompts and validators are byte-identical — the LLM call was swapped from Gemini to DeepSeek v4-pro, plus a small set of documented accuracy overrides (see the [Override layer](#override-layer-deliberate-divergences)).

> Deep dive — original-vs-rehost change log, design decisions, and engineering process: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

## Architecture

```
                                      ┌────────────────────────────────────────────┐
                                      │            Cloudflare edge                 │
                                      │                                            │
  ┌─────────┐   HTTPS                 │   ┌────────────────────┐                   │
  │ Browser │ ───────────────────────────▶│  Worker (src/...)  │                   │
  │  (UI)   │ ◀───────────────────────────│  • serves public/  │                   │
  └─────────┘   dashboard + JSON      │   │  • proxies /api/*  │                   │
                                      │   └─────────┬──────────┘                   │
                                      │             │ Durable Object               │
                                      │             │ binding PA_CONTAINER         │
                                      │             ▼                              │
                                      │   ┌─────────────────────────────────────┐  │
                                      │   │  Container "PaContainer" :8080      │  │
                                      │   │  Flask service (container/app.py)   │  │
                                      │   │   1. Docling + Surya OCR (CPU)      │  │
                                      │   │   2. brand reducer  -> focused text │  │
                                      │   │   3. DeepSeek extraction (12 params)│  │
                                      │   │   4. DeepSeek access scoring        │  │
                                      │   └───────────────┬─────────────────────┘  │
                                      └───────────────────┼────────────────────────┘
                                                          │ HTTPS (OpenAI-compatible)
                                                          ▼
                                          ┌───────────────────────────────┐
                                          │   Cloudflare AI Gateway       │
                                          │   /deepseek/chat/completions  │
                                          └───────────────┬───────────────┘
                                                          ▼
                                              ┌───────────────────────┐
                                              │   DeepSeek v4-pro     │
                                              └───────────────────────┘
```

The browser only ever talks to the Worker. The Worker serves the static dashboard from `public/` (via the `ASSETS` binding) and forwards `/api/*` requests to the container through the `PA_CONTAINER` Durable Object binding. The container makes the outbound LLM call to DeepSeek, routed through the Cloudflare AI Gateway (with a direct `api.deepseek.com` fallback when the gateway vars are absent).

Two further Durable Objects support the higher layers: a **`RateLimiter`** (per-IP request throttling) and a **`JobCoordinator`** (async/batch jobs — results persist to an **R2** bucket and stream back over a reconnectable WebSocket). A **D1** database (`LIBRARY`) backs the persistent analysis **library**, the response **cache**, and saved **cohorts**; the full result JSON for each library entry lives in the same R2 bucket. A daily **cron** (`scheduled()`) prunes the library and re-runs opted-in cohorts. A Cloudflare **Workflow** (`web-check`) runs the advisory **live web check** (payer-page + FDA-label cross-check) with durable per-step retries, persisting its verdicts to the same R2 bucket.

## Why this shape

- **Docling + Surya OCR need PyTorch.** They can't run inside a Cloudflare Worker (no native ML runtime), so OCR and document parsing live in a **Container**, which can run a full CPU PyTorch stack. The Worker is the thin, always-on front door.
- **DeepSeek v4-pro is text-only.** The reasoning model can't see the PDF's images or scanned pages, so **OCR must run first** to turn the PDF into text. Docling produces markdown + a structured document; the reducer narrows it to the brand- and PsO-relevant passages before the model reads it.
- **Worker ⇄ Container split** keeps the latency-sensitive UI/API on the edge while the slow, memory-heavy ML work is isolated in a container that sleeps when idle (`sleepAfter: "3m"`).

## What it extracts

For each (PDF, brand) the model extracts **13 policy parameters** (alongside the `Filename` and `Brand` you supplied) and then assigns an **Access Score**:

| # | Parameter | Notes |
|---|-----------|-------|
| 1 | Age | |
| 2 | Step Therapy Requirements Documented in Policy | |
| 3 | Number of Steps through Brands | `"No"`, `"NA"`, or an integer-as-string |
| 4 | Number of Steps through Generic | `"No"`, `"NA"`, or an integer-as-string |
| 5 | Step through-Phototherapy | `"Yes"` / `"No"` / `"NA"` |
| 6 | TB Test required | `"Yes"` / `"No"` / `"NA"` |
| 7 | Quantity Limits | |
| 8 | Specialist Types | |
| 9 | Initial Authorization Duration (in months) | number, `"Unspecified"`, or `"NA"` |
| 10 | Reauthorization Duration (in months) | number, `"Unspecified"`, or `"NA"` |
| 11 | Reauthorization Required | `"Yes"` / `"No"` / `"NA"` |
| 12 | Reauthorization Requirements Documented in Policy | |
| 13 | Access Score | see scale below (with one-sentence justification) |

### Access Score scale

| Score | Meaning |
|-------|---------|
| **0** | Not covered for PsO |
| **25** | Restricted — hurdles beyond the FDA label |
| **50** | Parity with the label |
| **75** | Preferred / broader than the label |
| **100** | Fully open access (no PA / UM) |

The score is always one of `{0, 25, 50, 75, 100}`, accompanied by a one-sentence `access_justification`. A deterministic coverage-boundary check overrides the model when needed (e.g. a covered drug can't score 0).

### In-scope brands

`TREMFYA`, `STELARA`, `COSENTYX`, `SKYRIZI`, `ENBREL`, `OTEZLA`, `BIMZELX`, `SILIQ`, `ILUMYA`, `CIMZIA`, `AMJEVITA`, `REMICADE`, `OTULFI`, `YESINTEK`, `ACITRETIN`

## Capabilities

- **Single-PDF live analysis** — upload one PDF, pick one or more brands, and watch the OCR → reduce → extract → score stages stream in live (NDJSON); result cards render as they arrive.
- **Multi-brand in parallel** — the PDF is OCR'd **once** (cached by content hash) and all selected brands are analyzed **concurrently**, so 15 brands take roughly the time of one. Re-analyzing the same PDF for another brand reuses the cached OCR.
- **Confidence / variance** *(optional `runs`)* — run extraction several times to surface per-field agreement and flag low-confidence values. Interactive uploads that omit `runs` default to a **single run** (`CONFIDENCE_RUNS`, env, default `"1"`) so they stay fast and cheap; the dashboard's **Deep-Confidence toggle** and the accuracy-first paths (batch jobs, library saves, cohort re-runs) send `runs=3` explicitly for majority-vote accuracy — roughly 3× the extraction/scoring LLM calls per brand.
- **Source-span evidence** *(optional `explain`)* — a separate pass returns the verbatim policy quote supporting each extracted value (it drops any quote that isn't a literal substring, so evidence can't be hallucinated).
- **Batch mode (async, resilient, shareable)** — submit many PDFs as one **job** backed by a `JobCoordinator` Durable Object: it processes them with bounded concurrency, streams progress over a **reconnectable WebSocket** (close the tab and return via the `#job-<id>` URL — nothing is lost, missed events replay from `lastSeq`), persists results to **R2**, and auto-deletes them after a retention window. A PDF whose every brand fails is reported as **failed** (with the per-brand errors) — never as complete-with-empty-results.
- **Multi-model consensus** *(the "Cross-check" toggle — **ON by default** in the UI)* — the dashboard ships with the "Cross-check" toggle (the `consensus` form field) checked, so by default each brand is *also* extracted by one or more **Workers AI validator models** (default **GPT-OSS 20B + Mistral Small 3.1 24B**, configurable via `VALIDATOR_MODELS`) **in parallel** with the canonical DeepSeek pass, surfacing per-field model-vs-model agreement. DeepSeek stays the canonical result; the validators only add an advisory `consensus` map. Requires the `CF_API_TOKEN` secret — without it, consensus silently no-ops (see below).
- **Live web check (advisory)** — after an analysis, cross-check one brand's 13 extracted params against **live sources**: the payer's current policy web page (optional URL, rendered headlessly to markdown via Cloudflare **Browser Rendering**) and the brand's **FDA label** (openFDA). A Cloudflare **Workflow** orchestrates fetch → compare → persist with **durable per-step retries**; one DeepSeek call produces per-param verdicts (`confirmed` / `discrepancy` / `updated` / `not_found`) with **verbatim quotes** (server-verified substrings of the fetched text — the same anti-hallucination contract as source spans) plus an FDA age-consistency read. Verdicts persist to R2 and are **purely advisory** — the stored analysis is never modified. The payer-page fetch needs the `CF_API_TOKEN` secret to carry the **"Browser Rendering: Edit"** scope; without it the check degrades gracefully to FDA-label-only.
- **Persistent library** — save any Single or Batch result to a **queryable library** (full JSON in R2, a lean index row in D1). Browse and **search** by brand/filename, open a **permalink** to any saved analysis, and reuse a **response cache** (`/api/library/lookup`) that returns the most-recent matching analysis instead of re-running the pipeline. Auto-pruned after `LIBRARY_RETENTION_DAYS`.
- **Saved cohorts (versioned, schedulable)** — turn a finished batch into a named **cohort**, then **re-run** it on demand (or on the daily cron) to produce **versioned runs** you can **diff field-by-field** (`/compare`). Each run can fire an outbound **webhook** (SSRF-guarded). The daily re-run is **off by default** per cohort (`schedule_enabled`).
- **Analytics & exports** — a brand-vs-brand **barrier heatmap**, **cross-payer benchmarking** (one brand aggregated across many payers in the library), and **exports** to print/**PDF**, an illustrative **FHIR R4** bundle, and **CSV**/JSON — all derived in the browser, so they add no LLM or container cost.
- **Built-in safeguards** — per-IP rate limiting (a `RateLimiter` Durable Object), a per-request LLM-call budget (`MAX_LLM_CALLS`), a 20 MB per-PDF body cap (batch uploads additionally capped at 100 MB total — the Worker memory limit), prompt-injection delimiting of the untrusted policy text, SSRF-guarded cohort webhooks, and a strict Content-Security-Policy + security headers.
- **Cost monitoring** — every DeepSeek call routes through your Cloudflare AI Gateway, tagged with `cf-aig-metadata` (brand + feature) for per-call cost attribution. With the gateway vars set, the **Workers AI validator calls route through the same gateway** too — so a single gateway budget/spend limit caps both (see [Hard spend cap](#hard-spend-cap-5mo)).

## API endpoints

All under `/api/`, served by the Worker (rate-limited where it matters, behind the security headers):

| Method & path | Purpose |
|---|---|
| `GET /api/brands` | the 15 in-scope brands |
| `GET /api/health` | container liveness + resolved (non-secret) LLM config |
| `POST /api/analyze?route=<sha256>` | single PDF, **streaming NDJSON** (multipart `file` + `brands` csv + optional `runs`/`explain`); `route` is the client-computed PDF hash for sticky OCR-cache routing |
| `POST /api/extract` | single PDF + single `brand`, non-streaming JSON |
| `POST /api/jobs` | submit a **batch** (1..N PDFs + `brands` + `runs`/`explain`/`consensus`) → `202 {jobId}` |
| `GET /api/jobs/:id` | poll job state |
| `GET /api/jobs/:id/stream?lastSeq=N` | **WebSocket**: live events + replay from `lastSeq` |
| `GET /api/results?jobId=...` | the finished batch results JSON (streamed from R2) |
| `POST /api/library` | persist per-brand results to the **library** (full JSON → R2, lean index row → D1) |
| `GET /api/library` | owner-scoped browse/**search** (brand + filename `q` facets, paging) |
| `GET /api/library/:id` | owner-checked **permalink**: stream one saved result's full JSON from R2 |
| `GET /api/library/lookup?sha=&brand=&runs=&explain=` | **response cache**: most-recent matching analysis → full JSON (skip a re-run) |
| `GET /api/cohorts` / `POST /api/cohorts` | list / create a **saved cohort** (a named PDF set built from a finished batch job) |
| `PATCH /api/cohorts/:id` / `DELETE /api/cohorts/:id` | update (name, brands, runs, explain, webhook, schedule) / delete |
| `POST /api/cohorts/:id/run` | re-run the cohort as a **new versioned batch job** → `202` |
| `GET /api/cohorts/:id/runs` | list the cohort's runs (versions), newest first |
| `GET /api/cohorts/:id/compare?a=&b=` | **field-level version diff** between two runs |
| `POST /api/webcheck` | start an **advisory live web check** (one brand's extracted params vs the payer's live policy page + FDA label, via a Cloudflare **Workflow**) → `202 {id}` |
| `GET /api/webcheck/status?id=...` | poll the web-check Workflow **instance status** |
| `GET /api/webcheck?sha=...&brand=...` | the persisted web-check **verdict JSON** (owner-checked; 404 until the check finishes) |

All `/api/library` and `/api/cohorts` routes, plus the `/api/webcheck` verdict read, are **tenant-scoped** to the caller's identity (see [Access control & tenant isolation](#access-control-tenant-isolation--abuse-protection)).

**Client-side analytics & exports** (built in the browser over Single / Batch / Library results — no extra API routes): a **brand-vs-brand barrier heatmap**, **cross-payer benchmarking** (aggregate one brand across many payers in the library), library **search**, and **exports** to **print/Save-as-PDF**, an *illustrative* **FHIR R4** bundle, and **CSV** (original 15-column schema) / JSON.

## Prerequisites

- A **Cloudflare Workers Paid** plan (Containers require it).
- A **GitHub repository** for this code — deployment is **push-to-deploy via GitHub Actions**, so you need **no local Docker, Node, or Wrangler**. The container image is built in the cloud on the Actions runner.
- A **Cloudflare API token** (with Workers + Containers deploy permissions) and your **Cloudflare account ID**.
- A **DeepSeek API key**.
- *(Optional but recommended)* a **Cloudflare AI Gateway** to route, cache, and observe the DeepSeek calls.

> You don't build anything locally — `git push` triggers the image build + deploy in CI.

## Setup & deploy

1. **(Optional) Create a Cloudflare AI Gateway.** In the Cloudflare dashboard → **AI** → **AI Gateway**, create a gateway and note its **account ID** and **gateway ID**. The container builds this endpoint:

   ```
   https://gateway.ai.cloudflare.com/v1/<CF_AIG_ACCOUNT_ID>/<CF_AIG_GATEWAY_ID>/deepseek/chat/completions
   ```

   If you skip this, the container falls back to `https://api.deepseek.com`.

2. **Set the plain (non-secret) gateway vars** in `wrangler.jsonc` so they are forwarded into the container:

   ```jsonc
   "vars": {
     "CF_AIG_ACCOUNT_ID": "<your-account-id>",
     "CF_AIG_GATEWAY_ID": "<your-gateway-id>",
     "DEEPSEEK_MODEL": "deepseek-v4-pro",
     "DEEPSEEK_THINKING": "on",
     "DEEPSEEK_REASONING_EFFORT": "high",

     // Multi-model consensus: the Workers AI VALIDATOR model(s) used when the
     // "Cross-check" toggle is on (it ships CHECKED in the UI). DeepSeek stays
     // canonical; these only add a model-vs-model agreement check. VALIDATOR_MODELS
     // is a CSV of "@cf/..." ids (default = GPT-OSS 20B + Mistral Small 3.1 24B,
     // so DeepSeek + 2 validators = a 3-model consensus); SECONDARY_MODEL is the
     // legacy single-validator id, inert while VALIDATOR_MODELS is set. Both reuse
     // CF_AIG_ACCOUNT_ID (+ CF_AIG_GATEWAY_ID) for the Workers AI endpoint. The
     // CF_API_TOKEN *secret* (below) is what actually turns it on — without it,
     // consensus silently no-ops.
     "VALIDATOR_MODELS": "@cf/openai/gpt-oss-20b,@cf/mistralai/mistral-small-3.1-24b-instruct",
     "SECONDARY_MODEL": "@cf/openai/gpt-oss-20b",

     // tunable cost / throughput knobs (defaults shown — fine to leave as-is)
     "MAX_LLM_CALLS": "200",           // per-request LLM-call budget (fits the worst legal request: 15 brands x (2x3 deep runs + 1 spans + 2 validators x 3 runs) = 195)
     "CONFIDENCE_RUNS": "1",           // default runs when `runs` is omitted (interactive fast default; the UI's Deep-Confidence toggle / batch paths send runs=3 explicitly)
     "MAX_PDFS_PER_JOB": "25",         // batch-job size cap
     "MAX_CONCURRENT_PDFS": "2",       // batch concurrency (<= container max_instances)
     "RETENTION_DAYS": "7",            // batch (R2 + DO) results auto-delete window
     "LIBRARY_RETENTION_DAYS": "30"    // persistent-library auto-prune window (daily cron)
   }
   ```

   `wrangler.jsonc` also sets the container `instance_type` (`standard-4`), `max_instances` (`3`), and `Container.sleepAfter` (`3m`) — the main cost levers. Lower `max_instances` / `sleepAfter` to spend less; raise them for more throughput.

3. **Add the GitHub Actions deploy secrets** (repo → **Settings → Secrets and variables → Actions**):

   - `CLOUDFLARE_API_TOKEN` — a token with Workers + Containers deploy permissions.
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

4. **R2 bucket + D1 database — already provisioned for this account.** The **`pa-job-results`** R2 bucket and the **`pa-library`** D1 database already exist in the operator's Cloudflare account, and the D1 **Database ID is already wired into `wrangler.jsonc`** (`d1_databases[0].database_id`) — nothing to do here before the first deploy.

   **Forks deploying to a different account** must create their own (one-time — **both must exist before the first deploy**; the deploy fails otherwise) and swap in their own Database ID:

   - **R2 bucket:** Cloudflare dashboard → **R2 → Create bucket** → name it exactly **`pa-job-results`**. Batch jobs store PDFs + results here, and it also holds the persistent-library full-result JSON (`results/lib/<id>.json`). *(The `JobCoordinator` auto-deletes each job's objects after `RETENTION_DAYS`; an optional R2 Object-Lifecycle rule on the `pdfs/` + `results/` prefixes is extra insurance.)*
   - **D1 database:** Cloudflare dashboard → **Workers & Pages → D1 → Create database** → name it exactly **`pa-library`**. Then copy its **Database ID** and paste it into `wrangler.jsonc` → `d1_databases[0].database_id`, replacing this account's id. This database backs the persistent analysis library, the response cache, and saved cohorts (the `analyses` + `cohorts` tables; schema is created lazily at runtime, so there is no `wrangler d1 migrations` step).

   Both R2 and D1 are on the Workers Paid included tiers, so this stays subscription-bounded.

5. **Push to `main` to deploy.** Every push first runs the **ci** workflow (`.github/workflows/ci.yml`); once that CI run **succeeds on `main`**, the **deploy** workflow (`.github/workflows/deploy.yml`) fires automatically on the GitHub runner (which has Docker): it builds `container/Dockerfile`, pushes the image to Cloudflare's managed registry, and deploys the Worker plus its Durable Objects (`PaContainer`, `RateLimiter`, `JobCoordinator`) and the `RESULT_BUCKET` R2 binding. A commit that fails CI is never deployed. You can also run the deploy on demand from **Actions → deploy → Run workflow** — the manual path deliberately bypasses the CI gate (an escape hatch for e.g. re-deploying after a secrets change).

6. **Set the `DEEPSEEK_API_KEY` Worker secret.** Because you don't run Wrangler locally, add it in the **Cloudflare dashboard**: **Workers & Pages → your Worker → Settings → Variables and Secrets → add Secret** (`DEEPSEEK_API_KEY`, plus `CF_AIG_TOKEN` if your gateway is authenticated). The Worker must exist first, so run step 5 once, add the secret, then re-deploy (push again or **Re-run jobs**). Worker secrets persist across deploys and never live in the image or the repo.

   **Enable multi-model consensus (the UI ships with "Cross-check" ON).** The dashboard's "Cross-check" toggle is **checked by default**, so to make it actually run, add one more Worker **secret** in the same place: `CF_API_TOKEN` — a **Cloudflare account API token scoped to Workers AI** (`Workers AI → Read`, plus `Edit` for full functionality; create it under **Manage Account → API Tokens**). This is a *Cloudflare* token, **not** a DeepSeek/provider key, and it is a dashboard secret — it is intentionally **not** in `wrangler.jsonc`. With it set, an enabled request *also* extracts with each model in `VALIDATOR_MODELS` (Workers AI, OpenAI-compatible; default GPT-OSS 20B + Mistral Small 3.1 24B, so DeepSeek + 2 validators form a **3-model consensus**), routed through the AI Gateway's Workers AI endpoint `https://gateway.ai.cloudflare.com/v1/<CF_AIG_ACCOUNT_ID>/<CF_AIG_GATEWAY_ID>/workers-ai/v1/chat/completions` when the gateway vars are set (so the gateway's spend cap covers the validators too; the direct `https://api.cloudflare.com/client/v4/accounts/<CF_AIG_ACCOUNT_ID>/ai/v1` REST base is the no-gateway fallback), and surfaces per-field model-vs-model agreement. **If `CF_API_TOKEN` is absent, consensus silently no-ops** — the canonical DeepSeek result still returns unchanged, so the analysis never fails for lack of the token.

   **Enable the live web check's payer-page fetch (same token, one more scope).** The advisory **live web check** reuses this same `CF_API_TOKEN` secret to call the **Browser Rendering REST API** (`/browser-rendering/markdown`) when a payer policy URL is supplied — add the **`Browser Rendering → Edit`** permission to the token to enable it. Without that scope (the API answers 403) the web check **degrades gracefully**: the payer-page half is skipped with a note in the verdict and the FDA-label half still runs.

   > **Validation runs in CI, not locally.** Every push/PR triggers `.github/workflows/ci.yml` — the Python container tests (verbatim validators + aggregation/explain logic, heavy deps stubbed) and the Worker typecheck + vitest. That CI is the real correctness gate, and the **deploy workflow only fires after it succeeds on `main`**. A weekly scheduled CI job additionally installs the **real** torch/docling/surya stack (pinned by `container/constraints.txt`, generated via the `gen-pylock` workflow) and runs the suite unstubbed, including the docling-gated converter test.

### How the env reaches the container

The Worker's `Container` subclass forwards these variables into the container process via `envVars`, so the Flask service can read them as normal process env:

```
DEEPSEEK_API_KEY      (secret)
CF_AIG_TOKEN          (secret, optional)
CF_API_TOKEN          (secret, optional — consensus enabler; absent => consensus no-ops)
CF_AIG_ACCOUNT_ID                          # reused as the Workers AI account id
CF_AIG_GATEWAY_ID
DEEPSEEK_MODEL
DEEPSEEK_THINKING
DEEPSEEK_REASONING_EFFORT
VALIDATOR_MODELS                           # consensus validator list (CSV of @cf/... ids)
SECONDARY_MODEL                            # legacy single-validator id (compat)
CONFIDENCE_RUNS                            # default extraction repeats when `runs` is omitted (default "1" — interactive fast path; Deep-Confidence/batch send runs=3 explicitly)
REDUCER_PASSTHROUGH_CHARS                  # reducer full-document passthrough threshold (default "100000")
SCORING_MAX_CHARS                          # policy-text cap for scoring + consensus validators (default "300000")
PRIMARY_MAX_CHARS                          # policy-text guard for primary extraction/spans (default "600000"; huge docs window-pack beyond it)
WINDOW_PACK_BUDGET                         # assembly budget for unique window-packs (default "360000" — cache-miss prefill latency control)
```

`LIBRARY_RETENTION_DAYS` and `RETENTION_DAYS` are read by the **Worker** (D1/R2 pruning + batch cleanup), not the container, so they are not in this forwarded set.

### Multi-model consensus cost note

Consensus is **ON by default in the UI** — the "Cross-check" toggle ships checked (sent as the `consensus` form field on `/api/analyze` and `/api/jobs`; untick it to skip). When on, each brand runs extra extractions against the Workers AI validator(s) in `VALIDATOR_MODELS` **in parallel** with the canonical DeepSeek extraction — one validator call per model per run (the per-request `MAX_LLM_CALLS` budget counts the secondary calls and still rejects over-budget requests). Scoring stays DeepSeek-only to bound cost. Workers AI bills in **Neurons**: the free tier includes **10,000 Neurons/day**; beyond that it is **$0.011 / 1,000 Neurons** on the Workers Paid plan — roughly **a cent per validator call** at the median policy size. The default validators (`@cf/openai/gpt-oss-20b`, `@cf/mistralai/mistral-small-3.1-24b-instruct`) were chosen because both have **128k context** on Workers AI (reduced policy texts reach ~75k tokens, and Workers AI hard-errors on oversized input rather than truncating) plus top-tier **JSON-mode reliability** — the previous defaults were unfit (`llama-3.3-70b-instruct-fp8-fast` is 24k-context on Workers AI; `gemma-3-12b-it` was deprecated 2026-05-30). With the gateway vars set, validator calls **route through your AI Gateway**, so the gateway's spend cap and analytics cover them alongside DeepSeek. Untick "Cross-check" (or leave `CF_API_TOKEN` unset, which disables it entirely) for zero validator cost.

## Access control, tenant isolation & abuse protection

The app is **public by default**, protected by a per-IP rate limiter (`RateLimiter` Durable Object, ~15 requests/min) and a per-request LLM-call budget (`MAX_LLM_CALLS`). To restrict it to specific people, put the Worker behind **Cloudflare Access** (Zero Trust → **Access** → add a self-hosted application for the Worker's hostname) — **no code change required**. Behind Access, only authenticated users reach the app, which removes the public economic-DoS surface and leaves the rate limiter as defense-in-depth.

### Tenant isolation REQUIRES Cloudflare Access (or the Access-JWT vars)

The library and cohort APIs are **tenant-scoped**: each row is owned by the caller's identity, derived from the `Cf-Access-Authenticated-User-Email` request header. That header is set by **Cloudflare Access** and is **trustworthy only when Access actually fronts the Worker** — if the Worker is reachable without Access, a client can spoof the header and read or write another tenant's data. **Therefore tenant isolation is only enforced when one of the following is true:**

- **Cloudflare Access fronts the Worker** (recommended): Access injects and validates the identity header, so the per-tenant scoping is sound. This is required for any deployment where the library/cohort data of different users must stay separate.
- **The Access-JWT vars are set** (`ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`): with both set, the Worker independently verifies the `Cf-Access-Jwt-Assertion` token (RS256 signature against `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` with key caching, plus `aud == ACCESS_AUD` and `exp` checks) and derives the owner from the **verified** email; a missing or invalid assertion is rejected with **401**. When these vars are **unset**, the Worker keeps the header-trust behavior above (so it stays usable as a single-tenant public demo).

In short: **do not rely on per-tenant separation unless the Worker is behind Cloudflare Access, or `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` are configured.** A bare public deployment treats all callers as one shared `anonymous` tenant.

Other built-in protections: a 20 MB per-PDF upload cap plus a 100 MB total cap on batch uploads (enforced at the Worker and the container, defeating chunked-body bypass), `Content-Security-Policy` + security headers on every response, SSRF-guarded cohort webhooks (private/loopback/link-local targets are rejected), and prompt-injection delimiting of the untrusted policy text (the verbatim extraction/scoring prompts are unchanged — only the data is fenced).

## Local development (optional)

Local dev is **not required** — the project is built and validated in the cloud. If you *do* have Docker and a capable machine, you can run the full stack locally:

```bash
cp .dev.vars.example .dev.vars   # then fill in your real values
npx wrangler dev                 # requires local Docker for the container
```

`wrangler dev` reads `.dev.vars` for local secrets/vars. `.dev.vars` is **gitignored** — keep real keys out of version control. In production, secrets live on the Worker (dashboard or `wrangler secret put`), never in `.dev.vars`.

### Running the test suites locally

```bash
npm install            # once
npm run typecheck      # Worker TypeScript
npm test               # Worker vitest suite (runs inside workerd)
pip install pytest requests
npm run test:py        # container suite (pytest container/tests; heavy deps auto-stubbed)
```

## Fidelity note

This is a re-host, not a rewrite. The original hackathon notebooks (`container/notebooks/*.ipynb`) are loaded **verbatim** through an AST notebook-loader (`container/pipeline/notebook_loader.py`), so the prompts (`SYSTEM_PROMPT`, `METHODOLOGY_PROMPT`), validators (`validate_and_normalize`, `consistency_check`), the reducer (`reduce_document`), and the CSV column mapping are byte-identical to the submission. The changes are the model call (`container/pipeline/llm.py`), swapped from Gemini to DeepSeek v4-pro, and the small override layer below. `google-genai` is still installed solely so those notebook cells **import** cleanly when the loader picks up their definitions — it is **never called**; all inference goes to DeepSeek.

### Override layer (deliberate divergences)

The notebook files themselves are never edited — every accuracy fix is applied at runtime by `container/pipeline/overrides.py`, which patches the verbatim-loaded definitions and documents each delta inline. These are **deliberate, auditable divergences** from the validated original, kept in one place precisely so the provenance claim above stays honest:

- **PsO regex case fix** — the reducer's bare `\bPsO\b` relevance pattern is case-sensitive in the original (unlike its `psoriasis` siblings), which makes it provably dead against the lowercased text the reducer strategies actually search; the override re-compiles it case-insensitively so `pso` matches.
- **Two-sided relevance guard** — the reducer's output is now sanity-checked from the other side too: a reduced text that lacks the brand, a PsO keyword, or any criteria language is rejected in favour of the full document text (the fallback is observable in the result as `source: "relevance-fallback"`).
- **Clamp → abstain** — the deterministic coverage-boundary check judges coverage over an **extended set of coverage fields** (the original's fields plus Age, Quantity Limits, and the Reauthorization columns), and an apparently-uncovered row with a positive model score is no longer clamped to 0: the model's score is preserved and the row is **flagged for review** (an all-NA extraction could equally be an extraction miss on a covered policy).
- **Named thresholds** — the reduce/score magic numbers are lifted into named, env-overridable knobs: `REDUCER_PASSTHROUGH_CHARS` (default `100000` — documents shorter than this skip reduction and pass through whole, as the original did), `SCORING_MAX_CHARS` (default `300000` — the original scoring loop's policy-text cap, applied to the scoring call and the Workers AI consensus validators, whose 128k-token contexts it fits), and `PRIMARY_MAX_CHARS` (default `600000` — the guard on the primary model's extraction/source-span inputs: small/medium documents reach the model whole; it sits deliberately below DeepSeek v4-pro's 1M-token window because maximal-context prefill measured 10+ minutes per call, and beyond the cap the window packer hands the model the brand-relevant sections instead).
- **Brand-aware window packing** — when a cap fires on an oversized document, the kept text is the document head plus windows around every brand-alias mention (merged in document order) rather than a blind head-cut: blind truncation amputated the per-drug criteria modules that big payer documents keep deep in the file. The applied mode is observable per brand in `meta.truncation` / `meta.scoring_truncation` (`null` | `"alias-windowed"` | `"head"`).

## Limitations

- **CPU OCR is slow.** Surya OCR + Docling run on CPU (Cloudflare Containers have no GPU), so a multi-page policy can take from tens of seconds to a few minutes.
- **Cold starts reload models.** After the container sleeps (`sleepAfter: "3m"`), the next request pays a warm-up cost while the OCR/layout models load back into memory. (A build-time warmup bakes the models into the image so cold starts don't re-download them.)
- **Large/long PDFs may approach request limits.** Very large or very long documents take longer to OCR and can push against request-duration limits; uploads are capped at 20 MB per PDF, and a batch upload at 100 MB total (the Worker memory limit).
- **LLM nondeterminism.** Even at temperature 0.1, DeepSeek output can vary slightly between runs.
- **This is a re-host, not the original GPU pipeline.** It reproduces the original logic on CPU at demo scale; it is not tuned for high-throughput or GPU-accelerated batch processing.
- **Batch jobs are bounded.** `MAX_PDFS_PER_JOB` (25) and `MAX_CONCURRENT_PDFS` (2) cap a job so it stays inside the subscription allotment; bigger batches queue.
- **WebSockets drop on each deploy.** A new deploy closes live job streams; the browser auto-reconnects and replays missed events from `lastSeq`, so nothing is lost.

## Cost & subscription budget

The system is **bounded to the Workers Paid included allotments** for realistic, low-concurrency (Access-gated) use — typically the **$5/mo base with no overage**:

- **Container compute** (the main lever): the container sleeps after **`sleepAfter: "3m"`** idle and `max_instances` is capped at **3**, bounding idle billing and worst-case concurrency. **Multi-brand parallelism adds no container cost** — there's one container per PDF; brands run as threads inside it (OCR'd once).
- **DeepSeek tokens** (the real variable cost): capped per request by **`MAX_LLM_CALLS`** (default 200 — sized so the worst *legal* request fits: all 15 brands with the Deep-Confidence toggle (runs=3), spans, and both validators on is 15 × (2×3 + 1 + 2×3) = **195 calls**; a default interactive upload is far smaller since `CONFIDENCE_RUNS` is `"1"`), and observable/limitable in your **AI Gateway** (rate + spend controls, with `cf-aig-metadata` tagging per brand + feature).
- **Workers AI validators** (the 3-way Cross-check — **ON by default in the UI**): billed in **Neurons**, working out to roughly **a cent per validator call** at the median policy size (`gpt-oss-20b` $0.20/$0.30 per M input/output tokens; `mistral-small-3.1-24b` $0.35/$0.56 per M). A default upload (runs=1, spans on, Cross-check on) spends brands × (2 + 1 + 2) calls, of which the 2 per brand are validators; the **10,000 free Neurons/day** cover light demo use. Validator calls now route **through the AI Gateway**, so the spend cap below applies to them too. Untick Cross-check (or unset `CF_API_TOKEN`) for zero validator cost.
- **Durable Objects + R2** (batch): **WebSocket hibernation** means a connected-but-idle job bills ~zero duration; R2 holds PDFs + results only for `RETENTION_DAYS` (7) before auto-delete — well inside the R2 free tier.
- **Persistent library (D1 + R2)**: the library grows as users save analyses, so it is **auto-pruned** by the daily cron — `analyses` rows (and their `results/lib/<id>.json` objects) older than **`LIBRARY_RETENTION_DAYS`** (default 30) are deleted, bounded per run to stay safe and idempotent. This keeps D1 rows + R2 storage inside the included tiers.
- **Scheduled cron (off by default)**: `triggers.crons` runs once daily (`0 6 * * *`). It performs the library prune and re-runs only the cohorts that **opted in** (`schedule_enabled=1`). With nothing opted in it is an **inert, near-zero-cost** D1 check — no container is woken. Each opted-in cohort that *does* run costs the same as a manual "Run now" (it stages a batch job), which is why per-cohort scheduling is off by default.
- **Tunable knobs** (`wrangler.jsonc`): `sleepAfter`, `max_instances`, `MAX_LLM_CALLS`, `CONFIDENCE_RUNS`, `MAX_PDFS_PER_JOB`, `MAX_CONCURRENT_PDFS`, `RETENTION_DAYS`, `LIBRARY_RETENTION_DAYS`.

### Hard spend cap (~$5/mo)

If you want a true ceiling rather than budget-by-design: Cloudflare dashboard → **AI** → **AI Gateway** → *your gateway* → **Settings** → set a **budget / spend limit** (~$5/month works for demo use) and, optionally, a **rate limit**. Because **both** the DeepSeek primary **and** the Workers AI validators now route through the gateway, this single limit caps **all** LLM spend for the app. Two complementary backstops: DeepSeek is **prepaid**, so its account balance is its own natural ceiling, and the Cloudflare dashboard offers **Workers AI usage alerts/notifications** if you want an early warning before the cap bites.

## License

MIT — see [LICENSE](LICENSE).
