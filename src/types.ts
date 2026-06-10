/**
 * types.ts — the type-safe contract between the Worker and the container.
 *
 * These interfaces mirror the JSON the container (container/app.py +
 * container/pipeline/core.py) produces. They are the single TS source of truth
 * for the shapes the Worker touches.
 *
 * IMPORTANT — streaming boundary:
 *   The /api/analyze response is an NDJSON event stream. The Worker passes it
 *   through UNBUFFERED and NEVER JSON-parses it (see src/index.ts). The
 *   `AnalyzeEvent` union below documents that stream for *clients* (and tests),
 *   but the Worker itself does not decode it — typing it here does not change the
 *   passthrough behaviour.
 *
 * The only JSON the Worker may safely type/validate is the tiny /api/health
 * payload (`HealthResponse`) and the static /api/brands answer (`BrandsResponse`).
 */

/**
 * The 15 in-scope brands (exact, uppercase). Mirrors core.ALL_BRANDS and the
 * BRANDS const in src/index.ts.
 */
export type Brand =
  | "TREMFYA"
  | "STELARA"
  | "COSENTYX"
  | "SKYRIZI"
  | "ENBREL"
  | "OTEZLA"
  | "BIMZELX"
  | "SILIQ"
  | "ILUMYA"
  | "CIMZIA"
  | "AMJEVITA"
  | "REMICADE"
  | "OTULFI"
  | "YESINTEK"
  | "ACITRETIN";

/** The Access Score is always one of these five buckets. */
export type AccessScore = 0 | 25 | 50 | 75 | 100;

/**
 * The 15-column deliverable result, keyed by the exact Submissions-tab headers
 * (core.FINAL_COLUMNS). `Filename`/`Brand` are echoed back; the 12 extracted
 * params + `Access Score` are the model output. Values are display strings as
 * emitted by the notebooks' CSV column mapping; `Access Score` is a number
 * (one of AccessScore) on the wire.
 */
export interface ResultRow {
  Filename: string;
  Brand: string;
  Age: string;
  "Step Therapy Requirements Documented in Policy": string;
  "Number of Steps through Brands": string;
  "Number of Steps through Generic": string;
  "Step through-Phototherapy": string;
  "TB Test required": string;
  "Quantity Limits": string;
  "Specialist Types": string;
  "Initial Authorization Duration(in-months)": string;
  "Reauthorization Duration(in-months)": string;
  "Reauthorization Required": string;
  "Reauthorization Requirements Documented in Policy": string;
  "Access Score": AccessScore;
}

/** Per-stage wall-clock timings the container reports in `meta.timings_ms`. */
export interface TimingsMs {
  docling_ms: number;
  reduce_ms: number;
  extract_ms: number;
  score_ms: number;
  /** Present only when the source-span (`explain`) pass ran. */
  spans_ms?: number;
}

/** `meta` block attached to every extract/result payload. */
export interface ResultMeta {
  /** "reduced" | "markdown-fallback" | "reduced-error". */
  source: string;
  full_markdown_chars: number;
  reduced_chars: number;
  reduction_pct: number;
  timings_ms: TimingsMs;
  /** Resolved model id (llm.MODEL_ID), e.g. "deepseek-v4-pro". */
  model: string;
  /** Number of repeated extraction+scoring runs (1..5). */
  runs: number;
}

/**
 * Per-field confidence summary, present (per deliverable column) only when
 * `runs > 1`. Keyed by the same display-column names as ResultRow minus
 * Filename/Brand.
 */
export interface FieldConfidence {
  /** Majority normalized value (display string). */
  value: string;
  /** count(majority) / runs, in [0, 1]. */
  agreement: number;
  /** Distinct values seen across runs, first-seen order. */
  distinct: string[];
}

/** confidence map: column display name -> FieldConfidence. Present iff runs>1. */
export type ConfidenceMap = Record<string, FieldConfidence>;

/** Source-span evidence for one deliverable column (explainability pass). */
export interface FieldSpans {
  found: boolean;
  /** Verbatim substrings copied from the focused policy text. */
  quotes: string[];
}

/** spans map: column display name -> FieldSpans. Present iff `explain` is on. */
export type SpansMap = Record<string, FieldSpans>;

