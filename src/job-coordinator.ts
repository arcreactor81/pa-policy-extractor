/**
 * job-coordinator.ts â€” Layer 3: async / batch / persistent jobs.
 *
 * The JobCoordinator is a SQLite-backed Durable Object that owns the lifecycle
 * of a multi-PDF extraction job:
 *
 *   1. The Worker stores each uploaded PDF in R2 (pdfs/<jobId>/<index>.pdf) and
 *      then calls this DO's `start(...)` to kick the job off.
 *   2. The DO processes the PDFs with a small concurrency SEMAPHORE
 *      (MAX_CONCURRENT_PDFS, default 2, always <= container max_instances). For
 *      each PDF it reads the bytes back from R2, builds a multipart body
 *      (file + brands + runs + explain [+ consensus] â€” exactly the fields
 *      container/app.py's POST /analyze expects) and streams the NDJSON response.
 *   3. Every container event is given a monotonic `seq_num`, wrapped with
 *      {pdf_index, filename, seq_num}, appended to the `job_events` SQLite log
 *      AND broadcast to every connected (hibernatable) WebSocket for this job.
 *   4. When all PDFs finish, a persisted finalization state machine commits the
 *      aggregate, library, cohort, webhook, and terminal stages in order.
 *   5. The DO's single alarm slot is multiplexed: while the job is NON-terminal
 *      it is a short-cadence WATCHDOG that resumes processing or finalization
 *      orphaned by a DO restart; once terminal it becomes the retention alarm
 *      (RETENTION_DAYS, default 7) that deletes the job's R2 objects + this DO's
 *      storage. Idempotent.
 *
 * WebSocket streaming uses the HIBERNATION API (acceptWebSocket /
 * getWebSockets / serializeAttachment) so an idle job bills zero duration while
 * a client stays connected. On (re)connect the client passes ?lastSeq=N and we
 * REPLAY every stored event with seq_num > N from SQLite before going live, so a
 * dropped connection (e.g. across a deploy) loses nothing.
 *
 * VERIFIED-DOC GOTCHAS honoured here:
 *   - storage.sql.exec() cursors are consumed SYNCHRONOUSLY (spread into an
 *     array / .toArray() / .one()) BEFORE any `await` â€” a cursor left open
 *     across an await is invalid.
 *   - serializeAttachment is capped (~16KB) â€” we only ever attach the tiny
 *     {jobId,lastSeq} bookkeeping object.
 *   - WebSockets drop on deploy; replay-on-reconnect is the recovery path.
 *   - A DO may make subrequests to the container and read long response streams
 *     (this is I/O, not CPU â€” no CPU-wall limit).
 */

import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Env } from "../worker-configuration";
import type { ExtractResult } from "./types";
import { persistResults } from "./library";
import {
  CONTAINERS_OFFLINE_MESSAGE,
  containersOffline,
  validateWebhookUrl,
} from "./util";

/** Container instance-name prefix â€” mirrors the Worker's sticky routing so the
 * SAME PDF (by sha256) lands on the SAME warm container instance (OCR-once). */
const ROUTE_PREFIX = "pa-";

/** Job lifecycle states persisted in the `jobs` table. */
export type JobStatus = "pending" | "running" | "complete" | "failed";

/** Completed-work cursor for the durable finalization state machine. */
export type FinalizationState =
  | "none"
  | "prepared"
  | "aggregate_committed"
  | "library_committed"
  | "cohort_committed"
  | "webhook_committed"
  | "terminal_committed"
  | "abandoned";

/** The immutable job config captured at submission time (stored as JSON). */
export interface JobConfig {
  /** CSV of brands forwarded to the container's `brands` field. */
  brands: string;
  /** Repeated extraction+scoring runs (1..5) â€” container `runs` field. */
  runs: number;
  /** Source-span explainability pass â€” container `explain` field. */
  explain: boolean;
  /**
   * W3-ext multi-model consensus â€” container `consensus` field. Optional for
   * back-compat with older start payloads (absent = off); only forwarded to the
   * container when true, so consensus-off requests stay byte-identical.
   */
  consensus?: boolean;
  /** One entry per stored PDF, parallel to the R2 index. */
  pdfs: { index: number; filename: string }[];
  /**
   * Tenant scope for the persistent library: the Worker's
   * cf-access-authenticated-user-email (or "anonymous"). Batch results are
   * persisted to THIS owner's library on finalize. Optional for back-compat with
   * older start payloads (defaults to "anonymous").
   */
  owner?: string;

  // â”€â”€ W5 (cohort runs) â€” all optional; absent for a normal /api/jobs batch â”€â”€â”€â”€â”€

  /**
   * Validated https webhook URL to notify on finalize (a cohort run). The DO
   * re-applies the SSRF guard before POSTing. Delivery is a hard finalization
   * gate and is retried with a stable Idempotency-Key until it succeeds.
   */
  webhook_url?: string;

  /** The cohort this run belongs to (used to update the cohort_runs row). */
  cohort_id?: string;

  /** The cohort_runs row id to update with the terminal status + summary. */
  run_id?: string;
}

/** The start() payload the Worker sends after staging PDFs in R2. */
export interface StartJobBody extends JobConfig {
  jobId: string;
}

/**
 * The job-event envelope broadcast over WS and persisted in `job_events`.
 * It is the container's raw NDJSON event object (any of the AnalyzeEvent shapes,
 * PLUS job-level events emitted by this DO) ENRICHED with routing/sequencing:
 *   - pdf_index : which PDF in the job (0-based; -1 for job-level events)
 *   - filename  : that PDF's original filename ("" for job-level events)
 *   - seq_num   : monotonic per-job sequence number (1-based) for replay
 */
export type JobEvent = Record<string, unknown> & {
  pdf_index: number;
  filename: string;
  seq_num: number;
};

/** The per-PDF progress summary surfaced by GET /api/jobs/:id. */
export interface PerPdfState {
  index: number;
  filename: string;
  status: JobStatus;
  /** Active processing attempt for this PDF (starts at 1). */
  attempt: number;
  /** Number of `result` events seen for this PDF (one per brand). */
  results: number;
  /** Populated on a per-PDF failure. */
  error?: string;
}

/** The JSON GET /api/jobs/:id returns (poll fallback for the WS stream). */
export interface JobStateResponse {
  jobId: string;
  status: JobStatus;
  totals: {
    total_pdfs: number;
    completed_pdfs: number;
    failed_pdfs: number;
  };
  config: { brands: string; runs: number; explain: boolean };
  perPdf: PerPdfState[];
  /** Highest seq_num emitted so far (clients can resume from here). */
  last_seq: number;
  created_at: number;
  /** Present once durable finalization has started. */
  finalize_state?: FinalizationState;
  /** Sanitized diagnostic for the most recent finalization failure. */
  finalize_error?: string;
}

/** The aggregated results document written to R2 results/<jobId>.json. */
export interface JobResults {
  jobId: string;
  created_at: number;
  finished_at: number;
  config: { brands: string; runs: number; explain: boolean };
  /** Per-PDF: the container `result` event payloads collected for that PDF. */
  pdfs: {
    index: number;
    filename: string;
    status: JobStatus;
    error?: string;
    results: Record<string, unknown>[];
    /**
     * Per-brand `error` events recorded for this PDF ({brand, message}), so the
     * results doc says WHY a brand is missing from `results`. Empty when every
     * brand succeeded. PDF-level fatals (no brand) surface via `error` above.
     */
    errors: { brand: string; message: string }[];
  }[];
}

/** Tiny per-socket attachment (well under the ~16KB serializeAttachment cap). */
interface SocketAttachment {
  jobId: string;
  lastSeq: number;
}

type FinalizationJobRow = {
  id: string;
  status: string;
  created_at: number;
  total_pdfs: number;
  completed_pdfs: number;
  failed_pdfs: number;
  config_json: string;
  finalization_state: string;
  final_status: string | null;
  finalized_at: number | null;
  finalization_error: string | null;
};

type FinalizationPdfRow = {
  pdf_index: number;
  filename: string;
  status: string;
  attempt: number;
  results: number;
  error: string | null;
  file_sha256: string | null;
};

type FinalizationData = {
  job: FinalizationJobRow;
  state: FinalizationState;
  finalStatus: JobStatus;
  finalizedAt: number;
  owner: string;
  processingAbandoned: boolean;
  pdfRows: FinalizationPdfRow[];
  byPdf: Map<number, Record<string, unknown>[]>;
  errorsByPdf: Map<number, { brand: string; message: string }[]>;
  results: JobResults;
};

const FINALIZATION_ORDER: FinalizationState[] = [
  "none",
  "prepared",
  "aggregate_committed",
  "library_committed",
  "cohort_committed",
  "webhook_committed",
  "terminal_committed",
  "abandoned",
];

const PROCESSING_ABANDONED = "abandoned: processing-time ceiling";
const FINALIZATION_ABANDONED = "abandoned: finalization-time ceiling";

