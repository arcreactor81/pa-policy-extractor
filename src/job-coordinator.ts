/**
 * job-coordinator.ts — Layer 3: async / batch / persistent jobs.
 *
 * The JobCoordinator is a SQLite-backed Durable Object that owns the lifecycle
 * of a multi-PDF extraction job:
 *
 *   1. The Worker stores each uploaded PDF in R2 (pdfs/<jobId>/<index>.pdf) and
 *      then calls this DO's `start(...)` to kick the job off.
 *   2. The DO processes the PDFs with a small concurrency SEMAPHORE
 *      (MAX_CONCURRENT_PDFS, default 2, always <= container max_instances). For
 *      each PDF it reads the bytes back from R2, builds a multipart body
 *      (file + brands + runs + explain [+ consensus] — exactly the fields
 *      container/app.py's POST /analyze expects) and streams the NDJSON response.
 *   3. Every container event is given a monotonic `seq_num`, wrapped with
 *      {pdf_index, filename, seq_num}, appended to the `job_events` SQLite log
 *      AND broadcast to every connected (hibernatable) WebSocket for this job.
 *   4. When all PDFs finish, the aggregated results are written to R2
 *      (results/<jobId>.json), the job is marked complete, and a terminal
 *      {"event":"job_done", ...} event is emitted.
 *   5. The DO's single alarm slot is multiplexed: while the job is NON-terminal
 *      it is a short-cadence WATCHDOG that resumes processing orphaned by a DO
 *      restart (processing rides waitUntil, which restarts silently kill);
 *      once terminal it becomes the retention alarm (RETENTION_DAYS, default 7)
 *      that deletes the job's R2 objects + this DO's storage. Idempotent.
 *
 * WebSocket streaming uses the HIBERNATION API (acceptWebSocket /
 * getWebSockets / serializeAttachment) so an idle job bills zero duration while
 * a client stays connected. On (re)connect the client passes ?lastSeq=N and we
 * REPLAY every stored event with seq_num > N from SQLite before going live, so a
 * dropped connection (e.g. across a deploy) loses nothing.
 *
 * VERIFIED-DOC GOTCHAS honoured here:
 *   - storage.sql.exec() cursors are consumed SYNCHRONOUSLY (spread into an
 *     array / .toArray() / .one()) BEFORE any `await` — a cursor left open
 *     across an await is invalid.
 *   - serializeAttachment is capped (~16KB) — we only ever attach the tiny
 *     {jobId,lastSeq} bookkeeping object.
 *   - WebSockets drop on deploy; replay-on-reconnect is the recovery path.
 *   - A DO may make subrequests to the container and read long response streams
 *     (this is I/O, not CPU — no CPU-wall limit).
 */

import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Env } from "../worker-configuration";
import type { ExtractResult } from "./types";
import { persistResults } from "./library";
import { validateWebhookUrl } from "./util";

/** Container instance-name prefix — mirrors the Worker's sticky routing so the
 * SAME PDF (by sha256) lands on the SAME warm container instance (OCR-once). */
const ROUTE_PREFIX = "pa-";

/** Job lifecycle states persisted in the `jobs` table. */
export type JobStatus = "pending" | "running" | "complete" | "failed";

/** The immutable job config captured at submission time (stored as JSON). */
export interface JobConfig {
  /** CSV of brands forwarded to the container's `brands` field. */
  brands: string;
  /** Repeated extraction+scoring runs (1..5) — container `runs` field. */
  runs: number;
  /** Source-span explainability pass — container `explain` field. */
  explain: boolean;
  /**
   * W3-ext multi-model consensus — container `consensus` field. Optional for
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

  // ── W5 (cohort runs) — all optional; absent for a normal /api/jobs batch ─────

  /**
   * Validated https webhook URL to notify on finalize (a cohort run). The DO
   * re-applies the SSRF guard before POSTing and the POST is BEST-EFFORT — a
   * webhook failure NEVER fails the job.
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

/** Hex-encode an ArrayBuffer (used for the sha256 container route key). */
function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** sha256-hex of the PDF bytes — the sticky container instance key. */
async function sha256hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(digest);
}