/**
 * Per-field model-vs-model agreement for ONE deliverable column (W3 optional
 * cross-check). When consensus is enabled the container runs a SECOND model
 * (Workers AI) ALONGSIDE the canonical DeepSeek extractor and compares the
 * normalized value each produced for the column. `agree` is true when the two
 * normalized values match.
 */
export interface FieldConsensus {
  /** PRIMARY (DeepSeek) normalized value (display string) — the canonical one. */
  primary: string;
  /** SECONDARY (Workers AI) normalized value (display string). */
  secondary: string;
  /** true iff primary === secondary after normalization. */
  agree: boolean;
}

/**
 * consensus map: column display name -> FieldConsensus. Present ONLY when the
 * cross-check (2nd model) ran AND succeeded. Off by default; omitted entirely
 * when consensus is off or the secondary extraction failed (graceful no-op).
 * Keyed by the deliverable columns being compared (Access Score stays
 * primary-only, so it is not included). The canonical `result` is unchanged
 * whether or not this field is present (full backward-compat).
 */
export type ConsensusMap = Record<string, FieldConsensus>;

/**
 * The rich result body POST /extract returns (and that each `result` NDJSON
 * event carries). `confidence` is present only when runs>1; `spans` only when
 * the explain pass ran; `consensus` only when the W3 cross-check (2nd model)
 * ran and succeeded.
 */
export interface ExtractResult {
  result: ResultRow;
  access_justification: string;
  meta: ResultMeta;
  policy_text: string;
  confidence?: ConfidenceMap;
  spans?: SpansMap;
  consensus?: ConsensusMap;
}

/** Error body the container returns for /extract (and the Worker's own errors). */
export interface ErrorResponse {
  error: string;
}

// ── /api/health ──────────────────────────────────────────────────────────────

/** Non-secret LLM config the container reports (llm.selftest_payload). */
export interface LlmSelftest {
  model: string;
  base_url: string;
  key_present: boolean;
  aig_authenticated: boolean;
}

/** GET /api/health (proxied from the container's GET /health). */
export interface HealthResponse {
  ok: boolean;
  warm: boolean;
  warm_error: string | null;
  brands?: string[];
  llm?: LlmSelftest;
}

/**
 * GET /api/health when the container is unreachable: the Worker synthesises this
 * minimal shape (never throws).
 */
export interface HealthDownResponse {
  ok: false;
  warm: false;
  warm_error: string;
}

/** GET /api/brands — answered by the Worker without waking the container. */
export interface BrandsResponse {
  brands: readonly Brand[];
}

// ── /api/analyze NDJSON event union (for clients/tests; NOT parsed by Worker) ─

interface AnalyzeEventBase {
  event: string;
}

/** First event: echoes the accepted request + cache/feature state. */
export interface StartEvent extends AnalyzeEventBase {
  event: "start";
  filename: string;
  brands: string[];
  pdf_sha256: string;
  ocr_cached: boolean;
  runs: number;
  explain: boolean;
}

export interface OcrStartEvent extends AnalyzeEventBase {
  event: "ocr_start";
}

/**
 * Heartbeat emitted while a long stage blocks: ~every 4s during OCR, and during
 * the multi-brand fan-out (`stage: "brands"`). Clients should tolerate any
 * stage value and may show subtle activity; the Worker never parses this.
 */
export interface HeartbeatEvent extends AnalyzeEventBase {
  event: "heartbeat";
  stage: "ocr" | "brands";
  elapsed_ms: number;
}

export interface OcrDoneEvent extends AnalyzeEventBase {
  event: "ocr_done";
  pages: number;
  full_markdown_chars: number;
  docling_ms: number;
  /** true when OCR was served from the OCR-once cache. */
  cached: boolean;
}

export interface BrandStartEvent extends AnalyzeEventBase {
  event: "brand_start";
  brand: string;
}

export interface ReduceDoneEvent extends AnalyzeEventBase {
  event: "reduce_done";
  brand: string;
  source: string;
  reduced_chars: number;
  reduction_pct: number;
  reduce_ms: number;
}

/** Emitted once per extraction run when runs>1 (confidence feature). */
export interface ExtractRunDoneEvent extends AnalyzeEventBase {
  event: "extract_run_done";
  brand: string;
  run: number;
  of: number;
}