/** Hex-encode an ArrayBuffer (used for the sha256 container route key). */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** sha256-hex of the PDF bytes â€” the sticky container instance key. */
async function sha256hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

function parseFinalizationState(value: string): FinalizationState {
  if (
    value === "none" ||
    value === "prepared" ||
    value === "aggregate_committed" ||
    value === "library_committed" ||
    value === "cohort_committed" ||
    value === "webhook_committed" ||
    value === "terminal_committed" ||
    value === "abandoned"
  ) {
    return value;
  }
  throw new Error("invalid persisted finalization state");
}

function finalizationStateAtLeast(
  current: FinalizationState,
  expected: FinalizationState
): boolean {
  return (
    FINALIZATION_ORDER.indexOf(current) >=
    FINALIZATION_ORDER.indexOf(expected)
  );
}

function sanitizeFinalizationError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const clean = raw
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || "unknown finalization error").slice(0, 240);
}

function isProcessingAbandoned(value: string | null): boolean {
  return Boolean(value?.startsWith(PROCESSING_ABANDONED));
}

/**
 * Decide a PDF's terminal status once its stream cleanly reached `done`:
 * per-brand errors are non-fatal in-stream, so a PDF whose brands ALL errored
 * still reaches `done` having produced ZERO `result` events. Treating that as
 * "complete" would silently drop the PDF from the results â€” fail it instead
 * (fail-soft: the job keeps going, the failure is recorded). `resultCount` is
 * the number of `result` events tracked for the PDF (job_pdfs.results).
 * Exported as a pure helper so the decision is unit-testable without a DO.
 */
export function pdfOutcomeAfterDone(resultCount: number): {
  status: JobStatus;
  error?: string;
} {
  if (resultCount <= 0) {
    return { status: "failed", error: "all brands failed" };
  }
  return { status: "complete" };
}

/**
 * Watchdog cadence while a job is non-terminal. Processing rides a single
 * ctx.waitUntil promise, which a DO restart (deploy, eviction, crash) silently
 * orphans â€” observed live: a job sat status="running" / PDF "pending" for hours
 * because the only alarm was retention, days away. While non-terminal, the
 * alarm slot is a short-cadence watchdog that resumes orphaned processing;
 * only a TERMINAL job schedules the retention alarm.
 */
const WATCHDOG_MS = 3 * 60 * 1000;

/**
 * Idle guard on the container NDJSON stream. The container heartbeats every
 * few seconds even mid-OCR, so a read that delivers nothing for this long is a
 * dead instance (e.g. restarted mid-stream) â€” fail the PDF instead of awaiting
 * a body that will never end.
 */
const STREAM_IDLE_MS = 180 * 1000;

/**
 * Abandon ceiling for each phase. Processing gets MAX_JOB_AGE_MS from job
 * creation; once finalization is prepared, finalization gets a fresh
 * MAX_JOB_AGE_MS measured from the frozen finalized_at timestamp.
 */
const MAX_JOB_AGE_MS = 12 * 60 * 60 * 1000;

export class JobCoordinator extends DurableObject<Env> {
  /** In-memory next seq_num cache; rehydrated from SQLite lazily (see nextSeq). */
  private seqCursor: number | null = null;