/**
 * Decide a PDF's terminal status once its stream cleanly reached `done`:
 * per-brand errors are non-fatal in-stream, so a PDF whose brands ALL errored
 * still reaches `done` having produced ZERO `result` events. Treating that as
 * "complete" would silently drop the PDF from the results — fail it instead
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
 * orphans — observed live: a job sat status="running" / PDF "pending" for hours
 * because the only alarm was retention, days away. While non-terminal, the
 * alarm slot is a short-cadence watchdog that resumes orphaned processing;
 * only a TERMINAL job schedules the retention alarm.
 */
const WATCHDOG_MS = 3 * 60 * 1000;

/**
 * Idle guard on the container NDJSON stream. The container heartbeats every
 * few seconds even mid-OCR, so a read that delivers nothing for this long is a
 * dead instance (e.g. restarted mid-stream) — fail the PDF instead of awaiting
 * a body that will never end.
 */
const STREAM_IDLE_MS = 180 * 1000;

/**
 * Abandon ceiling: a job still non-terminal this long after creation has been
 * resurrected repeatedly without converging (instance churn, persistent
 * container failure). Mark it failed so pollers see a terminal state instead
 * of an eternal "running".
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

  /** Create the two tables if absent. Cursor consumed implicitly (DDL, no rows). */
  private initSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id              TEXT PRIMARY KEY,
         status          TEXT NOT NULL,
         created_at      INTEGER NOT NULL,
         total_pdfs      INTEGER NOT NULL,
         completed_pdfs  INTEGER NOT NULL DEFAULT 0,
         failed_pdfs     INTEGER NOT NULL DEFAULT 0,
         config_json     TEXT NOT NULL
       );`
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS job_events (
         seq_num     INTEGER PRIMARY KEY,
         event_type  TEXT NOT NULL,
         pdf_index   INTEGER NOT NULL,
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
         results     INTEGER NOT NULL DEFAULT 0,
         error       TEXT,
         file_sha256 TEXT
       );`
    );
    // Defensive migration: the v3 migration already created this DO class, so a
    // DEPLOYED JobCoordinator's job_pdfs table predates the file_sha256 column
    // and CREATE TABLE IF NOT EXISTS above will NOT add it. ALTER it in for those
    // older instances. SQLite has no "ADD COLUMN IF NOT EXISTS", so adding a
    // column that already exists throws "duplicate column name" — which we
    // swallow, making this idempotent for both fresh and existing tables.
    try {
      sql.exec("ALTER TABLE job_pdfs ADD COLUMN file_sha256 TEXT");
    } catch {
      // Column already present (fresh table or a prior run) — nothing to do.
    }
  }

  // ── seq_num allocation ──────────────────────────────────────────────────────

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

  // ── Worker → DO control plane ───────────────────────────────────────────────

  /**
   * HTTP surface the Worker uses to drive the DO:
   *   POST /start            → begin processing (body: StartJobBody)
   *   GET  /state            → JobStateResponse JSON
   *   GET  /stream?lastSeq=N → WebSocket upgrade (replay + live)
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
  private handleStart(body: StartJobBody): Response {
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
      "INSERT INTO jobs (id, status, created_at, total_pdfs, completed_pdfs, failed_pdfs, config_json) VALUES (?, ?, ?, ?, 0, 0, ?)",
      body.jobId,
      "running",
      createdAt,
      body.pdfs.length,
      JSON.stringify(config)
    );

    for (const pdf of body.pdfs) {
      sql.exec(
        "INSERT INTO job_pdfs (pdf_index, filename, status, results, error) VALUES (?, ?, 'pending', 0, NULL)",
        pdf.index,
        pdf.filename
      );
    }

    // WATCHDOG alarm (not retention): while the job is non-terminal the alarm
    // slot guards against a DO restart orphaning the waitUntil-driven
    // processing below. runJob schedules the retention alarm once terminal.
    void this.ctx.storage.setAlarm(createdAt + WATCHDOG_MS);

    // Process in the background so the control-plane call returns instantly.
    // waitUntil keeps the DO alive until processing finishes even though fetch
    // has returned.
    this.ctx.waitUntil(this.runJob(body.jobId, config));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  // ── Job processing (semaphore + container fan-out) ──────────────────────────

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
      // Terminal (finalizeJob ran, even on the all-failed path): hand the alarm
      // slot to retention. On an unexpected throw the job may still be
      // non-terminal — the watchdog scheduled by alarm()/handleStart resumes it.
      const rows = this.ctx.storage.sql
        .exec<{ status: string; created_at: number }>(
          "SELECT status, created_at FROM jobs WHERE id = ?",
          jobId
        )
        .toArray();
      if (rows.length && (rows[0].status === "complete" || rows[0].status === "failed")) {
        const retentionDays = Number(this.env.RETENTION_DAYS ?? "7") || 7;
        void this.ctx.storage.setAlarm(
          Math.max(
            Date.now() + 1000,
            rows[0].created_at + retentionDays * 24 * 60 * 60 * 1000
          )
        );
      }
    }
  }

  /**
   * Drive every PDF through the container with a bounded concurrency semaphore,
   * then aggregate + persist results and emit the terminal job_done event.
   */
  private async processJob(jobId: string, config: JobConfig): Promise<void> {
    const maxConcurrent = Math.max(
      1,
      Number(this.env.MAX_CONCURRENT_PDFS ?? "2") || 2
    );

    // RESUME-SAFE queue: only PDFs not already terminal. On a fresh start that
    // is every PDF; on a watchdog resume after a DO restart, completed/failed
    // PDFs keep their state and only the orphaned ones re-run.
    const terminal = new Set(
      this.ctx.storage.sql
        .exec<{ pdf_index: number }>(
          "SELECT pdf_index FROM job_pdfs WHERE status IN ('complete','failed')"
        )
        .toArray()
        .map((r) => r.pdf_index)
    );
    const queue = config.pdfs.filter((p) => !terminal.has(p.index));
    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      for (;;) {
        const pdf = queue.shift();
        if (!pdf) return;
        await this.processPdf(jobId, config, pdf.index, pdf.filename);
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
    filename: string
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
      // for finalizeJob to read back. Cursor: DML, no rows.
      const sha = await sha256hex(bytes);
      this.ctx.storage.sql.exec(
        "UPDATE job_pdfs SET file_sha256 = ? WHERE pdf_index = ?",
        sha,
        pdfIndex
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
        filename
      );

      // The container streamed a PDF-LEVEL fatal (an {"event":"error"} with no
      // "brand" key — e.g. "OCR failed" / last-resort "extraction failed") and/or
      // never emitted the trailing {"event":"done"}. The HTTP transport was fine
      // (res.ok), so only the in-band stream tells us the extraction crashed.
      // Record the PDF as FAILED (a per-brand error still leaves it complete).
      if (!outcome.ok) {
        this.markPdf(
          pdfIndex,
          "failed",
          outcome.fatalError ?? "extraction did not complete"
        );
        this.bumpJobCounter(jobId, "failed_pdfs");
        return;
      }

      // The stream reached `done`, but `done` alone does not mean any brand
      // succeeded: per-brand errors are non-fatal, so EVERY brand may have
      // errored with zero `result` events. Read back the per-PDF result count
      // (tracked in job_pdfs by emitRawLine) and fail such a PDF instead of
      // recording an empty "complete". Cursor consumed synchronously.
      const countRows = this.ctx.storage.sql
        .exec<{ results: number }>(
          "SELECT results FROM job_pdfs WHERE pdf_index = ?",
          pdfIndex
        )
        .toArray();
      const resultCount = countRows.length ? countRows[0].results : 0;
      const verdict = pdfOutcomeAfterDone(resultCount);
      if (verdict.status === "failed") {
        this.markPdf(pdfIndex, "failed", verdict.error);
        this.bumpJobCounter(jobId, "failed_pdfs");
        return;
      }

      // Per-PDF success.
      this.markPdf(pdfIndex, "complete");
      this.bumpJobCounter(jobId, "completed_pdfs");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface a per-PDF error event into the log/stream (mirrors the
      // container's own per-brand error shape but at PDF granularity).
      this.emit(jobId, pdfIndex, filename, {
        event: "error",
        error: message,
      });
      this.markPdf(pdfIndex, "failed", message);
      this.bumpJobCounter(jobId, "failed_pdfs");
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
   * per-brand error ({"event":"error","brand":...}) is non-fatal — the run still
   * reaches `done`. So the PDF succeeded iff we saw `done` and no PDF-level error.
   */
  private async consumeNdjson(
    body: ReadableStream<Uint8Array>,
    jobId: string,
    pdfIndex: number,
    filename: string
  ): Promise<{ ok: boolean; fatalError?: string }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let sawDone = false;
    let fatalError: string | undefined;

    const observe = (line: string): void => {
      const out = this.emitRawLine(jobId, pdfIndex, filename, line);
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
      // body that never ends — the watchdog/caller error path takes over.
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
    line: string
  ): { done: boolean; fatalError?: string } {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Non-JSON noise from the stream — wrap it so nothing is silently lost.
      parsed = { event: "error", error: "malformed event from container" };
    }
    this.emit(jobId, pdfIndex, filename, parsed);

    // Track per-PDF result count for the poll endpoint.
    if (parsed.event === "result") {
      this.ctx.storage.sql.exec(
        "UPDATE job_pdfs SET results = results + 1 WHERE pdf_index = ?",
        pdfIndex
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
   * Assign the next seq_num, wrap the raw event, PERSIST it to job_events, and
   * BROADCAST it to every connected WebSocket for this job. All SQLite cursors
   * here are consumed synchronously (nextSeq reads-then-caches; the INSERT
   * returns no rows). There is no `await` inside this method.
   */
  private emit(
    jobId: string,
    pdfIndex: number,
    filename: string,
    raw: Record<string, unknown>
  ): void {
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
      "INSERT INTO job_events (seq_num, event_type, pdf_index, brand, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      seq,
      eventType,
      pdfIndex,
      brand,
      JSON.stringify(envelope),
      Date.now()
    );

    this.broadcast(jobId, envelope, seq);
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

  /** Update a PDF row's status (+ optional error). Cursor: DML, no rows. */
  private markPdf(pdfIndex: number, status: JobStatus, error?: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE job_pdfs SET status = ?, error = ? WHERE pdf_index = ?",
      status,
      error ?? null,
      pdfIndex
    );
  }

  /**
   * Atomically increment one of the job's counters. Cursor: DML, no rows.
   * The DO is one-job, so the unqualified UPDATE would hit the right row; the
   * `WHERE id = ?` is a defensive guard scoping the write to this job's row.
   */
  private bumpJobCounter(
    jobId: string,
    column: "completed_pdfs" | "failed_pdfs"
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET ${column} = ${column} + 1 WHERE id = ?`,
      jobId
    );
  }

  /**
   * Aggregate every PDF's `result` events from the log, write the results doc to
   * R2, mark the job complete (or failed if every PDF failed), and emit the
   * terminal job_done event.
   */
  private async finalizeJob(jobId: string, config: JobConfig): Promise<void> {
    const sql = this.ctx.storage.sql;

    // Pull final job + per-PDF state synchronously.
    const jobRows = sql
      .exec<{
        created_at: number;
        completed_pdfs: number;
        failed_pdfs: number;
        total_pdfs: number;
      }>(
        "SELECT created_at, completed_pdfs, failed_pdfs, total_pdfs FROM jobs WHERE id = ?",
        jobId
      )
      .toArray();
    const job = jobRows[0];

    const pdfRows = sql
      .exec<{
        pdf_index: number;
        filename: string;
        status: string;
        error: string | null;
        file_sha256: string | null;
      }>(
        "SELECT pdf_index, filename, status, error, file_sha256 FROM job_pdfs ORDER BY pdf_index"
      )
      .toArray();

    // Collect the `result` payloads per PDF from the event log.
    const resultRows = sql
      .exec<{ pdf_index: number; payload: string }>(
        "SELECT pdf_index, payload FROM job_events WHERE event_type = 'result' ORDER BY seq_num"
      )
      .toArray();

    const byPdf = new Map<number, Record<string, unknown>[]>();
    for (const row of resultRows) {
      const list = byPdf.get(row.pdf_index) ?? [];
      list.push(JSON.parse(row.payload) as Record<string, unknown>);
      byPdf.set(row.pdf_index, list);
    }

    // Collect the per-BRAND `error` events per PDF so the results doc records
    // WHY a brand is missing from `results`. PDF-level fatals carry no brand
    // (they already surface via the per-PDF `error` column) and are skipped.
    const errorRows = sql
      .exec<{ pdf_index: number; brand: string | null; payload: string }>(
        "SELECT pdf_index, brand, payload FROM job_events WHERE event_type = 'error' ORDER BY seq_num"
      )
      .toArray();

    const errorsByPdf = new Map<number, { brand: string; message: string }[]>();
    for (const row of errorRows) {
      if (typeof row.brand !== "string" || !row.brand) continue;
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const message =
        typeof payload.error === "string" ? payload.error : "extraction failed";
      const list = errorsByPdf.get(row.pdf_index) ?? [];
      list.push({ brand: row.brand, message });
      errorsByPdf.set(row.pdf_index, list);
    }

    const finishedAt = Date.now();
    const results: JobResults = {
      jobId,
      created_at: job?.created_at ?? finishedAt,
      finished_at: finishedAt,
      config: { brands: config.brands, runs: config.runs, explain: config.explain },
      pdfs: pdfRows.map((p) => ({
        index: p.pdf_index,
        filename: p.filename,
        status: p.status as JobStatus,
        error: p.error ?? undefined,
        results: byPdf.get(p.pdf_index) ?? [],
        errors: errorsByPdf.get(p.pdf_index) ?? [],
      })),
    };

    // Persist the aggregated results to R2 (served by GET /api/results).
    await this.env.RESULT_BUCKET.put(
      `results/${jobId}.json`,
      JSON.stringify(results),
      { httpMetadata: { contentType: "application/json" } }
    );

    // Job is complete unless EVERY PDF failed.
    const total = job?.total_pdfs ?? config.pdfs.length;
    const failed = job?.failed_pdfs ?? 0;
    const finalStatus: JobStatus = failed >= total && total > 0 ? "failed" : "complete";
    sql.exec("UPDATE jobs SET status = ? WHERE id = ?", finalStatus, jobId);

    // AUTHORITATIVE library persistence (server-side, survives client disconnect):
    // write each per-brand result to the OWNER's persistent library — full result
    // JSON to R2 (results/lib/<id>.json) + an index row to D1 — the SAME shape as
    // the Worker's POST /api/library. Best-effort: a library failure must NOT fail
    // the job (results/<jobId>.json is already persisted above). pdfRows/byPdf are
    // already materialized arrays/maps, so no SQLite cursor is open across these
    // awaits.
    const owner = config.owner && config.owner.trim() ? config.owner : "anonymous";
    for (const p of pdfRows) {
      const sha = p.file_sha256;
      if (!sha) continue; // PDF never processed (e.g. read failure) — nothing to cache.
      const events = byPdf.get(p.pdf_index) ?? [];
      // The stored `result` events are JobEvent envelopes: the container's result
      // payload (which mirrors ExtractResult) PLUS the routing/sequencing keys we
      // add (event/brand/pdf_index/filename/seq_num). Strip those envelope-only
      // keys so the R2 library doc is a clean ExtractResult (result +
      // access_justification + meta + confidence + spans + policy_text).
      const extractResults: ExtractResult[] = [];
      for (const e of events) {
        if ((e as { event?: unknown }).event !== "result") continue;
        const { event, brand, pdf_index, filename, seq_num, ...rest } =
          e as Record<string, unknown>;
        void event;
        void brand;
        void pdf_index;
        void filename;
        void seq_num;
        extractResults.push(rest as unknown as ExtractResult);
      }
      if (extractResults.length === 0) continue;
      try {
        await persistResults({
          db: this.env.LIBRARY,
          bucket: this.env.RESULT_BUCKET,
          owner,
          kind: "batch",
          jobId,
          fileSha256: sha,
          runs: config.runs,
          explain: config.explain,
          results: extractResults,
        });
      } catch (err) {
        console.error(
          `library persistence failed for job ${jobId} pdf ${p.pdf_index}:`,
          err
        );
      }
    }

    // ── W5 cohort run: update the cohort_runs row + fire the webhook ──────────
    // If this job was a COHORT RUN (cohort_id + run_id present in the config),
    // update its cohort_runs row with the terminal status + a JSON summary and,
    // if a webhook_url is set, POST that summary. ALL of this is BEST-EFFORT —
    // the job's own results are already persisted above, so a webhook/D1 failure
    // here must NEVER fail the job. byPdf is a materialized Map (no open cursor).
    if (config.cohort_id && config.run_id) {
      const summary = {
        cohort_id: config.cohort_id,
        run_id: config.run_id,
        job_id: jobId,
        status: finalStatus,
        totals: {
          total_pdfs: total,
          completed_pdfs: job?.completed_pdfs ?? 0,
          failed_pdfs: failed,
        },
        per_brand_access: perBrandAccess(byPdf),
      };

      // Update the cohort_runs row (owner-scoped). Best-effort.
      try {
        await this.env.LIBRARY.prepare(
          `UPDATE cohort_runs SET status = ?, summary_json = ? WHERE id = ? AND owner = ?`
        )
          .bind(finalStatus, JSON.stringify(summary), config.run_id, owner)
          .run();
      } catch (err) {
        console.error(`cohort_runs update failed for run ${config.run_id}:`, err);
      }

      // Fire the webhook (https + SSRF guard re-applied here). Best-effort.
      if (config.webhook_url) {
        await this.postWebhook(config.webhook_url, summary);
      }
    }

    // Terminal event (pdf_index -1 = job-level, filename "").
    this.emit(jobId, -1, "", {
      event: "job_done",
      status: finalStatus,
      total_pdfs: total,
      completed_pdfs: job?.completed_pdfs ?? 0,
      failed_pdfs: failed,
    });
  }

  /**
   * Best-effort, SSRF-guarded webhook POST (cohort run finalize). The URL was
   * validated when the cohort was saved/patched, but we RE-VALIDATE here (https
   * only; reject loopback / private / link-local / metadata hosts) because the DO
   * is the actual egress point. ANY failure (bad URL, network error, non-2xx) is
   * swallowed — a webhook problem must never fail the job. A short timeout keeps a
   * slow/hung endpoint from holding the DO open.
   */
  private async postWebhook(
    webhookUrl: string,
    summary: unknown
  ): Promise<void> {
    const verdict = validateWebhookUrl(webhookUrl);
    if ("error" in verdict) {
      console.error("cohort webhook rejected by SSRF guard:", verdict.error);
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        await fetch(verdict.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Make redirects a no-op so the validated host is the ONLY target;
            // a 30x to an internal host can never be silently followed.
            "user-agent": "pa-policy-extractor-cohort-webhook/1",
          },
          body: JSON.stringify(summary),
          redirect: "manual",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.error("cohort webhook POST failed (ignored):", err);
    }
  }

  // ── GET /state (poll) ───────────────────────────────────────────────────────

  private handleState(): Response {
    const sql = this.ctx.storage.sql;

    const jobRows = sql
      .exec<{
        id: string;
        status: string;
        created_at: number;
        total_pdfs: number;
        completed_pdfs: number;
        failed_pdfs: number;
        config_json: string;
      }>("SELECT * FROM jobs LIMIT 1")
      .toArray();

    if (jobRows.length === 0) {
      return new Response(JSON.stringify({ error: "job not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const job = jobRows[0];
    const config = JSON.parse(job.config_json) as JobConfig;

    // Poll-triggered self-heal: if the job is non-terminal but no processing
    // run is alive in this instance (orphaned by a DO restart), pull the
    // watchdog alarm forward so recovery starts in seconds, not minutes —
    // someone polling a stuck job is exactly the moment to fix it.
    if (
      job.status !== "complete" &&
      job.status !== "failed" &&
      !this.processing
    ) {
      void this.ctx.storage.setAlarm(Date.now() + 5_000);
    }

    const pdfRows = sql
      .exec<{
        pdf_index: number;
        filename: string;
        status: string;
        results: number;
        error: string | null;
      }>(
        "SELECT pdf_index, filename, status, results, error FROM job_pdfs ORDER BY pdf_index"
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
        results: p.results,
        error: p.error ?? undefined,
      })),
      last_seq: lastSeq,
      created_at: job.created_at,
    };

    return new Response(JSON.stringify(state), {
      headers: { "content-type": "application/json" },
    });
  }

  // ── GET /stream (WebSocket: replay + live, hibernatable) ─────────────────────

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

  // ── Hibernation handlers ────────────────────────────────────────────────────

  /**
   * Inbound client messages. The stream is server→client only; we accept a
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

  /** A socket closed — nothing to clean up (hibernation drops it for us). */
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

  // ── Alarm dispatcher: watchdog (non-terminal) / retention (terminal) ────────

  /**
   * One alarm slot, two duties.
   *
   * NON-TERMINAL job: this is the WATCHDOG. Processing rides a waitUntil
   * promise that a DO restart silently orphans (observed live: status
   * "running", PDF "pending", forever). If no processing run is alive in this
   * instance, resume it (resetting orphaned per-PDF counters so re-streamed
   * results don't double-count); past MAX_JOB_AGE_MS, abandon to a terminal
   * failed state instead. Either way, re-arm the watchdog — runJob hands the
   * slot to retention when the job lands terminal.
   *
   * TERMINAL job: retention. Before the retention timestamp, just re-arm for
   * it (covers legacy alarms and watchdog->retention handoff races); after it,
   * delete the job's R2 objects + this DO's storage. Idempotent: a partial
   * failure reschedules; a fully-deleted job re-running is a no-op.
   */
  override async alarm(): Promise<void> {
    try {
      const jobRows = this.ctx.storage.sql
        .exec<{
          id: string;
          total_pdfs: number;
          status: string;
          created_at: number;
          config_json: string;
        }>(
          "SELECT id, total_pdfs, status, created_at, config_json FROM jobs LIMIT 1"
        )
        .toArray();

      if (jobRows.length === 0) {
        // Already cleaned up — nothing to do.
        return;
      }
      const { id: jobId, total_pdfs } = jobRows[0];
      const row = jobRows[0];

      const isTerminal = row.status === "complete" || row.status === "failed";
      if (!isTerminal) {
        if (!this.processing) {
          if (Date.now() - row.created_at > MAX_JOB_AGE_MS) {
            // Abandon: repeated resurrection never converged. Terminal state so
            // pollers stop seeing an eternal "running".
            this.ctx.storage.sql.exec(
              "UPDATE jobs SET status = 'failed' WHERE id = ?",
              jobId
            );
            this.ctx.storage.sql.exec(
              "UPDATE job_pdfs SET status = 'failed', error = COALESCE(error, 'abandoned: job never completed (instance churn)') WHERE status NOT IN ('complete','failed')"
            );
          } else {
            // Orphaned processing — resume. Reset the counters of every
            // non-terminal PDF first: a partially-streamed PDF re-runs from
            // scratch, and its prior `result` events must not double-count.
            console.log(`watchdog: resuming orphaned job ${jobId}`);
            this.ctx.storage.sql.exec(
              "UPDATE job_pdfs SET results = 0, error = NULL WHERE status NOT IN ('complete','failed')"
            );
            const config = JSON.parse(row.config_json) as JobConfig;
            this.ctx.waitUntil(this.runJob(jobId, config));
          }
        }
        void this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
        return;
      }

      // Terminal: retention duty. Not yet due -> re-arm for the real deadline.
      const retentionDays = Number(this.env.RETENTION_DAYS ?? "7") || 7;
      const retentionAt = row.created_at + retentionDays * 24 * 60 * 60 * 1000;
      if (Date.now() < retentionAt) {
        void this.ctx.storage.setAlarm(retentionAt);
        return;
      }

      // Delete every staged PDF and the results doc from R2. R2 delete on a
      // missing key is a no-op, so re-running is safe.
      const keys: string[] = [`results/${jobId}.json`];
      for (let i = 0; i < total_pdfs; i++) {
        keys.push(`pdfs/${jobId}/${i}.pdf`);
      }
      await this.env.RESULT_BUCKET.delete(keys);

      // Finally drop all DO storage (tables + any alarm). deleteAll also clears
      // the alarm, so we won't fire again.
      await this.ctx.storage.deleteAll();
    } catch (err) {
      // Idempotency: on ANY failure, reschedule the alarm to retry shortly so
      // we never leak R2 objects. (Re-running is safe; deletes are no-ops.)
      console.error("retention alarm failed; rescheduling:", err);
      void this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000); // +1h
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
