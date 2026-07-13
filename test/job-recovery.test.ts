import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ensureCohortSchema } from "../src/cohorts";
import {
  JobCoordinator,
  type JobConfig,
  type JobResults,
  type JobStatus,
} from "../src/job-coordinator";

interface CoordinatorHarness {
  alarm(): Promise<void>;
  runJob(jobId: string, config: JobConfig): Promise<void>;
  emitRawLine(
    jobId: string,
    pdfIndex: number,
    filename: string,
    line: string,
    attempt: number
  ): { done: boolean; fatalError?: string };
  markPdf(
    jobId: string,
    pdfIndex: number,
    attempt: number,
    status: JobStatus,
    error?: string
  ): boolean;
  finalizeJob(jobId: string, config: JobConfig): Promise<void>;
  initSchema(): void;
}

type StoredEvent = {
  seq_num: number;
  event_type: string;
  pdf_index: number;
  attempt: number;
  payload: string;
};

const coordinatorNamespace = (
  env as unknown as {
    JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  }
).JOB_COORDINATOR;
const db = (env as unknown as { LIBRARY: D1Database }).LIBRARY;
const bucket = (env as unknown as { RESULT_BUCKET: R2Bucket }).RESULT_BUCKET;

function makeResultEvent(
  filename: string,
  brand: string,
  score: number,
  marker: string
): Record<string, unknown> {
  return {
    event: "result",
    brand,
    result: {
      Filename: filename,
      Brand: brand,
      Age: "18+",
      "Prescriber Requirements": "NA",
      "Clinical Requirements": marker,
      "Number of Steps through Brands": "0",
      "Number of Steps through Generic": "0",
      "Step through-Phototherapy": "No",
      "TB Test required": "No",
      "Quantity Limits": "NA",
      "Specialist Types": "NA",
      "Initial Authorization Duration(in-months)": "12",
      "Reauthorization Duration(in-months)": "12",
      "Reauthorization Required": "Yes",
      "Reauthorization Requirements Documented in Policy": "Yes",
      "Access Score": score,
    },
    access_justification: marker,
    meta: {
      source: "reduced",
      full_markdown_chars: 100,
      reduced_chars: 50,
      reduction_pct: 50,
      timings_ms: {
        docling_ms: 1,
        reduce_ms: 1,
        extract_ms: 1,
        score_ms: 1,
      },
      model: "test-model",
      runs: 1,
    },
    policy_text: marker,
  };
}

function envelope(
  raw: Record<string, unknown>,
  pdfIndex: number,
  filename: string,
  seq: number
): Record<string, unknown> {
  return {
    ...raw,
    pdf_index: pdfIndex,
    filename,
    seq_num: seq,
  };
}