  /**
   * True while THIS instance has a processing run in flight (waitUntil). Purely
   * in-memory by design: a restarted instance starts false, which is exactly
   * the signal the watchdog alarm uses to detect orphaned processing.
   */
  private processing = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create the schema synchronously on first construction. blockConcurrency
    // ensures no fetch/alarm runs until the tables exist.
    ctx.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  /** Create the tables if absent and fail closed if a migration cannot apply. */
  private initSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id                  TEXT PRIMARY KEY,
         status              TEXT NOT NULL,
         created_at          INTEGER NOT NULL,
         total_pdfs          INTEGER NOT NULL,
         completed_pdfs      INTEGER NOT NULL DEFAULT 0,
         failed_pdfs         INTEGER NOT NULL DEFAULT 0,
         config_json         TEXT NOT NULL,
         finalization_state  TEXT NOT NULL DEFAULT 'none',
         final_status        TEXT,
         finalized_at        INTEGER,
         finalization_error  TEXT
       );`
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS job_events (
         seq_num     INTEGER PRIMARY KEY,
         event_type  TEXT NOT NULL,
         pdf_index   INTEGER NOT NULL,
         attempt     INTEGER NOT NULL DEFAULT 1,
         brand       TEXT,
         payload     TEXT NOT NULL,
         created_at  INTEGER NOT NULL
       );`
    );
    // Per-PDF progress (lets GET /api/jobs/:id report perPdf without scanning the
    // whole event log). Created here so the schema is self-contained. The
    // `file_sha256` column is captured per PDF when processing so finalizeJob can
    // write owner-scoped library index rows with the cache key.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS job_pdfs (
         pdf_index   INTEGER PRIMARY KEY,
         filename    TEXT NOT NULL,
         status      TEXT NOT NULL,
         attempt     INTEGER NOT NULL DEFAULT 1,
         results     INTEGER NOT NULL DEFAULT 0,
         error       TEXT,
         file_sha256 TEXT
       );`
    );
    // Defensive migrations: deployed JobCoordinator instances may predate the
    // file_sha256 and attempt columns. CREATE TABLE IF NOT EXISTS above does not
    // alter those existing tables. SQLite has no ADD COLUMN IF NOT EXISTS, so
    // duplicate-column errors are swallowed to keep every migration idempotent.
    try {
      sql.exec("ALTER TABLE job_pdfs ADD COLUMN file_sha256 TEXT");
    } catch {
      // Column already present.
    }
    try {
      sql.exec(
        "ALTER TABLE job_pdfs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"
      );
    } catch {
      // Column already present.
    }
    try {
      sql.exec(
        "ALTER TABLE job_events ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1"
      );
    } catch {
      // Column already present.
    }

    // Finalization migrations are inspected before ALTER instead of swallowing
    // errors. A real migration failure must prevent the object from running with
    // a partially available state machine.
    const jobColumns = new Set(
      sql
        .exec<{ name: string }>("PRAGMA table_info(jobs)")
        .toArray()
        .map((column) => column.name)
    );
    if (!jobColumns.has("finalization_state")) {
      sql.exec(
        "ALTER TABLE jobs ADD COLUMN finalization_state TEXT NOT NULL DEFAULT 'none'"
      );
    }
    if (!jobColumns.has("final_status")) {
      sql.exec("ALTER TABLE jobs ADD COLUMN final_status TEXT");
    }
    if (!jobColumns.has("finalized_at")) {
      sql.exec("ALTER TABLE jobs ADD COLUMN finalized_at INTEGER");
    }
    if (!jobColumns.has("finalization_error")) {
      sql.exec("ALTER TABLE jobs ADD COLUMN finalization_error TEXT");
    }

    // Intentionally no composite job_events attempt index: each Durable Object
    // owns one modest job log, so active-attempt finalization scans stay bounded.
    // Avoiding the index also avoids a permanent migration and write amplification
    // on every hot-path event append.
  }

  // â”€â”€ seq_num allocation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Return the next monotonic seq_num. We read MAX(seq_num) from SQLite ONCE
   * (synchronously consuming the cursor) and then keep counting in memory. seq
   * numbers are therefore strictly increasing for the life of the job, and
   * survive hibernation because they are derived from the persisted log.
   */
  private nextSeq(): number {
    if (this.seqCursor === null) {
      const rows = this.ctx.storage.sql
        .exec<{ max_seq: number | null }>(
          "SELECT MAX(seq_num) AS max_seq FROM job_events"
        )
        .toArray(); // consume cursor synchronously
      this.seqCursor = rows.length && rows[0].max_seq ? rows[0].max_seq : 0;
    }
    this.seqCursor += 1;
    return this.seqCursor;
  }

  // â”€â”€ Worker â†’ DO control plane â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * HTTP surface the Worker uses to drive the DO:
   *   POST /start            â†’ begin processing (body: StartJobBody)
   *   GET  /state            â†’ JobStateResponse JSON
   *   GET  /stream?lastSeq=N â†’ WebSocket upgrade (replay + live)
   * The Worker addresses the DO via idFromName(jobId), so every request here
   * already belongs to one job.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const body = (await request.json()) as StartJobBody;
      return this.handleStart(body);
    }

    if (url.pathname === "/state" && request.method === "GET") {
      return this.handleState();
    }

    if (url.pathname === "/stream") {
      return this.handleStream(request, url);
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * Record the job + per-PDF rows, arm the WATCHDOG alarm (retention is
   * scheduled by runJob once the job is terminal), and kick off processing in
   * the background (waitUntil so the 202 returns immediately).
   */
  private async handleStart(body: StartJobBody): Promise<Response> {
    const sql = this.ctx.storage.sql;

    // Idempotency: if this job was already started, do nothing (the Worker may
    // retry start()). We check synchronously before any await.
    const existing = sql
      .exec<{ id: string }>("SELECT id FROM jobs WHERE id = ?", body.jobId)
      .toArray();
    if (existing.length > 0) {
      return new Response(JSON.stringify({ ok: true, already: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    const createdAt = Date.now();
    const config: JobConfig = {
      brands: body.brands,
      runs: body.runs,
      explain: body.explain,
      // W3-ext consensus opt-in (absent/false = off; only `true` is honoured).
      consensus: body.consensus === true ? true : undefined,
      pdfs: body.pdfs,
      // Tenant scope for library persistence on finalize (defaults applied at use).
      owner: typeof body.owner === "string" ? body.owner : undefined,
      // W5 cohort linkage (all optional; absent for a normal /api/jobs batch).
      webhook_url:
        typeof body.webhook_url === "string" && body.webhook_url
          ? body.webhook_url
          : undefined,
      cohort_id:
        typeof body.cohort_id === "string" && body.cohort_id
          ? body.cohort_id
          : undefined,
      run_id:
        typeof body.run_id === "string" && body.run_id ? body.run_id : undefined,
    };

    sql.exec(
      `INSERT INTO jobs
         (id, status, created_at, total_pdfs, completed_pdfs, failed_pdfs,
          config_json, finalization_state, final_status, finalized_at,
          finalization_error)
       VALUES (?, ?, ?, ?, 0, 0, ?, 'none', NULL, NULL, NULL)`,
      body.jobId,
      "running",
      createdAt,
      body.pdfs.length,
      JSON.stringify(config)
    );

    for (const pdf of body.pdfs) {
      sql.exec(
        "INSERT INTO job_pdfs (pdf_index, filename, status, attempt, results, error) VALUES (?, ?, 'pending', 1, 0, NULL)",
        pdf.index,
        pdf.filename
      );
    }

    // Process in the background so the control-plane call returns instantly.
    // Register the work before awaiting the alarm write so a storage error cannot
    // leave the newly persisted job without an in-flight processing attempt.
    this.ctx.waitUntil(this.runJob(body.jobId, config));

    // WATCHDOG alarm (not retention): while the job is non-terminal the alarm
    // slot guards against a DO restart orphaning the waitUntil-driven
    // processing above. runJob schedules the retention alarm once terminal.
    await this.rearmAlarmDurably(createdAt + WATCHDOG_MS);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  // â”€â”€ Job processing (semaphore + container fan-out) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * processJob wrapper owning the `processing` flag and the alarm handoff:
   * while running, the watchdog alarm sees processing=true and stays hands-off;
   * once the job is terminal, the alarm slot is repurposed for retention.
   */
  private async runJob(jobId: string, config: JobConfig): Promise<void> {
    if (this.processing) return; // belt-and-braces: never double-drive
    this.processing = true;
    try {
      await this.processJob(jobId, config);
    } finally {
      this.processing = false;
      // Terminal (finalizeJob ran, including forced finalization abandonment):
      // hand the alarm slot to retention. On an unexpected throw the job stays
      // non-terminal and the watchdog resumes its persisted stage.
      const rows = this.ctx.storage.sql
        .exec<{ status: string; created_at: number }>(
          "SELECT status, created_at FROM jobs WHERE id = ?",
          jobId
        )
        .toArray();
      if (
        rows.length &&
        (rows[0].status === "complete" || rows[0].status === "failed")
      ) {
        await this.scheduleRetention(rows[0].created_at);
      }
    }
  }

  /**
   * Await an alarm write so recovery does not depend on a rejected background
   * promise being retried by the runtime. When preserving an existing error,
   * log an alarm-write failure without replacing the error the caller will
   * propagate.
   */
  private async rearmAlarmDurably(
    scheduledAt: number,
    preserveOriginalError = false
  ): Promise<void> {
    try {
      await this.ctx.storage.setAlarm(scheduledAt);
    } catch (alarmError) {
      if (!preserveOriginalError) {
        throw alarmError;
      }
      console.error(
        "job alarm re-arm failed; preserving original error:",
        alarmError
      );
    }
  }

  /** Arm retention from the immutable job creation timestamp. */
  private async scheduleRetention(createdAt: number): Promise<void> {
    const retentionDays = Number(this.env.RETENTION_DAYS ?? "7") || 7;
    await this.rearmAlarmDurably(
      Math.max(
        Date.now() + 1000,
        createdAt + retentionDays * 24 * 60 * 60 * 1000
      )
    );
  }

  /**
   * Drive every PDF through the container with a bounded concurrency semaphore,
   * then enter or resume durable finalization.
   */
  private async processJob(jobId: string, config: JobConfig): Promise<void> {
    const maxConcurrent = Math.max(
      1,
      Number(this.env.MAX_CONCURRENT_PDFS ?? "2") || 2
    );

    // RESUME-SAFE queue: select each non-terminal PDF together with its active
    // attempt. A fresh job starts at attempt 1; watchdog recovery increments the
    // attempt before rebuilding this queue.
    const pendingRows = this.ctx.storage.sql
      .exec<{ pdf_index: number; attempt: number }>(
        "SELECT pdf_index, attempt FROM job_pdfs WHERE status NOT IN ('complete','failed') ORDER BY pdf_index"
      )
      .toArray();
    const configByIndex = new Map(config.pdfs.map((pdf) => [pdf.index, pdf]));
    const queue: { index: number; filename: string; attempt: number }[] = [];
    for (const row of pendingRows) {
      const pdf = configByIndex.get(row.pdf_index);
      if (pdf) {
        queue.push({
          index: pdf.index,
          filename: pdf.filename,
          attempt: row.attempt,
        });
      }
    }

    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      for (;;) {
        const pdf = queue.shift();
        if (!pdf) return;
        await this.processPdf(
          jobId,
          config,
          pdf.index,
          pdf.filename,
          pdf.attempt
        );
      }
    };
    for (let i = 0; i < Math.min(maxConcurrent, queue.length); i++) {
      workers.push(runNext());
    }
    await Promise.all(workers);

    await this.finalizeJob(jobId, config);
  }

  /**
   * Process one PDF: read bytes from R2, call the container's /analyze with the
   * exact multipart fields, stream its NDJSON, and log+broadcast every event.
   */
  private async processPdf(
    jobId: string,
    config: JobConfig,
    pdfIndex: number,
    filename: string,
    attempt: number
  ): Promise<void> {
    try {
      const key = `pdfs/${jobId}/${pdfIndex}.pdf`;
      const obj = await this.env.RESULT_BUCKET.get(key);
      if (!obj) {
        throw new Error(`PDF not found in R2: ${key}`);
      }
      const bytes = await obj.arrayBuffer();

      // Sticky container routing by content hash (OCR-once cache reuse). The
      // same hash is the persistent-library cache key, so store it on the PDF row
      // for finalizeJob to read back. The attempt guard prevents a stale worker
      // from writing into a later recovery attempt.
      const sha = await sha256hex(bytes);
      this.ctx.storage.sql.exec(
        "UPDATE job_pdfs SET file_sha256 = ? WHERE pdf_index = ? AND attempt = ?",
        sha,
        pdfIndex,
        attempt
      );
      const route = ROUTE_PREFIX + sha;

      // Build the multipart body with EXACTLY the fields container/app.py reads
      // on POST /analyze: file (the PDF) + brands (csv) + runs + explain
      // (+ consensus when the job opted in).
      const form = new FormData();
      form.append(
        "file",
        new Blob([bytes], { type: "application/pdf" }),
        filename
      );
      form.append("brands", config.brands);
      form.append("runs", String(config.runs));
      form.append("explain", config.explain ? "1" : "0");
      // W3-ext consensus: forward the opt-in so batch results carry the same
      // cross-check `consensus` maps as the single flow. Omitted when off so a
      // consensus-off request stays byte-identical to the original shape.
      if (config.consensus) {
        form.append("consensus", "1");
      }

      // Container offline (2026-08-02, see ./util). The Worker refuses job
      // CREATION up front, so a job should never get this far — but a job
      // already in flight when the container application was deleted, or one
      // resumed from DO storage after a restart, would otherwise construct the
      // PaContainer DO and die inside the @cloudflare/containers constructor
      // with "Containers have not been enabled for this Durable Object class".
      // Throwing here routes that PDF through the normal per-PDF failure path,
      // so the job finalizes cleanly with a readable reason instead of hanging.
      if (containersOffline(this.env)) {
        throw new Error(CONTAINERS_OFFLINE_MESSAGE);
      }

      const container = getContainer(this.env.PA_CONTAINER, route);
      const res = await container.fetch(
        new Request("http://c/analyze", { method: "POST", body: form })
      );

      if (!res.ok || !res.body) {
        const detail = await safeText(res);
        throw new Error(
          `container /analyze failed (HTTP ${res.status})${detail ? ": " + detail : ""}`
        );
      }

      const outcome = await this.consumeNdjson(
        res.body,
        jobId,
        pdfIndex,
        filename,
        attempt
      );

      // The container streamed a PDF-LEVEL fatal (an {"event":"error"} with no
      // "brand" key â€” e.g. "OCR failed" / last-resort "extraction failed") and/or
      // never emitted the trailing {"event":"done"}. The HTTP transport was fine
      // (res.ok), so only the in-band stream tells us the extraction crashed.
      // Record the PDF as FAILED (a per-brand error still leaves it complete).
      if (!outcome.ok) {
        this.markPdf(
          jobId,
          pdfIndex,
          attempt,
          "failed",
          outcome.fatalError ?? "extraction did not complete"
        );
        return;
      }

      // The stream reached `done`, but `done` alone does not mean any brand
      // succeeded: per-brand errors are non-fatal, so EVERY brand may have
      // errored with zero `result` events. Read back the active-attempt result
      // count and fail such a PDF instead of recording an empty "complete".
      const countRows = this.ctx.storage.sql
        .exec<{ results: number }>(
          "SELECT results FROM job_pdfs WHERE pdf_index = ? AND attempt = ?",
          pdfIndex,
          attempt
        )
        .toArray();
      const resultCount = countRows.length ? countRows[0].results : 0;
      const verdict = pdfOutcomeAfterDone(resultCount);
      if (verdict.status === "failed") {
        this.markPdf(
          jobId,
          pdfIndex,
          attempt,
          "failed",
          verdict.error
        );
        return;
      }

      // Per-PDF success.
      this.markPdf(jobId, pdfIndex, attempt, "complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface a per-PDF error event into the log/stream (mirrors the
      // container's own per-brand error shape but at PDF granularity).
      this.emit(
        jobId,
        pdfIndex,
        filename,
        {
          event: "error",
          error: message,
        },
        attempt
      );
      this.markPdf(jobId, pdfIndex, attempt, "failed", message);
    }
  }

  /**
   * Read an NDJSON byte stream line-by-line and emit each parsed event. Partial
   * trailing lines are buffered until the next chunk; a final partial line is
   * flushed at end-of-stream.
   *
   * Returns the STREAM OUTCOME so the caller can tell a crashed extraction from a
   * clean one even though the HTTP response was 200. The container ends a PDF-level
   * fatal (OCR failed / last-resort "extraction failed") with an {"event":"error"}
   * carrying NO "brand" key and WITHOUT the trailing {"event":"done"} (core.py:796,
   * app.py:230); a clean run always ends with {"event":"done"} (core.py:874), and a
   * per-brand error ({"event":"error","brand":...}) is non-fatal â€” the run still
   * reaches `done`. So the PDF succeeded iff we saw `done` and no PDF-level error.
   */
  private async consumeNdjson(
    body: ReadableStream<Uint8Array>,
    jobId: string,
    pdfIndex: number,
    filename: string,
    attempt: number
  ): Promise<{ ok: boolean; fatalError?: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let sawDone = false;
    let fatalError: string | undefined;

    const observe = (line: string): void => {
      const out = this.emitRawLine(
        jobId,
        pdfIndex,
        filename,
        line,
        attempt
      );
      if (out.done) sawDone = true;
      // First PDF-level fatal wins as the recorded reason.
      if (out.fatalError !== undefined && fatalError === undefined) {
        fatalError = out.fatalError;
      }
    };

    for (;;) {
      // Idle guard: the container heartbeats every few seconds, so a read that
      // stays pending past STREAM_IDLE_MS means the instance died mid-stream
      // (observed live during a restart). Fail the PDF instead of awaiting a
      // body that never ends â€” the watchdog/caller error path takes over.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(
          () => reject(new Error(`container stream stalled (no data for ${STREAM_IDLE_MS / 1000}s)`)),
          STREAM_IDLE_MS
        );
      });
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), idle]));
      } catch (err) {
        void reader.cancel().catch(() => {});
        throw err;
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) observe(line);
      }
    }

    // Flush any trailing partial line (NDJSON without a final newline).
    const tail = buffer.trim();
    if (tail) observe(tail);

    // Fatal if the container reported a PDF-level error OR never reached `done`.
    const ok = sawDone && fatalError === undefined;
    return { ok, fatalError };
  }

  /**
   * Parse one NDJSON line and emit it; tolerate a malformed line gracefully.
   * Returns how this line bears on the STREAM OUTCOME:
   *   - done       : true for the terminal {"event":"done"}.
   *   - fatalError : set for a PDF-level fatal {"event":"error"} (no "brand" key);
   *                  undefined for a per-brand error or any non-error event.
   */
  private emitRawLine(
    jobId: string,
    pdfIndex: number,
    filename: string,
    line: string,
    attempt: number
  ): { done: boolean; fatalError?: string } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON noise from the stream â€” wrap it so nothing is silently lost.
      parsed = { event: "error", error: "malformed event from container" };
    }
    this.emit(jobId, pdfIndex, filename, parsed, attempt);

    // Track the active attempt's per-PDF result count for the poll endpoint.
    if (parsed.event === "result") {
      this.ctx.storage.sql.exec(
        "UPDATE job_pdfs SET results = results + 1 WHERE pdf_index = ? AND attempt = ?",
        pdfIndex,
        attempt
      );
    }

    if (parsed.event === "done") {
      return { done: true };
    }
    // A PDF-level fatal carries NO "brand" key; a per-brand error DOES and is
    // non-fatal (the PDF stays complete and the stream still reaches `done`).
    if (parsed.event === "error" && typeof parsed.brand !== "string") {
      const reason =
        typeof parsed.error === "string" ? parsed.error : "extraction failed";
      return { done: false, fatalError: reason };
    }
    return { done: false };
  }

  /**
   * Assign the next seq_num, wrap the raw event, and persist it to job_events.
   * The attempt is stored only in the SQLite column; existing event envelopes
   * remain byte-for-byte compatible. There is no await inside this method.
   */
  private appendEvent(
    pdfIndex: number,
    filename: string,
    raw: Record<string, unknown>,
    attempt: number
  ): { envelope: JobEvent; seq: number } {
    const seq = this.nextSeq();
    const envelope: JobEvent = {
      ...raw,
      pdf_index: pdfIndex,
      filename,
      seq_num: seq,
    };

    const eventType =
      typeof raw.event === "string" ? (raw.event as string) : "unknown";
    const brand = typeof raw.brand === "string" ? (raw.brand as string) : null;

    this.ctx.storage.sql.exec(
      "INSERT INTO job_events (seq_num, event_type, pdf_index, attempt, brand, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      seq,
      eventType,
      pdfIndex,
      attempt,
      brand,
      JSON.stringify(envelope),
      Date.now()
    );

    return { envelope, seq };
  }

  /**
   * Persist one event, then broadcast it. Watchdog recovery calls appendEvent
   * inside its reset transaction and broadcasts only after that transaction
   * commits, preserving reset/event crash atomicity.
   */
  private emit(
    jobId: string,
    pdfIndex: number,
    filename: string,
    raw: Record<string, unknown>,
    attempt: number
  ): void {
    const appended = this.appendEvent(pdfIndex, filename, raw, attempt);
    this.broadcast(jobId, appended.envelope, appended.seq);
  }

  /** Send an envelope to every live socket for this job (best-effort). */
  private broadcast(jobId: string, envelope: JobEvent, seq: number): void {
    const payload = JSON.stringify(envelope);
    for (const ws of this.ctx.getWebSockets(jobId)) {
      try {
        ws.send(payload);
        // Keep each socket's resume point current (tiny attachment, < 16KB) so
        // a hibernated socket knows where to replay from after a reconnect.
        ws.serializeAttachment({ jobId, lastSeq: seq } satisfies SocketAttachment);
      } catch {
        // A socket that errors on send is already gone; ignore.
      }
    }
  }

  /**
   * Atomically transition the active attempt to a terminal state and increment
   * the matching job counter only when that exact attempt actually transitioned.
   * UPDATE RETURNING makes stale completions a no-op.
   */
  private markPdf(
    jobId: string,
    pdfIndex: number,
    attempt: number,
    status: JobStatus,
    error?: string
  ): boolean {
    return this.ctx.storage.transactionSync(() => {
      const transitioned = this.ctx.storage.sql
        .exec<{ pdf_index: number }>(
          "UPDATE job_pdfs SET status = ?, error = ? WHERE pdf_index = ? AND attempt = ? AND status NOT IN ('complete','failed') RETURNING pdf_index",
          status,
          error ?? null,
          pdfIndex,
          attempt
        )
        .toArray();

      if (transitioned.length === 0) {
        return false;
      }

      const column =
        status === "complete"
          ? "completed_pdfs"
          : status === "failed"
            ? "failed_pdfs"
            : null;
      if (column) {
        this.ctx.storage.sql.exec(
          `UPDATE jobs SET ${column} = ${column} + 1 WHERE id = ?`,
          jobId
        );
      }
      return true;
    });
  }

  // â”€â”€ Durable finalization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Freeze terminal inputs before the first external side effect. Job status
   * deliberately stays "running" until the final transaction.
   */
  private prepareFinalization(jobId: string): void {
    this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<FinalizationJobRow>(
          `SELECT id, status, created_at, total_pdfs, completed_pdfs,
                  failed_pdfs, config_json, finalization_state, final_status,
                  finalized_at, finalization_error
           FROM jobs WHERE id = ?`,
          jobId
        )
        .toArray();
      if (rows.length === 0) {
        throw new Error("finalization invariant: job row missing");
      }

      const job = rows[0];
      const state = parseFinalizationState(job.finalization_state);
      if (state !== "none") return;

      const pending = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM job_pdfs
           WHERE status NOT IN ('complete','failed')`
        )
        .toArray();
      if ((pending[0]?.count ?? 0) !== 0) {
        throw new Error("finalization invariant: non-terminal PDFs remain");
      }

      const finalStatus: JobStatus =
        job.failed_pdfs >= job.total_pdfs && job.total_pdfs > 0
          ? "failed"
          : "complete";
      const finalizedAt = job.finalized_at ?? Date.now();

      const prepared = this.ctx.storage.sql
        .exec<{ id: string }>(
          `UPDATE jobs
           SET finalization_state = 'prepared',
               final_status = ?,
               finalized_at = ?,
               finalization_error = finalization_error
           WHERE id = ? AND finalization_state = 'none'
           RETURNING id`,
          finalStatus,
          finalizedAt,
          jobId
        )
        .toArray();
      if (prepared.length !== 1) {
        throw new Error("finalization invariant: prepare transition failed");
      }
    });
  }

  /** Read stable finalization inputs and active-attempt events synchronously. */
  private readFinalizationData(
    jobId: string,
    config: JobConfig
  ): FinalizationData {
    const sql = this.ctx.storage.sql;

    const jobRows = sql
      .exec<FinalizationJobRow>(
        `SELECT id, status, created_at, total_pdfs, completed_pdfs,
                failed_pdfs, config_json, finalization_state, final_status,
                finalized_at, finalization_error
         FROM jobs WHERE id = ?`,
        jobId
      )
      .toArray();
    if (jobRows.length === 0) {
      throw new Error("finalization invariant: job row missing");
    }
    const job = jobRows[0];
    const state = parseFinalizationState(job.finalization_state);
    if (
      job.final_status !== "complete" &&
      job.final_status !== "failed"
    ) {
      throw new Error("finalization invariant: final status was not frozen");
    }
    if (job.finalized_at === null) {
      throw new Error("finalization invariant: finalized_at was not frozen");
    }

    const pdfRows = sql
      .exec<FinalizationPdfRow>(
        `SELECT pdf_index, filename, status, attempt, results, error,
                file_sha256
         FROM job_pdfs
         ORDER BY pdf_index`
      )
      .toArray();

    // Only the active attempt contributes to any finalized artifact. Older
    // attempts remain immutable in the event log for replay and audit.
    const resultRows = sql
      .exec<{ pdf_index: number; payload: string }>(
        `SELECT e.pdf_index, e.payload
         FROM job_events e
         JOIN job_pdfs p
           ON p.pdf_index = e.pdf_index
          AND p.attempt = e.attempt
         WHERE e.event_type = 'result'
         ORDER BY e.seq_num`
      )
      .toArray();

    const byPdf = new Map<number, Record<string, unknown>[]>();
    for (const row of resultRows) {
      const list = byPdf.get(row.pdf_index) ?? [];
      list.push(JSON.parse(row.payload) as Record<string, unknown>);
      byPdf.set(row.pdf_index, list);
    }

    const errorRows = sql
      .exec<{ pdf_index: number; brand: string | null; payload: string }>(
        `SELECT e.pdf_index, e.brand, e.payload
         FROM job_events e
         JOIN job_pdfs p
           ON p.pdf_index = e.pdf_index
          AND p.attempt = e.attempt
         WHERE e.event_type = 'error'
         ORDER BY e.seq_num`
      )
      .toArray();

    const errorsByPdf = new Map<
      number,
      { brand: string; message: string }[]
    >();
    for (const row of errorRows) {
      if (typeof row.brand !== "string" || !row.brand) continue;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const message =
        typeof payload.error === "string" ? payload.error : "extraction failed";
      const list = errorsByPdf.get(row.pdf_index) ?? [];
      list.push({ brand: row.brand, message });
      errorsByPdf.set(row.pdf_index, list);
    }

    const results: JobResults = {
      jobId,
      created_at: job.created_at,
      finished_at: job.finalized_at,
      config: {
        brands: config.brands,
        runs: config.runs,
        explain: config.explain,
      },
      pdfs: pdfRows.map((pdf) => ({
        index: pdf.pdf_index,
        filename: pdf.filename,
        status: pdf.status as JobStatus,
        error: pdf.error ?? undefined,
        results: byPdf.get(pdf.pdf_index) ?? [],
        errors: errorsByPdf.get(pdf.pdf_index) ?? [],
      })),
    };

    return {
      job,
      state,
      finalStatus: job.final_status,
      finalizedAt: job.finalized_at,
      owner:
        config.owner && config.owner.trim() ? config.owner : "anonymous",
      processingAbandoned: isProcessingAbandoned(job.finalization_error),
      pdfRows,
      byPdf,
      errorsByPdf,
      results,
    };
  }

  /** Reject a partially populated cohort linkage before external side effects. */
  private validateFinalizationConfig(config: JobConfig): void {
    const hasCohort = Boolean(config.cohort_id);
    const hasRun = Boolean(config.run_id);
    if (hasCohort !== hasRun) {
      throw new Error(
        "finalization invariant: cohort_id and run_id must be set together"
      );
    }
    if (config.webhook_url && !hasRun) {
      throw new Error(
        "finalization invariant: webhook_url requires a cohort run_id"
      );
    }
  }

  /** Advance a completed-work marker after its side effect has committed. */
  private advanceFinalization(
    jobId: string,
    current: FinalizationState,
    next: FinalizationState
  ): void {
    const transitioned = this.ctx.storage.sql
      .exec<{ id: string }>(
        `UPDATE jobs
         SET finalization_state = ?,
             finalization_error =
               CASE
                 WHEN finalization_error LIKE ? THEN ?
                 ELSE NULL
               END
         WHERE id = ? AND finalization_state = ?
         RETURNING id`,
        next,
        `${PROCESSING_ABANDONED}%`,
        PROCESSING_ABANDONED,
        jobId,
        current
      )
      .toArray();

    if (transitioned.length === 1) return;

    const rows = this.ctx.storage.sql
      .exec<{ finalization_state: string }>(
        "SELECT finalization_state FROM jobs WHERE id = ?",
        jobId
      )
      .toArray();
    if (
      rows.length &&
      finalizationStateAtLeast(
        parseFinalizationState(rows[0].finalization_state),
        next
      )
    ) {
      return;
    }
    throw new Error(
      `finalization invariant: could not advance ${current} to ${next}`
    );
  }

  /** Persist a sanitized diagnostic without losing the processing marker. */
  private recordFinalizationFailure(
    jobId: string,
    stage: string,
    error: unknown
  ): void {
    const rows = this.ctx.storage.sql
      .exec<{ finalization_error: string | null }>(
        "SELECT finalization_error FROM jobs WHERE id = ?",
        jobId
      )
      .toArray();
    const prefix = isProcessingAbandoned(
      rows[0]?.finalization_error ?? null
    )
      ? `${PROCESSING_ABANDONED}; `
      : "";
    const diagnostic = `${prefix}finalization ${stage} failed: ${sanitizeFinalizationError(error)}`;
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET finalization_error = ? WHERE id = ? AND status NOT IN ('complete','failed')",
      diagnostic,
      jobId
    );
  }

  /** Persist all active result events with deterministic batch identities. */
  private async persistFinalizationLibrary(
    jobId: string,
    config: JobConfig,
    data: FinalizationData
  ): Promise<void> {
    // Preflight every result-bearing PDF before writing any library rows.
    for (const pdf of data.pdfRows) {
      const events = data.byPdf.get(pdf.pdf_index) ?? [];
      if (events.length > 0 && !pdf.file_sha256) {
        throw new Error(
          `finalization invariant: result events for PDF ${pdf.pdf_index} have no file_sha256`
        );
      }
    }

    for (const pdf of data.pdfRows) {
      const events = data.byPdf.get(pdf.pdf_index) ?? [];
      if (events.length === 0) continue;

      const extractResults: ExtractResult[] = [];
      for (const eventEnvelope of events) {
        if ((eventEnvelope as { event?: unknown }).event !== "result") continue;
        const {
          event,
          brand,
          pdf_index,
          filename,
          seq_num,
          ...extractResult
        } = eventEnvelope as Record<string, unknown>;
        void event;
        void brand;
        void pdf_index;
        void filename;
        void seq_num;
        extractResults.push(extractResult as unknown as ExtractResult);
      }
      if (extractResults.length === 0) continue;

      await persistResults({
        db: this.env.LIBRARY,
        bucket: this.env.RESULT_BUCKET,
        owner: data.owner,
        kind: "batch",
        jobId,
        fileSha256: pdf.file_sha256 as string,
        runs: config.runs,
        explain: config.explain,
        results: extractResults,
        batchIdempotency: {
          pdfIndex: pdf.pdf_index,
          finalizedAt: data.finalizedAt,
        },
      });
    }
  }

  /** Build the byte-stable cohort summary used by D1 and webhook stages. */
  private cohortSummary(
    jobId: string,
    config: JobConfig,
    data: FinalizationData
  ): {
    cohort_id: string;
    run_id: string;
    job_id: string;
    status: JobStatus;
    totals: {
      total_pdfs: number;
      completed_pdfs: number;
      failed_pdfs: number;
    };
    per_brand_access: Record<string, number>;
  } {
    if (!config.cohort_id || !config.run_id) {
      throw new Error("finalization invariant: cohort linkage is incomplete");
    }
    return {
      cohort_id: config.cohort_id,
      run_id: config.run_id,
      job_id: jobId,
      status: data.finalStatus,
      totals: {
        total_pdfs: data.job.total_pdfs,
        completed_pdfs: data.job.completed_pdfs,
        failed_pdfs: data.job.failed_pdfs,
      },
      per_brand_access: perBrandAccess(data.byPdf),
    };
  }

  /**
   * Update exactly one cohort run. If zero rows changed, tolerate only a truly
   * deleted parent cohort; an extant parent with a missing/mismatched run is an
   * invariant failure.
   */
  private async persistCohortStage(
    jobId: string,
    config: JobConfig,
    data: FinalizationData
  ): Promise<void> {
    if (!config.cohort_id || !config.run_id) return;

    const summary = this.cohortSummary(jobId, config, data);
    const updated = await this.env.LIBRARY.prepare(
      `UPDATE cohort_runs
       SET status = ?, summary_json = ?
       WHERE id = ? AND cohort_id = ? AND owner = ?`
    )
      .bind(
        data.finalStatus,
        JSON.stringify(summary),
        config.run_id,
        config.cohort_id,
        data.owner
      )
      .run();

    if (updated.meta.changes === 1) return;

    const parent = await this.env.LIBRARY.prepare(
      "SELECT id FROM cohorts WHERE id = ? LIMIT 1"
    )
      .bind(config.cohort_id)
      .first<{ id: string }>();
    if (!parent) {
      // The cohort and its runs were intentionally deleted while this job ran.
      return;
    }

    throw new Error(
      "finalization invariant: cohort run update changed zero rows"
    );
  }

  /**
   * Hard-gated, SSRF-guarded webhook POST. A non-2xx response, timeout, network
   * error, or validation failure leaves the job running at webhook_committed's
   * predecessor so watchdog recovery retries it. Forced abandonment uses a
   * distinct stable key because its failed summary differs from normal delivery.
   */
  private async postWebhook(
    webhookUrl: string,
    summary: unknown,
    runId: string,
    delivery: "finalization" | "abandoned" = "finalization"
  ): Promise<void> {
    const verdict = validateWebhookUrl(webhookUrl);
    if ("error" in verdict) {
      throw new Error(`cohort webhook rejected: ${verdict.error}`);
    }

    const suffix = delivery === "abandoned" ? "/abandoned" : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(verdict.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "pa-policy-extractor-cohort-webhook/1",
          "Idempotency-Key":
            `pa-policy-extractor/cohort-run/${runId}${suffix}`,
        },
        body: JSON.stringify(summary),
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`cohort webhook returned HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Insert job_done (attempt 0), update the terminal job status, and persist the
   * terminal finalization marker in one transaction. Broadcast happens only
   * after commit; replay covers a crash after commit but before broadcast.
   */
  private commitTerminal(
    jobId: string,
    finalStatus: JobStatus,
    raw: Record<string, unknown>,
    state: "terminal_committed" | "abandoned",
    finalizationError: string | null,
    expectedState?: FinalizationState
  ): void {
    const appended = this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql
        .exec<{ status: string; finalization_state: string }>(
          "SELECT status, finalization_state FROM jobs WHERE id = ?",
          jobId
        )
        .toArray();
      if (rows.length === 0) {
        throw new Error("finalization invariant: job row missing");
      }
      if (
        rows[0].status === "complete" ||
        rows[0].status === "failed"
      ) {
        return null;
      }

      const current = parseFinalizationState(rows[0].finalization_state);
      if (expectedState && current !== expectedState) {
        throw new Error(
          `finalization invariant: terminal commit expected ${expectedState}`
        );
      }

      const existing = this.ctx.storage.sql
        .exec<{ seq_num: number }>(
          "SELECT seq_num FROM job_events WHERE event_type = 'job_done' LIMIT 1"
        )
        .toArray();

      const event =
        existing.length === 0
          ? this.appendEvent(-1, "", raw, 0)
          : null;

      this.ctx.storage.sql.exec(
        `UPDATE jobs
         SET status = ?,
             final_status = ?,
             finalization_state = ?,
             finalization_error = ?
         WHERE id = ?`,
        finalStatus,
        finalStatus,
        state,
        finalizationError,
        jobId
      );

      return event;
    });

    if (appended) {
      this.broadcast(jobId, appended.envelope, appended.seq);
    }
  }

  /**
   * Run or resume the prepare -> aggregate -> library -> cohort -> webhook ->
   * terminal state machine. Every completed-work marker is written only after
   * its side effect has committed.
   */
  private async finalizeJob(jobId: string, config: JobConfig): Promise<void> {
    let stage = "prepare";
    try {
      this.prepareFinalization(jobId);

      stage = "configuration";
      this.validateFinalizationConfig(config);

      const data = this.readFinalizationData(jobId, config);
      let state = data.state;
      if (state === "terminal_committed" || state === "abandoned") return;

      if (state === "prepared") {
        stage = "aggregate";
        await this.env.RESULT_BUCKET.put(
          `results/${jobId}.json`,
          JSON.stringify(data.results),
          { httpMetadata: { contentType: "application/json" } }
        );
        this.advanceFinalization(
          jobId,
          "prepared",
          "aggregate_committed"
        );
        state = "aggregate_committed";
      }

      if (state === "aggregate_committed") {
        stage = "library";
        await this.persistFinalizationLibrary(jobId, config, data);
        this.advanceFinalization(
          jobId,
          "aggregate_committed",
          "library_committed"
        );
        state = "library_committed";
      }

      if (state === "library_committed") {
        stage = "cohort";
        await this.persistCohortStage(jobId, config, data);
        this.advanceFinalization(
          jobId,
          "library_committed",
          "cohort_committed"
        );
        state = "cohort_committed";
      }

      if (state === "cohort_committed") {
        stage = "webhook";
        if (config.webhook_url) {
          if (!config.run_id) {
            throw new Error(
              "finalization invariant: webhook has no run_id"
            );
          }
          const summary = this.cohortSummary(jobId, config, data);
          await this.postWebhook(
            config.webhook_url,
            summary,
            config.run_id
          );
        }
        this.advanceFinalization(
          jobId,
          "cohort_committed",
          "webhook_committed"
        );
        state = "webhook_committed";
      }

      if (state === "webhook_committed") {
        stage = "terminal";
        const terminal: Record<string, unknown> = {
          event: "job_done",
          status: data.finalStatus,
          total_pdfs: data.job.total_pdfs,
          completed_pdfs: data.job.completed_pdfs,
          failed_pdfs: data.job.failed_pdfs,
        };
        if (data.processingAbandoned) {
          terminal.abandoned = true;
        }
        this.commitTerminal(
          jobId,
          data.finalStatus,
          terminal,
          "terminal_committed",
          data.processingAbandoned ? PROCESSING_ABANDONED : null,
          "webhook_committed"
        );
      }
    } catch (error) {
      try {
        this.recordFinalizationFailure(jobId, stage, error);
      } catch (diagnosticError) {
        console.error(
          "could not persist finalization diagnostic:",
          diagnosticError
        );
      }
      await this.rearmAlarmDurably(
        Date.now() + WATCHDOG_MS,
        true
      );
      throw error;
    }
  }

  /**
   * Mark every non-terminal PDF failed, recompute job counters, persist one
   * per-PDF error event, and store the abandonment marker atomically. Broadcast
   * only after commit so live clients and replay observe the same transitions.
   */
  private markRemainingPdfsFailed(
    jobId: string,
    pdfError: string,
    jobMarker: string
  ): void {
    const appended = this.ctx.storage.transactionSync(() => {
      const failedRows = this.ctx.storage.sql
        .exec<{
          pdf_index: number;
          filename: string;
          attempt: number;
          error: string | null;
        }>(
          `UPDATE job_pdfs
           SET status = 'failed',
               error = COALESCE(error, ?)
           WHERE status NOT IN ('complete','failed')
           RETURNING pdf_index, filename, attempt, error`,
          pdfError
        )
        .toArray();

      const counts = this.ctx.storage.sql
        .exec<{
          completed: number;
          failed: number;
        }>(
          `SELECT
             SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM job_pdfs`
        )
        .toArray()[0];

      this.ctx.storage.sql.exec(
        `UPDATE jobs
         SET completed_pdfs = ?,
             failed_pdfs = ?,
             finalization_error = ?
         WHERE id = ?`,
        counts?.completed ?? 0,
        counts?.failed ?? 0,
        jobMarker,
        jobId
      );

      return failedRows.map((pdf) =>
        this.appendEvent(
          pdf.pdf_index,
          pdf.filename,
          {
            event: "error",
            error: pdf.error ?? pdfError,
          },
          pdf.attempt
        )
      );
    });

    for (const event of appended) {
      this.broadcast(jobId, event.envelope, event.seq);
    }
  }

  /**
   * Forced abandonment cannot remain hard-gated on an unavailable cohort store
   * or webhook. Make one best-effort failed-status reconciliation attempt before
   * the terminal commit; each failure is logged and cannot block abandonment.
   */
  private async reconcileForcedAbandonment(
    jobId: string,
    config: JobConfig
  ): Promise<void> {
    if (!config.cohort_id || !config.run_id) return;

    let data: FinalizationData;
    try {
      data = this.readFinalizationData(jobId, config);
    } catch (error) {
      console.error(
        `forced abandonment summary failed: ${sanitizeFinalizationError(error)}`
      );
      return;
    }

    try {
      await this.persistCohortStage(jobId, config, data);
    } catch (error) {
      console.error(
        `forced abandonment cohort reconciliation failed: ${sanitizeFinalizationError(error)}`
      );
    }

    if (config.webhook_url) {
      try {
        await this.postWebhook(
          config.webhook_url,
          this.cohortSummary(jobId, config, data),
          config.run_id,
          "abandoned"
        );
      } catch (error) {
        console.error(
          `forced abandonment webhook failed: ${sanitizeFinalizationError(error)}`
        );
      }
    }
  }

  /**
   * Finalization exceeded its own retry ceiling. Guarantee a failed terminal
   * event even if external finalization gates remain unavailable. Preserve an
   * existing aggregate; otherwise attempt the pinned empty-partial document.
   */
  private async forceFinalizationAbandonment(
    jobId: string,
    config: JobConfig
  ): Promise<void> {
    this.markRemainingPdfsFailed(
      jobId,
      "abandoned: finalization never completed",
      FINALIZATION_ABANDONED
    );

    const jobRows = this.ctx.storage.sql
      .exec<FinalizationJobRow>(
        `SELECT id, status, created_at, total_pdfs, completed_pdfs,
                failed_pdfs, config_json, finalization_state, final_status,
                finalized_at, finalization_error
         FROM jobs WHERE id = ?`,
        jobId
      )
      .toArray();
    if (jobRows.length === 0) return;
    const job = jobRows[0];
    const finalizedAt = job.finalized_at ?? Date.now();

    this.ctx.storage.sql.exec(
      `UPDATE jobs
       SET final_status = 'failed',
           finalized_at = ?,
           finalization_error = ?
       WHERE id = ?`,
      finalizedAt,
      FINALIZATION_ABANDONED,
      jobId
    );

    const pdfRows = this.ctx.storage.sql
      .exec<FinalizationPdfRow>(
        `SELECT pdf_index, filename, status, attempt, results, error,
                file_sha256
         FROM job_pdfs
         ORDER BY pdf_index`
      )
      .toArray();

    const emptyPartial: JobResults = {
      jobId,
      created_at: job.created_at,
      finished_at: finalizedAt,
      config: {
        brands: config.brands,
        runs: config.runs,
        explain: config.explain,
      },
      pdfs: pdfRows.map((pdf) => ({
        index: pdf.pdf_index,
        filename: pdf.filename,
        status: pdf.status as JobStatus,
        error: pdf.error ?? undefined,
        results: [],
        errors: [],
      })),
    };

    const resultKey = `results/${jobId}.json`;
    let resultsAvailable = false;
    try {
      resultsAvailable = Boolean(
        await this.env.RESULT_BUCKET.head(resultKey)
      );
    } catch (error) {
      console.error(
        `finalization abandonment aggregate check failed: ${sanitizeFinalizationError(error)}`
      );
    }

    if (!resultsAvailable) {
      try {
        await this.env.RESULT_BUCKET.put(
          resultKey,
          JSON.stringify(emptyPartial),
          { httpMetadata: { contentType: "application/json" } }
        );
        resultsAvailable = true;
      } catch (error) {
        console.error(
          `finalization abandonment aggregate write failed: ${sanitizeFinalizationError(error)}`
        );
      }
    }

    await this.reconcileForcedAbandonment(jobId, config);

    const refreshed = this.ctx.storage.sql
      .exec<{
        total_pdfs: number;
        completed_pdfs: number;
        failed_pdfs: number;
      }>(
        `SELECT total_pdfs, completed_pdfs, failed_pdfs
         FROM jobs WHERE id = ?`,
        jobId
      )
      .toArray()[0];

    this.commitTerminal(
      jobId,
      "failed",
      {
        event: "job_done",
        status: "failed",
        total_pdfs: refreshed?.total_pdfs ?? job.total_pdfs,
        completed_pdfs:
          refreshed?.completed_pdfs ?? job.completed_pdfs,
        failed_pdfs: refreshed?.failed_pdfs ?? job.failed_pdfs,
        abandoned: true,
        results_available: resultsAvailable,
      },
      "abandoned",
      FINALIZATION_ABANDONED
    );
  }

  // â”€â”€ GET /state (poll) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private async handleState(): Promise<Response> {
    const sql = this.ctx.storage.sql;

    const jobRows = sql
      .exec<FinalizationJobRow>("SELECT * FROM jobs LIMIT 1")
      .toArray();

    if (jobRows.length === 0) {
      return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const job = jobRows[0];
    const config = JSON.parse(job.config_json) as JobConfig;
    const finalizationState = parseFinalizationState(
      job.finalization_state
    );

    // Poll-triggered self-heal recreates a missing alarm for either phase.
    // Extraction may pull a later watchdog forward for fast orphan recovery.
    // Persisted finalization must preserve any existing retry backoff instead of
    // turning an active poller's cadence into the external-stage retry cadence.
    if (
      job.status !== "complete" &&
      job.status !== "failed" &&
      !this.processing
    ) {
      const selfHealAt = Date.now() + 5_000;
      const alarmAt = await this.ctx.storage.getAlarm();
      if (
        alarmAt === null ||
        (finalizationState === "none" && alarmAt > selfHealAt)
      ) {
        await this.rearmAlarmDurably(selfHealAt);
      }
    }

    const pdfRows = sql
      .exec<{
        pdf_index: number;
        filename: string;
        status: string;
        attempt: number;
        results: number;
        error: string | null;
      }>(
        "SELECT pdf_index, filename, status, attempt, results, error FROM job_pdfs ORDER BY pdf_index"
      )
      .toArray();

    const seqRows = sql
      .exec<{ max_seq: number | null }>(
        "SELECT MAX(seq_num) AS max_seq FROM job_events"
      )
      .toArray();
    const lastSeq = seqRows.length && seqRows[0].max_seq ? seqRows[0].max_seq : 0;

    const state: JobStateResponse = {
      jobId: job.id,
      status: job.status as JobStatus,
      totals: {
        total_pdfs: job.total_pdfs,
        completed_pdfs: job.completed_pdfs,
        failed_pdfs: job.failed_pdfs,
      },
      config: { brands: config.brands, runs: config.runs, explain: config.explain },
      perPdf: pdfRows.map((p) => ({
        index: p.pdf_index,
        filename: p.filename,
        status: p.status as JobStatus,
        attempt: p.attempt,
        results: p.results,
        error: p.error ?? undefined,
      })),
      last_seq: lastSeq,
      created_at: job.created_at,
    };

    if (finalizationState !== "none") {
      state.finalize_state = finalizationState;
    }
    if (job.finalization_error) {
      state.finalize_error = sanitizeFinalizationError(
        job.finalization_error
      );
    }

    return new Response(JSON.stringify(state), {
      headers: { "content-type": "application/json" },
    });
  }

  // â”€â”€ GET /stream (WebSocket: replay + live, hibernatable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Accept a WebSocket via the HIBERNATION API, tag it with the job tag (so
   * getWebSockets(jobId) finds it), REPLAY stored events with seq_num > lastSeq,
   * then leave it connected for live broadcasts. The DO can hibernate between
   * events with the socket still open.
   */
  private handleStream(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Resolve the jobId for the tag (one job per DO; read it from storage).
    const jobRows = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM jobs LIMIT 1")
      .toArray();
    const jobId = jobRows.length ? jobRows[0].id : "unknown";

    const lastSeq = Number(url.searchParams.get("lastSeq") ?? "0") || 0;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // HIBERNATION: tag the socket with the jobId so getWebSockets(jobId) returns
    // it, and seed its tiny resume attachment.
    this.ctx.acceptWebSocket(server, [jobId]);
    server.serializeAttachment({ jobId, lastSeq } satisfies SocketAttachment);

    // Replay everything the client has not seen yet (seq_num > lastSeq), in
    // order. Cursor consumed synchronously into an array before any send.
    const missed = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM job_events WHERE seq_num > ? ORDER BY seq_num",
        lastSeq
      )
      .toArray();

    let resumeSeq = lastSeq;
    for (const row of missed) {
      server.send(row.payload);
      const parsed = JSON.parse(row.payload) as JobEvent;
      resumeSeq = parsed.seq_num;
    }
    if (resumeSeq !== lastSeq) {
      server.serializeAttachment({ jobId, lastSeq: resumeSeq } satisfies SocketAttachment);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // â”€â”€ Hibernation handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Inbound client messages. The stream is serverâ†’client only; we accept a
   * "ping"/"resume" control frame so a reconnecting client can request a replay
   * from a given seq without reopening the socket.
   */
  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;
    let msg: { type?: string; lastSeq?: number };
    try {
      msg = JSON.parse(message) as { type?: string; lastSeq?: number };
    } catch {
      return;
    }
    if (msg.type === "resume") {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      const from = Number(msg.lastSeq ?? att?.lastSeq ?? 0) || 0;
      const missed = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM job_events WHERE seq_num > ? ORDER BY seq_num",
          from
        )
        .toArray();
      let resumeSeq = from;
      for (const row of missed) {
        ws.send(row.payload);
        resumeSeq = (JSON.parse(row.payload) as JobEvent).seq_num;
      }
      ws.serializeAttachment({
        jobId: att?.jobId ?? "unknown",
        lastSeq: resumeSeq,
      } satisfies SocketAttachment);
    }
  }

  /** A socket closed â€” nothing to clean up (hibernation drops it for us). */
  override async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Mirror a clean close back. 1005/1006 (no-status / abnormal) and codes
    // outside the sendable range can't be echoed, so fall back to 1000.
    const safeCode = code >= 1000 && code !== 1005 && code !== 1006 ? code : 1000;
    try {
      ws.close(safeCode, "closing");
    } catch {
      // already closed
    }
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Errored sockets are dropped by the runtime; nothing to do.
  }

  // â”€â”€ Alarm dispatcher: watchdog (non-terminal) / retention (terminal) â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * One alarm slot, two duties.
   *
   * NON-TERMINAL job: resume orphaned extraction or finalization. Processing
   * abandonment marks unfinished PDFs failed and enters the normal hard-gated
   * finalizer. Finalization exhaustion uses the forced-failed fallback.
   *
   * TERMINAL job: retention. Before the retention timestamp, just re-arm for
   * it (covers legacy alarms and watchdog->retention handoff races); after it,
   * delete the job's R2 objects + this DO's storage. Idempotent: a partial
   * failure reschedules; a fully-deleted job re-running is a no-op.
   */
  override async alarm(): Promise<void> {
    try {
      const jobRows = this.ctx.storage.sql
        .exec<FinalizationJobRow>(
          `SELECT id, status, created_at, total_pdfs, completed_pdfs,
                  failed_pdfs, config_json, finalization_state, final_status,
                  finalized_at, finalization_error
           FROM jobs LIMIT 1`
        )
        .toArray();

      if (jobRows.length === 0) {
        // Already cleaned up â€” nothing to do.
        return;
      }

      const row = jobRows[0];
      const jobId = row.id;
      const config = JSON.parse(row.config_json) as JobConfig;
      const isTerminal =
        row.status === "complete" || row.status === "failed";

      if (!isTerminal) {
        if (!this.processing) {
          const finalizationState = parseFinalizationState(
            row.finalization_state
          );

          if (finalizationState !== "none") {
            const startedAt = row.finalized_at ?? row.created_at;
            if (Date.now() - startedAt > MAX_JOB_AGE_MS) {
              await this.forceFinalizationAbandonment(jobId, config);
              await this.scheduleRetention(row.created_at);
              return;
            }

            console.log(
              `watchdog: resuming finalization for job ${jobId}`
            );
            this.ctx.waitUntil(this.runJob(jobId, config));
          } else if (Date.now() - row.created_at > MAX_JOB_AGE_MS) {
            // Processing-time abandonment is not terminal by itself. Mark the
            // unfinished PDFs failed, sync counters, and enter the same
            // hard-gated finalizer used by a normally completed extraction.
            this.markRemainingPdfsFailed(
              jobId,
              "abandoned: job never completed (instance churn)",
              PROCESSING_ABANDONED
            );
            this.ctx.waitUntil(this.runJob(jobId, config));
          } else {
            // Orphaned processing: atomically bump each non-terminal attempt,
            // reset its state, and append the ordered pdf_reset event. Terminal
            // PDFs are excluded, so the all-terminal crash-before-finalize case
            // performs zero resets and zero attempt bumps.
            console.log(`watchdog: resuming orphaned job ${jobId}`);
            const resetEvents = this.ctx.storage.transactionSync(() => {
              const resetRows = this.ctx.storage.sql
                .exec<{
                  pdf_index: number;
                  filename: string;
                  attempt: number;
                }>(
                  `UPDATE job_pdfs
                   SET attempt = attempt + 1,
                       status = 'pending',
                       results = 0,
                       error = NULL
                   WHERE status NOT IN ('complete','failed')
                   RETURNING pdf_index, filename, attempt`
                )
                .toArray();

              const appended: { envelope: JobEvent; seq: number }[] = [];
              for (const reset of resetRows) {
                appended.push(
                  this.appendEvent(
                    reset.pdf_index,
                    reset.filename,
                    {
                      event: "pdf_reset",
                      reason: "watchdog_resume",
                      previous_attempt: reset.attempt - 1,
                      attempt: reset.attempt,
                    },
                    reset.attempt
                  )
                );
              }
              return appended;
            });

            // Output only after the reset rows and reset events have committed.
            for (const event of resetEvents) {
              this.broadcast(jobId, event.envelope, event.seq);
            }

            this.ctx.waitUntil(this.runJob(jobId, config));
          }
        }

        await this.rearmAlarmDurably(Date.now() + WATCHDOG_MS);
        return;
      }

      // Terminal: retention duty. Not yet due -> re-arm for the real deadline.
      const retentionDays = Number(this.env.RETENTION_DAYS ?? "7") || 7;
      const retentionAt =
        row.created_at + retentionDays * 24 * 60 * 60 * 1000;
      if (Date.now() < retentionAt) {
        await this.rearmAlarmDurably(retentionAt);
        return;
      }

      // Delete every staged PDF and the results doc from R2. R2 delete on a
      // missing key is a no-op, so re-running is safe.
      const keys: string[] = [`results/${jobId}.json`];
      for (let i = 0; i < row.total_pdfs; i++) {
        keys.push(`pdfs/${jobId}/${i}.pdf`);
      }
      await this.env.RESULT_BUCKET.delete(keys);

      // Finally drop all DO storage (tables + any alarm). deleteAll also clears
      // the alarm, so we won't fire again.
      await this.ctx.storage.deleteAll();
    } catch (err) {
      // Idempotency: on ANY failure, persist a retry alarm before returning so
      // we never leak R2 objects or strand a non-terminal finalization.
      console.error("job alarm failed; rescheduling:", err);
      await this.rearmAlarmDurably(Date.now() + 60 * 60 * 1000); // +1h
    }
  }
}

/** Read a response body as text without throwing (for error detail). */
async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "";
  }
}

/**
 * Compute the average Access Score per brand across a job's per-PDF `result`
 * payloads (the materialized byPdf map). Used to build the cohort webhook /
 * cohort_runs summary. Scores live at result.result["Access Score"] (mirrors
 * ExtractResult); brand at result.result.Brand (uppercased). Brands with no
 * numeric score are skipped. Returns brand -> rounded mean score.
 */
function perBrandAccess(
  byPdf: Map<number, Record<string, unknown>[]>
): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const events of byPdf.values()) {
    for (const e of events) {
      const result = (e as { result?: unknown }).result as
        | Record<string, unknown>
        | undefined;
      if (!result || typeof result !== "object") continue;
      const brandRaw = result["Brand"];
      const brand =
        typeof brandRaw === "string" ? brandRaw.trim().toUpperCase() : "";
      if (!brand) continue;
      const scoreRaw = result["Access Score"];
      const score =
        typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
      if (!Number.isFinite(score)) continue;
      const cur = sums.get(brand) ?? { total: 0, count: 0 };
      cur.total += score;
      cur.count += 1;
      sums.set(brand, cur);
    }
  }
  const out: Record<string, number> = {};
  for (const [brand, { total, count }] of sums) {
    if (count > 0) out[brand] = Math.round(total / count);
  }
  return out;
}