export interface ExtractDoneEvent extends AnalyzeEventBase {
  event: "extract_done";
  brand: string;
  extract_ms: number;
}

export interface ScoreDoneEvent extends AnalyzeEventBase {
  event: "score_done";
  brand: string;
  score_ms: number;
}

export interface SpansStartEvent extends AnalyzeEventBase {
  event: "spans_start";
  brand: string;
}

export interface SpansDoneEvent extends AnalyzeEventBase {
  event: "spans_done";
  brand: string;
  spans_ms: number;
}

/** Terminal per-brand event carrying the full result (mirrors ExtractResult). */
export interface ResultEvent extends AnalyzeEventBase, ExtractResult {
  event: "result";
  brand: string;
}

/**
 * Error event. A per-brand failure carries `brand` and the stream continues; a
 * global/fatal failure omits `brand` and ends the stream.
 */
export interface ErrorEvent extends AnalyzeEventBase {
  event: "error";
  brand?: string;
  error: string;
}

/** Final event of a successful stream. */
export interface DoneEvent extends AnalyzeEventBase {
  event: "done";
  total_ms: number;
}

/** Discriminated union of every NDJSON line POST /api/analyze can emit. */
export type AnalyzeEvent =
  | StartEvent
  | OcrStartEvent
  | HeartbeatEvent
  | OcrDoneEvent
  | BrandStartEvent
  | ReduceDoneEvent
  | ExtractRunDoneEvent
  | ExtractDoneEvent
  | ScoreDoneEvent
  | SpansStartEvent
  | SpansDoneEvent
  | ResultEvent
  | ErrorEvent
  | DoneEvent;

// ── Layer 3: async/batch jobs (client/test-facing shapes) ────────────────────
//
// These mirror the JobCoordinator DO (src/job-coordinator.ts). They document the
// /api/jobs surface for clients and tests; the Worker forwards job control to the
// DO and the DO is the source of truth.

/** Status of a job and each of its PDFs. */
export type JobStatus = "pending" | "running" | "complete" | "failed";

/** POST /api/jobs accepted response (202). */
export interface JobCreatedResponse {
  jobId: string;
}

/** Per-PDF progress in a job (GET /api/jobs/:id). */
export interface JobPdfState {
  index: number;
  filename: string;
  status: JobStatus;
  /** Number of per-brand `result` events seen for this PDF so far. */
  results: number;
  error?: string;
}

/** GET /api/jobs/:id — the pollable job state. */
export interface JobState {
  jobId: string;
  status: JobStatus;
  totals: {
    total_pdfs: number;
    completed_pdfs: number;
    failed_pdfs: number;
  };
  config: { brands: string; runs: number; explain: boolean };
  perPdf: JobPdfState[];
  /** Highest seq_num emitted so far (resume the WS stream from here). */
  last_seq: number;
  created_at: number;
}

/**
 * One event on the GET /api/jobs/:id/stream WebSocket. It is exactly a container
 * AnalyzeEvent (or a DO-level event such as {"event":"job_done"}) ENRICHED with
 * the job routing/sequencing fields below. `seq_num` is monotonic per job and is
 * what the client passes back as ?lastSeq=N to replay missed events on reconnect.
 */
export type JobStreamEvent = Record<string, unknown> & {
  /** 0-based index of the PDF in the job; -1 for job-level events (job_done). */
  pdf_index: number;
  /** The PDF's original filename; "" for job-level events. */
  filename: string;
  /** Monotonic per-job sequence number (1-based). */
  seq_num: number;
};

// ── Persistent library (D1 index + R2 full results) ──────────────────────────
//
// Every analysis (single or batch) is persisted to a queryable library so users
// can browse/search past results, share permalinks, and reuse cached results.
// The Worker writes the INDEX/FACET row to D1 (table `analyses`) and the FULL
// result JSON (an ExtractResult) to R2 at results/lib/<id>.json. The library is
// OWNER-scoped: every read/write is bound to the request's Cloudflare Access
// identity (header `cf-access-authenticated-user-email`, falling back to
// "anonymous"). These shapes are the source of truth for src/library.ts.

/** Whether a library row came from a single /api/analyze or a batch job. */
export type LibraryKind = "single" | "batch";