describe("attempt-aware watchdog recovery", () => {
  it("resets only the orphan, replays in order, and aggregates only attempt 2", async () => {
    const jobId = crypto.randomUUID();
    const cohortId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const owner = `recovery-${jobId}@example.test`;
    const filename = "recover.pdf";
    const siblingFilename = "terminal-sibling.pdf";
    const createdAt = Date.now();
    const config: JobConfig = {
      brands: "TREMFYA,SKYRIZI",
      runs: 1,
      explain: false,
      pdfs: [
        { index: 0, filename },
        { index: 1, filename: siblingFilename },
      ],
      owner,
      cohort_id: cohortId,
      run_id: runId,
    };

    await ensureCohortSchema(db);
    await db
      .prepare(
        `INSERT INTO cohort_runs
           (id, cohort_id, owner, created_at, job_id, status, summary_json)
         VALUES (?, ?, ?, ?, ?, 'running', NULL)`
      )
      .bind(runId, cohortId, owner, createdAt, jobId)
      .run();

    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(jobId)
    );

    const durableState = await runInDurableObject(
      stub,
      async (instance, state) => {
        const coordinator = instance as unknown as CoordinatorHarness;
        const sql = state.storage.sql;
        const oldResult = makeResultEvent(
          filename,
          "TREMFYA",
          100,
          "stale-attempt-1"
        );
        const oldError = {
          event: "error",
          brand: "STELARA",
          error: "stale-attempt-1-error",
        };

        sql.exec(
          `INSERT INTO jobs
             (id, status, created_at, total_pdfs, completed_pdfs,
              failed_pdfs, config_json)
           VALUES (?, 'running', ?, 2, 0, 1, ?)`,
          jobId,
          createdAt,
          JSON.stringify(config)
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error, file_sha256)
           VALUES (0, ?, 'running', 1, 1, NULL, ?)`,
          filename,
          "a".repeat(64)
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error, file_sha256)
           VALUES (1, ?, 'failed', 1, 0, ?, NULL)`,
          siblingFilename,
          "terminal sibling stays failed"
        );
        sql.exec(
          `INSERT INTO job_events
             (seq_num, event_type, pdf_index, attempt, brand, payload, created_at)
           VALUES (1, 'result', 0, 1, 'TREMFYA', ?, ?)`,
          JSON.stringify(envelope(oldResult, 0, filename, 1)),
          createdAt
        );
        sql.exec(
          `INSERT INTO job_events
             (seq_num, event_type, pdf_index, attempt, brand, payload, created_at)
           VALUES (2, 'error', 0, 1, 'STELARA', ?, ?)`,
          JSON.stringify(envelope(oldError, 0, filename, 2)),
          createdAt
        );

        const runJobSpy = vi
          .spyOn(coordinator, "runJob")
          .mockResolvedValue(undefined);
        await coordinator.alarm();
        expect(runJobSpy).toHaveBeenCalledOnce();
        expect(runJobSpy).toHaveBeenCalledWith(jobId, config);
        runJobSpy.mockRestore();

        const afterReset = sql
          .exec<{
            pdf_index: number;
            status: string;
            attempt: number;
            results: number;
            error: string | null;
          }>(
            `SELECT pdf_index, status, attempt, results, error
             FROM job_pdfs ORDER BY pdf_index`
          )
          .toArray();

        expect(afterReset).toEqual([
          {
            pdf_index: 0,
            status: "pending",
            attempt: 2,
            results: 0,
            error: null,
          },
          {
            pdf_index: 1,
            status: "failed",
            attempt: 1,
            results: 0,
            error: "terminal sibling stays failed",
          },
        ]);

        const newResult = makeResultEvent(
          filename,
          "TREMFYA",
          25,
          "active-attempt-2"
        );
        coordinator.emitRawLine(
          jobId,
          0,
          filename,
          JSON.stringify(newResult),
          2
        );
        coordinator.emitRawLine(
          jobId,
          0,
          filename,
          JSON.stringify({
            event: "error",
            brand: "SKYRIZI",
            error: "active-attempt-2-error",
          }),
          2
        );
        expect(coordinator.markPdf(jobId, 0, 2, "complete")).toBe(true);

        await coordinator.finalizeJob(jobId, config);
        await state.storage.deleteAlarm();

        const rows = sql
          .exec<StoredEvent>(
            `SELECT seq_num, event_type, pdf_index, attempt, payload
             FROM job_events ORDER BY seq_num`
          )
          .toArray();
        const sibling = sql
          .exec<{
            status: string;
            attempt: number;
            results: number;
            error: string | null;
          }>(
            `SELECT status, attempt, results, error
             FROM job_pdfs WHERE pdf_index = 1`
          )
          .one();
        const counters = sql
          .exec<{
            status: string;
            completed_pdfs: number;
            failed_pdfs: number;
          }>(
            `SELECT status, completed_pdfs, failed_pdfs
             FROM jobs WHERE id = ?`,
            jobId
          )
          .one();

        return { rows, sibling, counters };
      }
    );

    const replay = durableState.rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));

    expect(replay.map((row) => row.seq_num)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(replay.map((row) => row.event_type)).toEqual([
      "result",
      "error",
      "pdf_reset",
      "result",
      "error",
      "job_done",
    ]);
    expect(replay.map((row) => row.attempt)).toEqual([1, 1, 2, 2, 2, 0]);
    expect(replay[2].payload).toEqual({
      event: "pdf_reset",
      reason: "watchdog_resume",
      previous_attempt: 1,
      attempt: 2,
      pdf_index: 0,
      filename,
      seq_num: 3,
    });
    expect(durableState.sibling).toEqual({
      status: "failed",
      attempt: 1,
      results: 0,
      error: "terminal sibling stays failed",
    });
    expect(durableState.counters).toEqual({
      status: "complete",
      completed_pdfs: 1,
      failed_pdfs: 1,
    });

    const stored = await bucket.get(`results/${jobId}.json`);
    if (!stored) throw new Error("missing aggregated results document");
    const results = JSON.parse(await stored.text()) as JobResults;

    expect(results.pdfs).toHaveLength(2);
    expect(results.pdfs[0].results).toHaveLength(1);
    expect(
      (
        results.pdfs[0].results[0].result as Record<string, unknown>
      )["Access Score"]
    ).toBe(25);
    expect(results.pdfs[0].errors).toEqual([
      { brand: "SKYRIZI", message: "active-attempt-2-error" },
    ]);
    expect(results.pdfs[1]).toMatchObject({
      index: 1,
      filename: siblingFilename,
      status: "failed",
      error: "terminal sibling stays failed",
      results: [],
      errors: [],
    });

    const libraryRows = (
      await db
        .prepare(
          `SELECT result_key, brand, access_score
           FROM analyses
           WHERE owner = ? AND job_id = ?
           ORDER BY created_at`
        )
        .bind(owner, jobId)
        .all<{
          result_key: string;
          brand: string;
          access_score: number | null;
        }>()
    ).results;

    expect(libraryRows).toHaveLength(1);
    expect(libraryRows[0]).toMatchObject({
      brand: "TREMFYA",
      access_score: 25,
    });

    const libraryObject = await bucket.get(libraryRows[0].result_key);
    if (!libraryObject) throw new Error("missing library result object");
    const libraryResult = JSON.parse(
      await libraryObject.text()
    ) as Record<string, unknown>;
    expect(
      (libraryResult.result as Record<string, unknown>)["Access Score"]
    ).toBe(25);

    const cohortRun = await db
      .prepare(
        `SELECT status, summary_json
         FROM cohort_runs WHERE id = ? AND owner = ?`
      )
      .bind(runId, owner)
      .first<{ status: string; summary_json: string | null }>();
    expect(cohortRun?.status).toBe("complete");
    const summary = JSON.parse(cohortRun?.summary_json || "{}") as {
      totals?: {
        total_pdfs: number;
        completed_pdfs: number;
        failed_pdfs: number;
      };
      per_brand_access?: Record<string, number>;
    };
    expect(summary.totals).toEqual({
      total_pdfs: 2,
      completed_pdfs: 1,
      failed_pdfs: 1,
    });
    expect(summary.per_brand_access).toEqual({ TREMFYA: 25 });

    await bucket.delete([
      `results/${jobId}.json`,
      libraryRows[0].result_key,
    ]);
    await db
      .prepare("DELETE FROM analyses WHERE owner = ? AND job_id = ?")
      .bind(owner, jobId)
      .run();
    await db
      .prepare("DELETE FROM cohort_runs WHERE id = ? AND owner = ?")
      .bind(runId, owner)
      .run();
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  });

  it("does not reset or bump attempts when every PDF is already terminal", async () => {
    const jobId = crypto.randomUUID();
    const createdAt = Date.now();
    const config: JobConfig = {
      brands: "TREMFYA",
      runs: 1,
      explain: false,
      pdfs: [
        { index: 0, filename: "complete.pdf" },
        { index: 1, filename: "failed.pdf" },
      ],
    };
    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(jobId)
    );

    const snapshot = await runInDurableObject(
      stub,
      async (instance, state) => {
        const coordinator = instance as unknown as CoordinatorHarness;
        const sql = state.storage.sql;

        sql.exec(
          `INSERT INTO jobs
             (id, status, created_at, total_pdfs, completed_pdfs,
              failed_pdfs, config_json)
           VALUES (?, 'running', ?, 2, 1, 1, ?)`,
          jobId,
          createdAt,
          JSON.stringify(config)
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error)
           VALUES (0, 'complete.pdf', 'complete', 3, 1, NULL)`
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error)
           VALUES (1, 'failed.pdf', 'failed', 4, 0, 'terminal failure')`
        );

        const runJobSpy = vi
          .spyOn(coordinator, "runJob")
          .mockResolvedValue(undefined);
        await coordinator.alarm();
        expect(runJobSpy).toHaveBeenCalledOnce();
        runJobSpy.mockRestore();
        await state.storage.deleteAlarm();

        return {
          pdfs: sql
            .exec<{
              pdf_index: number;
              status: string;
              attempt: number;
              results: number;
              error: string | null;
            }>(
              `SELECT pdf_index, status, attempt, results, error
               FROM job_pdfs ORDER BY pdf_index`
            )
            .toArray(),
          resetCount: sql
            .exec<{ count: number }>(
              `SELECT COUNT(*) AS count
               FROM job_events WHERE event_type = 'pdf_reset'`
            )
            .one().count,
          counters: sql
            .exec<{
              status: string;
              completed_pdfs: number;
              failed_pdfs: number;
            }>(
              `SELECT status, completed_pdfs, failed_pdfs
               FROM jobs WHERE id = ?`,
              jobId
            )
            .one(),
        };
      }
    );

    expect(snapshot.pdfs).toEqual([
      {
        pdf_index: 0,
        status: "complete",
        attempt: 3,
        results: 1,
        error: null,
      },
      {
        pdf_index: 1,
        status: "failed",
        attempt: 4,
        results: 0,
        error: "terminal failure",
      },
    ]);
    expect(snapshot.resetCount).toBe(0);
    expect(snapshot.counters).toEqual({
      status: "running",
      completed_pdfs: 1,
      failed_pdfs: 1,
    });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  });

  it("migrates legacy PDF and event rows to attempt 1", async () => {
    const jobId = crypto.randomUUID();
    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(jobId)
    );

    const migrated = await runInDurableObject(
      stub,
      async (instance, state) => {
        const coordinator = instance as unknown as CoordinatorHarness;
        const sql = state.storage.sql;

        sql.exec("DROP TABLE job_events");
        sql.exec("DROP TABLE job_pdfs");
        sql.exec(
          `CREATE TABLE job_events (
             seq_num     INTEGER PRIMARY KEY,
             event_type  TEXT NOT NULL,
             pdf_index   INTEGER NOT NULL,
             brand       TEXT,
             payload     TEXT NOT NULL,
             created_at  INTEGER NOT NULL
           )`
        );
        sql.exec(
          `CREATE TABLE job_pdfs (
             pdf_index   INTEGER PRIMARY KEY,
             filename    TEXT NOT NULL,
             status      TEXT NOT NULL,
             results     INTEGER NOT NULL DEFAULT 0,
             error       TEXT,
             file_sha256 TEXT
           )`
        );
        sql.exec(
          `INSERT INTO job_events
             (seq_num, event_type, pdf_index, brand, payload, created_at)
           VALUES (1, 'result', 0, 'TREMFYA', '{}', ?)` ,
          Date.now()
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, results, error, file_sha256)
           VALUES (0, 'legacy.pdf', 'running', 1, NULL, NULL)`
        );

        coordinator.initSchema();

        return {
          pdfAttempt: sql
            .exec<{ attempt: number }>(
              "SELECT attempt FROM job_pdfs WHERE pdf_index = 0"
            )
            .one().attempt,
          eventAttempt: sql
            .exec<{ attempt: number }>(
              "SELECT attempt FROM job_events WHERE seq_num = 1"
            )
            .one().attempt,
        };
      }
    );

    expect(migrated).toEqual({ pdfAttempt: 1, eventAttempt: 1 });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
    });
  });
});