/**
 * One INDEX/FACET row in the D1 `analyses` table (one row per
 * (analysis, pdf, brand) result). Holds only fields used for browsing/searching/
 * faceting; the full result JSON lives in R2 at `result_key`.
 */
export interface LibraryRow {
  /** uuid primary key; also the R2 object id (results/lib/<id>.json). */
  id: string;
  /** Unix epoch ms the row was saved. */
  created_at: number;
  /** Tenant scope: cf-access-authenticated-user-email or "anonymous". */
  owner: string;
  /** "single" (client-saved) | "batch" (DO-saved on finalize). */
  kind: LibraryKind;
  /** Originating job id for batch rows; null for single analyses. */
  job_id: string | null;
  /** Original PDF filename. */
  filename: string;
  /** sha256-hex of the source PDF bytes (the cache key alongside brand/runs/explain). */
  file_sha256: string;
  /** One of the 15 in-scope brands. */
  brand: string;
  /** Access Score bucket (0|25|50|75|100); null if unavailable. */
  access_score: number | null;
  /** ResultRow.Age */
  age: string;
  /** ResultRow["Number of Steps through Brands"] */
  branded_steps: string;
  /** ResultRow["Number of Steps through Generic"] */
  generic_steps: string;
  /** ResultRow["Step through-Phototherapy"] */
  phototherapy: string;
  /** ResultRow["TB Test required"] */
  tb: string;
  /** ResultRow["Quantity Limits"] */
  quantity_limits: string;
  /** ResultRow["Specialist Types"] */
  specialist: string;
  /** ResultRow["Initial Authorization Duration(in-months)"] */
  init_auth: string;
  /** ResultRow["Reauthorization Required"] */
  reauth_required: string;
  /** Repeated extraction+scoring runs (1..5) the result was produced with. */
  runs: number;
  /** 1 if the explainability (source-span) pass ran, else 0. */
  explain: number;
  /** R2 key of the full result JSON: results/lib/<id>.json. */
  result_key: string;
}

/**
 * POST /api/library request body. Persists one or more per-brand results
 * (typically the per-brand `result` events of a single /api/analyze run).
 */
export interface LibrarySaveBody {
  kind: LibraryKind;
  job_id?: string;
  file_sha256: string;
  runs: number;
  explain: boolean;
  /** The full per-brand result payloads (each an ExtractResult). */
  results: ExtractResult[];
}

/** POST /api/library response: a compact descriptor of each saved row. */
export interface LibrarySaveResponse {
  saved: { id: string; brand: string; filename: string }[];
  count: number;
}

/** GET /api/library response: owner-scoped index rows + the total match count. */
export interface LibraryListResponse {
  rows: LibraryRow[];
  total: number;
}

// ── W5: saved cohorts + versioning + webhook ─────────────────────────────────
//
// A COHORT is a named, persistent set of policy PDFs + a fixed analysis config
// ({brands,runs,explain}) + an optional webhook_url + schedule_enabled flag.
// Its PDFs live persistently under R2 cohorts/<cohortId>/<i>.pdf (NOT subject to
// the 7-day job cleanup; deleted only with the cohort). Running a cohort stages
// its PDFs into a NEW batch job (reusing the JobCoordinator path) and records a
// cohort_runs row; each run is a VERSION two of which can be field-compared.
// These shapes are owner-scoped (cf-access-authenticated-user-email). Source of
// truth for src/cohorts.ts. All reuse the SAME LIBRARY D1 + RESULT_BUCKET R2.

/** D1 `cohorts` row — a saved, persistent cohort owned by one tenant. */
export interface CohortRow {
  /** uuid primary key. */
  id: string;
  /** Tenant scope: cf-access-authenticated-user-email or "anonymous". */
  owner: string;
  /** Human-readable cohort name. */
  name: string;
  /** Unix epoch ms the cohort was created. */
  created_at: number;
  /** CSV of brands the cohort runs (the container `brands` field). */
  brands: string;
  /** Repeated extraction+scoring runs (1..5). */
  runs: number;
  /** 1 if the explainability (source-span) pass runs, else 0. */
  explain: number;
  /** Validated https webhook URL POSTed a summary on finalize; null if unset. */
  webhook_url: string | null;
  /** 1 if the daily cron re-runs this cohort, else 0 (off by default). */
  schedule_enabled: number;
  /** Number of persistent PDFs stored for this cohort. */
  pdf_count: number;
}

/** D1 `cohort_pdfs` row — one persistent PDF in a cohort (R2 cohorts/<id>/<idx>.pdf). */
export interface CohortPdfRow {
  cohort_id: string;
  idx: number;
  filename: string;
  /** R2 key of the persistent PDF: cohorts/<cohort_id>/<idx>.pdf. */
  r2_key: string;
}

/** D1 `cohort_runs` row — one VERSION (run) of a cohort, linked to a batch job. */
export interface CohortRunRow {
  /** uuid primary key (the run id). */
  id: string;
  cohort_id: string;
  owner: string;
  created_at: number;
  /** The batch jobId this run staged + drove. */
  job_id: string;
  /** "running" | "complete" | "failed" — mirrors the job's terminal status. */
  status: string;
  /** JSON summary the DO wrote on finalize (totals + per-brand scores); null until then. */
  summary_json: string | null;
}

/** POST /api/cohorts request body — create a cohort from a finished batch job. */
export interface CohortCreateBody {
  name: string;
  source_job_id: string;
  /** Optional overrides; default to the source job's config. */
  brands?: string;
  runs?: number;
  explain?: boolean;
}

/** A cohort's most-recent run, surfaced in the list view. */
export interface CohortLastRun {
  run_id: string;
  created_at: number;
  job_id: string;
  status: string;
  summary: unknown;
}

/** GET /api/cohorts list item (a CohortRow projected for the client + last run). */
export interface CohortListItem {
  id: string;
  name: string;
  created_at: number;
  brands: string;
  runs: number;
  explain: boolean;
  webhook_url: string | null;
  schedule_enabled: boolean;
  pdf_count: number;
  last_run: CohortLastRun | null;
}

/** GET /api/cohorts response. */
export interface CohortListResponse {
  cohorts: CohortListItem[];
}

/** PATCH /api/cohorts/:id request body — only the provided fields are updated. */
export interface CohortPatchBody {
  name?: string;
  brands?: string;
  runs?: number;
  explain?: boolean;
  /** null or "" clears the webhook; otherwise must pass the https SSRF guard. */
  webhook_url?: string | null;
  schedule_enabled?: boolean;
}

/** POST /api/cohorts/:id/run response (202): the new job + run ids. */
export interface CohortRunResponse {
  jobId: string;
  runId: string;
}

/** One run in GET /api/cohorts/:id/runs. */
export interface CohortRunSummary {
  run_id: string;
  created_at: number;
  job_id: string;
  status: string;
  summary: unknown;
}

/** GET /api/cohorts/:id/runs response. */
export interface CohortRunsResponse {
  runs: CohortRunSummary[];
}

/** One changed/added/removed (filename,brand,field) cell in a version compare. */
export interface CohortCompareChange {
  filename: string;
  brand: string;
  /** Deliverable column name, or "(present)" when a (filename,brand) pair only
   * exists in one of the two runs. */
  field: string;
  /** Value in run A (null when the field/pair is absent in A). */
  a: string | null;
  /** Value in run B (null when the field/pair is absent in B). */
  b: string | null;
}

/** GET /api/cohorts/:id/compare?a=&b= response — the field-level version diff. */
export interface CohortCompareResponse {
  cohort_id: string;
  a: { run_id: string; job_id: string };
  b: { run_id: string; job_id: string };
  changes: CohortCompareChange[];
  changed_count: number;
  unchanged_count: number;
  only_in_a: number;
  only_in_b: number;
  pairs_compared: number;
}

/**
 * The best-effort JSON summary the JobCoordinator POSTs to a cohort run's
 * webhook_url on finalize (and stores in cohort_runs.summary_json). SSRF-guarded
 * (https + non-private host) before the POST. Webhook failure NEVER fails the job.
 */
export interface CohortWebhookSummary {
  cohort_id: string;
  run_id: string;
  job_id: string;
  status: JobStatus;
  totals: {
    total_pdfs: number;
    completed_pdfs: number;
    failed_pdfs: number;
  };
  /** Per-brand average Access Score across the run's PDFs. */
  per_brand_access: Record<string, number>;
}
