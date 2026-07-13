import {
  abortAllDurableObjects,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ensureCohortSchema } from "../src/cohorts";
import {
  deterministicBatchResultId,
  ensureLibrarySchema,
  persistResults,
} from "../src/library";
import {
  JobCoordinator,
  type FinalizationState,
  type JobConfig,
  type JobResults,
  type JobStatus,
} from "../src/job-coordinator";
import type {
  AccessScore,
  ExtractResult,
  JobState,
} from "../src/types";

interface CoordinatorHarness {
  initSchema(): void;
  finalizeJob(jobId: string, config: JobConfig): Promise<void>;
  persistFinalizationLibrary(
    jobId: string,
    config: JobConfig,
    data: unknown
  ): Promise<void>;
  persistCohortStage(
    jobId: string,
    config: JobConfig,
    data: unknown
  ): Promise<void>;
  postWebhook(
    webhookUrl: string,
    summary: unknown,
    runId: string
  ): Promise<void>;
  advanceFinalization(
    jobId: string,
    current: FinalizationState,
    next: FinalizationState
  ): void;
  commitTerminal(
    jobId: string,
    finalStatus: JobStatus,
    raw: Record<string, unknown>,
    state: "terminal_committed" | "abandoned",
    finalizationError: string | null,
    expectedState?: FinalizationState
  ): void;
}

type ResumableState =
  | "prepared"
  | "aggregate_committed"
  | "library_committed"
  | "cohort_committed"
  | "webhook_committed";

type StoredJobRow = {
  status: string;
  created_at: number;
  total_pdfs: number;
  completed_pdfs: number;
  failed_pdfs: number;
  finalization_state: string;
  final_status: string | null;
  finalized_at: number | null;
  finalization_error: string | null;
};

type StoredPdfRow = {
  pdf_index: number;
  filename: string;
  status: string;
  attempt: number;
  results: number;
  error: string | null;
  file_sha256: string | null;
};

type StoredEventRow = {
  seq_num: number;
  event_type: string;
  pdf_index: number;
  attempt: number;
  payload: string;
};

type LibraryIndexRow = {
  id: string;
  created_at: number;
  owner: string;
  job_id: string | null;
  brand: string;
  result_key: string;
};

type SeededJob = {
  jobId: string;
  cohortId: string;
  runId: string;
  owner: string;
  filename: string;
  fileSha256: string | null;
  createdAt: number;
  finalizedAt: number;
  config: JobConfig;
  stub: ReturnType<typeof coordinatorNamespace.get>;
  activeResults: ExtractResult[];
  activeEnvelopes: Record<string, unknown>[];
};

type CleanupTarget = {
  jobId: string;
  stub: ReturnType<typeof coordinatorNamespace.get>;
};

const coordinatorNamespace = (
  env as unknown as {
    JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  }
).JOB_COORDINATOR;
const db = (env as unknown as { LIBRARY: D1Database }).LIBRARY;
const bucket = (
  env as unknown as { RESULT_BUCKET: R2Bucket }
).RESULT_BUCKET;

const WEBHOOK_URL = "https://webhook.example.com/finalize";
const MAX_JOB_AGE_MS = 12 * 60 * 60 * 1000;
const TEST_ALARM_DELAY_MS = 60_000;

const RESUME_STATES: ResumableState[] = [
  "prepared",
  "aggregate_committed",
  "library_committed",
  "cohort_committed",
  "webhook_committed",
];

const STATE_RANK: Record<ResumableState, number> = {
  prepared: 0,
  aggregate_committed: 1,
  library_committed: 2,
  cohort_committed: 3,
  webhook_committed: 4,
};

const ADVANCE_TARGETS: FinalizationState[] = [
  "aggregate_committed",
  "library_committed",
  "cohort_committed",
  "webhook_committed",
];

afterEach(() => {
  vi.restoreAllMocks();
});

function makeExtractResult(
  filename: string,
  brand: string,
  score: AccessScore,
  marker: string
): ExtractResult {
  return {
    result: {
      Filename: filename,
      Brand: brand,
      Age: "18+",
      "Step Therapy Requirements Documented in Policy": marker,
      "Number of Steps through Brands": "0",
      "Number of Steps through Generic": "0",
      "Step through-Phototherapy": "No",
      "TB Test required": "No",
      "Quantity Limits": "NA",
      "Specialist Types": "Dermatologist",
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

function resultEnvelope(
  result: ExtractResult,
  pdfIndex: number,
  filename: string,
  seq: number
): Record<string, unknown> {
  return {
    event: "result",
    brand: result.result.Brand,
    ...result,
    pdf_index: pdfIndex,
    filename,
    seq_num: seq,
  };
}

async function seedFinalizationJob(options: {
  state: ResumableState;
  createdAt?: number;
  finalizedAt?: number;
  fileSha256?: string | null;
  insertRun?: boolean;
  webhook?: boolean;
  scheduleAlarm?: boolean;
}): Promise<SeededJob> {
  await ensureCohortSchema(db);

  const jobId = crypto.randomUUID();
  const cohortId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const owner = `finalize-${jobId}@example.test`;
  const filename = "finalization.pdf";
  const fileSha256 =
    options.fileSha256 === undefined
      ? "a".repeat(64)
      : options.fileSha256;
  const createdAt = options.createdAt ?? Date.now();
  const finalizedAt = options.finalizedAt ?? createdAt;
  const config: JobConfig = {
    brands: "TREMFYA,SKYRIZI",
    runs: 1,
    explain: false,
    pdfs: [{ index: 0, filename }],
    owner,
    cohort_id: cohortId,
    run_id: runId,
    webhook_url: options.webhook === false ? undefined : WEBHOOK_URL,
  };

  if (options.insertRun !== false) {
    await db
      .prepare(
        `INSERT INTO cohort_runs
           (id, cohort_id, owner, created_at, job_id, status, summary_json)
         VALUES (?, ?, ?, ?, ?, 'running', NULL)`
      )
      .bind(runId, cohortId, owner, createdAt, jobId)
      .run();
  }

  const staleResult = makeExtractResult(
    filename,
    "TREMFYA",
    0,
    "stale-attempt-1"
  );
  const tremfya = makeExtractResult(
    filename,
    "TREMFYA",
    50,
    "active-attempt-2-tremfya"
  );
  const skyrizi = makeExtractResult(
    filename,
    "SKYRIZI",
    75,
    "active-attempt-2-skyrizi"
  );
  const staleEnvelope = resultEnvelope(
    staleResult,
    0,
    filename,
    1
  );
  const tremfyaEnvelope = resultEnvelope(
    tremfya,
    0,
    filename,
    2
  );
  const skyriziEnvelope = resultEnvelope(
    skyrizi,
    0,
    filename,
    3
  );

  const stub = coordinatorNamespace.get(
    coordinatorNamespace.idFromName(jobId)
  );

  await runInDurableObject(stub, async (_instance, state) => {
    const sql = state.storage.sql;

    sql.exec(
      `INSERT INTO jobs
         (id, status, created_at, total_pdfs, completed_pdfs,
          failed_pdfs, config_json, finalization_state, final_status,
          finalized_at, finalization_error)
       VALUES (?, 'running', ?, 1, 1, 0, ?, ?, 'complete', ?, NULL)`,
      jobId,
      createdAt,
      JSON.stringify(config),
      options.state,
      finalizedAt
    );

    sql.exec(
      `INSERT INTO job_pdfs
         (pdf_index, filename, status, attempt, results, error,
          file_sha256)
       VALUES (0, ?, 'complete', 2, 2, NULL, ?)`,
      filename,
      fileSha256
    );

    sql.exec(
      `INSERT INTO job_events
         (seq_num, event_type, pdf_index, attempt, brand, payload,
          created_at)
       VALUES (?, 'result', 0, 1, 'TREMFYA', ?, ?)`,
      1,
      JSON.stringify(staleEnvelope),
      createdAt
    );
    sql.exec(
      `INSERT INTO job_events
         (seq_num, event_type, pdf_index, attempt, brand, payload,
          created_at)
       VALUES (?, 'result', 0, 2, 'TREMFYA', ?, ?)`,
      2,
      JSON.stringify(tremfyaEnvelope),
      createdAt
    );
    sql.exec(
      `INSERT INTO job_events
         (seq_num, event_type, pdf_index, attempt, brand, payload,
          created_at)
       VALUES (?, 'result', 0, 2, 'SKYRIZI', ?, ?)`,
      3,
      JSON.stringify(skyriziEnvelope),
      createdAt
    );

    if (options.scheduleAlarm) {
      await state.storage.setAlarm(
        Date.now() + TEST_ALARM_DELAY_MS
      );
    }
  });

  return {
    jobId,
    cohortId,
    runId,
    owner,
    filename,
    fileSha256,
    createdAt,
    finalizedAt,
    config,
    stub,
    activeResults: [tremfya, skyrizi],
    activeEnvelopes: [tremfyaEnvelope, skyriziEnvelope],
  };
}

function expectedAggregate(seed: SeededJob): JobResults {
  return {
    jobId: seed.jobId,
    created_at: seed.createdAt,
    finished_at: seed.finalizedAt,
    config: {
      brands: seed.config.brands,
      runs: seed.config.runs,
      explain: seed.config.explain,
    },
    pdfs: [
      {
        index: 0,
        filename: seed.filename,
        status: "complete",
        results: seed.activeEnvelopes,
        errors: [],
      },
    ],
  };
}

async function preseedAggregate(seed: SeededJob): Promise<string> {
  const body = JSON.stringify(expectedAggregate(seed));
  await bucket.put(`results/${seed.jobId}.json`, body, {
    httpMetadata: { contentType: "application/json" },
  });
  return body;
}

async function preseedLibrary(
  seed: SeededJob,
  count = seed.activeResults.length
): Promise<void> {
  if (!seed.fileSha256) {
    throw new Error("test setup requires file_sha256");
  }
  await persistResults({
    db,
    bucket,
    owner: seed.owner,
    kind: "batch",
    jobId: seed.jobId,
    fileSha256: seed.fileSha256,
    runs: seed.config.runs,
    explain: seed.config.explain,
    results: seed.activeResults.slice(0, count),
    batchIdempotency: {
      pdfIndex: 0,
      finalizedAt: seed.finalizedAt,
    },
  });
}

async function preseedCohort(seed: SeededJob): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE cohort_runs
       SET status = 'complete', summary_json = ?
       WHERE id = ? AND owner = ?`
    )
    .bind(
      JSON.stringify({ preseeded: true }),
      seed.runId,
      seed.owner
    )
    .run();
  expect(result.meta.changes).toBe(1);
}

async function libraryRows(jobId: string): Promise<LibraryIndexRow[]> {
  await ensureLibrarySchema(db);
  const result = await db
    .prepare(
      `SELECT id, created_at, owner, job_id, brand, result_key
       FROM analyses
       WHERE job_id = ?
       ORDER BY brand, id`
    )
    .bind(jobId)
    .all<LibraryIndexRow>();
  return result.results ?? [];
}

async function getJobSnapshot(target: CleanupTarget): Promise<{
  job: StoredJobRow;
  pdfs: StoredPdfRow[];
  events: StoredEventRow[];
}> {
  return runInDurableObject(
    target.stub,
    async (_instance, state) => {
      const sql = state.storage.sql;
      const job = sql
        .exec<StoredJobRow>(
          `SELECT status, created_at, total_pdfs, completed_pdfs,
                  failed_pdfs, finalization_state, final_status,
                  finalized_at, finalization_error
           FROM jobs LIMIT 1`
        )
        .toArray()[0];
      const pdfs = sql
        .exec<StoredPdfRow>(
          `SELECT pdf_index, filename, status, attempt, results, error,
                  file_sha256
           FROM job_pdfs
           ORDER BY pdf_index`
        )
        .toArray();
      const events = sql
        .exec<StoredEventRow>(
          `SELECT seq_num, event_type, pdf_index, attempt, payload
           FROM job_events
           ORDER BY seq_num`
        )
        .toArray();
      return { job, pdfs, events };
    }
  );
}

async function getPollState(
  stub: ReturnType<typeof coordinatorNamespace.get>
): Promise<JobState> {
  const response = await stub.fetch(
    new Request("http://coordinator/state")
  );
  expect(response.status).toBe(200);
  return (await response.json()) as JobState;
}

async function replayOne(
  stub: ReturnType<typeof coordinatorNamespace.get>,
  lastSeq: number
): Promise<Record<string, unknown>> {
  const response = await stub.fetch(
    new Request(
      `http://coordinator/stream?lastSeq=${lastSeq}`,
      {
        headers: { Upgrade: "websocket" },
      }
    )
  );
  expect(response.status).toBe(101);

  const socket = response.webSocket;
  if (!socket) {
    throw new Error("missing replay websocket");
  }

  const message = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for replay")),
      1000
    );

    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      },
      { once: true }
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("replay websocket failed"));
      },
      { once: true }
    );
  });

  socket.accept();
  const payload = await message;
  socket.close(1000, "done");
  return JSON.parse(payload) as Record<string, unknown>;
}

async function cleanupJob(target: CleanupTarget): Promise<void> {
  await ensureLibrarySchema(db);
  const rows = await libraryRows(target.jobId);
  const keys = [
    `results/${target.jobId}.json`,
    ...rows.map((row) => row.result_key),
  ];
  await bucket.delete(keys);

  await db
    .prepare("DELETE FROM analyses WHERE job_id = ?")
    .bind(target.jobId)
    .run();
  await db
    .prepare("DELETE FROM cohort_runs WHERE job_id = ?")
    .bind(target.jobId)
    .run();

  await runInDurableObject(
    target.stub,
    async (_instance, state) => {
      await state.storage.deleteAll();
    }
  );
}

describe("durable idempotent finalization", () => {
  it("recovers a failed webhook without duplicating committed stages", async () => {
    const seed = await seedFinalizationJob({
      state: "prepared",
    });

    await preseedLibrary(seed, 1);
    const expectedFirstId = await deterministicBatchResultId({
      owner: seed.owner,
      jobId: seed.jobId,
      pdfIndex: 0,
      brand: "TREMFYA",
    });

    const beforeRows = await libraryRows(seed.jobId);
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].id).toBe(expectedFirstId);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(null, { status: 503 })
      )
      .mockResolvedValue(
        new Response(null, { status: 204 })
      );

    await expect(
      runInDurableObject(
        seed.stub,
        async (instance) => {
          const coordinator =
            instance as unknown as CoordinatorHarness;
          await coordinator.finalizeJob(
            seed.jobId,
            seed.config
          );
        }
      )
    ).rejects.toThrow(/HTTP 503/);

    const failedSnapshot = await getJobSnapshot(seed);
    expect(failedSnapshot.job).toMatchObject({
      status: "running",
      finalization_state: "cohort_committed",
      final_status: "complete",
      finalized_at: seed.finalizedAt,
    });
    expect(failedSnapshot.job.finalization_error).toMatch(
      /finalization webhook failed.*HTTP 503/
    );

    const pollState = await getPollState(seed.stub);
    expect(pollState.status).toBe("running");
    expect(pollState.finalize_state).toBe(
      "cohort_committed"
    );
    expect(pollState.finalize_error).toMatch(
      /finalization webhook failed.*HTTP 503/
    );
    expect(pollState.finalize_error).not.toContain(
      WEBHOOK_URL
    );

    const aggregateObject = await bucket.get(
      `results/${seed.jobId}.json`
    );
    if (!aggregateObject) {
      throw new Error("missing aggregate after webhook failure");
    }
    const aggregateText = await aggregateObject.text();
    const aggregate = JSON.parse(
      aggregateText
    ) as JobResults;
    expect(aggregate).toEqual(expectedAggregate(seed));
    expect(aggregate.finished_at).toBe(seed.finalizedAt);
    expect(aggregate.pdfs[0].results).toHaveLength(2);
    expect(
      aggregate.pdfs[0].results.map(
        (event) =>
          (
            event.result as Record<string, unknown>
          )["Access Score"]
      )
    ).toEqual([50, 75]);

    const committedRows = await libraryRows(seed.jobId);
    expect(committedRows).toHaveLength(2);
    expect(
      committedRows.map((row) => row.brand)
    ).toEqual(["SKYRIZI", "TREMFYA"]);
    expect(
      committedRows.every(
        (row) => row.created_at === seed.finalizedAt
      )
    ).toBe(true);
    expect(
      committedRows.filter(
        (row) => row.id === expectedFirstId
      )
    ).toHaveLength(1);

    const cohortRun = await db
      .prepare(
        `SELECT status, summary_json
         FROM cohort_runs
         WHERE id = ? AND owner = ?`
      )
      .bind(seed.runId, seed.owner)
      .first<{
        status: string;
        summary_json: string | null;
      }>();
    expect(cohortRun?.status).toBe("complete");
    const summary = JSON.parse(
      cohortRun?.summary_json ?? "{}"
    ) as {
      per_brand_access?: Record<string, number>;
    };
    expect(summary.per_brand_access).toEqual({
      TREMFYA: 50,
      SKYRIZI: 75,
    });

    expect(
      failedSnapshot.events.filter(
        (event) => event.event_type === "job_done"
      )
    ).toHaveLength(0);

    const alarmAt = await runInDurableObject(
      seed.stub,
      async (_instance, state) => state.storage.getAlarm()
    );
    expect(alarmAt).not.toBeNull();

    await abortAllDurableObjects();

    const resumedStub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(seed.jobId)
    );
    const resumedTarget: CleanupTarget = {
      jobId: seed.jobId,
      stub: resumedStub,
    };

    const resumedPollState = await getPollState(
      resumedStub
    );
    expect(resumedPollState.status).toBe("running");
    expect(resumedPollState.finalize_state).toBe(
      "cohort_committed"
    );

    const resumedAlarmAt = await runInDurableObject(
      resumedStub,
      async (_instance, state) => state.storage.getAlarm()
    );
    expect(resumedAlarmAt).not.toBeNull();

    expect(await runDurableObjectAlarm(resumedStub)).toBe(
      true
    );

    const terminalSnapshot = await getJobSnapshot(
      resumedTarget
    );
    expect(terminalSnapshot.job).toMatchObject({
      status: "complete",
      finalization_state: "terminal_committed",
      final_status: "complete",
      finalized_at: seed.finalizedAt,
      finalization_error: null,
    });

    const doneEvents = terminalSnapshot.events.filter(
      (event) => event.event_type === "job_done"
    );
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].attempt).toBe(0);
    const donePayload = JSON.parse(
      doneEvents[0].payload
    ) as Record<string, unknown>;
    expect(donePayload).toMatchObject({
      event: "job_done",
      status: "complete",
      total_pdfs: 1,
      completed_pdfs: 1,
      failed_pdfs: 0,
      pdf_index: -1,
      filename: "",
      seq_num: doneEvents[0].seq_num,
    });
    expect(donePayload).not.toHaveProperty("abandoned");

    const replayed = await replayOne(
      resumedStub,
      doneEvents[0].seq_num - 1
    );
    expect(replayed).toEqual(donePayload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toBe(
        `pa-policy-extractor/cohort-run/${seed.runId}`
      );
    }

    const rowsBeforeStaleAlarm = await libraryRows(
      seed.jobId
    );
    const aggregateBeforeStaleAlarm = await bucket.get(
      `results/${seed.jobId}.json`
    );
    if (!aggregateBeforeStaleAlarm) {
      throw new Error("missing aggregate before stale alarm");
    }
    const aggregateBodyBeforeStaleAlarm =
      await aggregateBeforeStaleAlarm.text();

    expect(await runDurableObjectAlarm(resumedStub)).toBe(
      true
    );

    const afterStaleAlarm = await getJobSnapshot(
      resumedTarget
    );
    expect(
      afterStaleAlarm.events.filter(
        (event) => event.event_type === "job_done"
      )
    ).toHaveLength(1);
    expect(await libraryRows(seed.jobId)).toEqual(
      rowsBeforeStaleAlarm
    );

    const aggregateAfterStaleAlarm = await bucket.get(
      `results/${seed.jobId}.json`
    );
    if (!aggregateAfterStaleAlarm) {
      throw new Error("missing aggregate after stale alarm");
    }
    expect(await aggregateAfterStaleAlarm.text()).toBe(
      aggregateBodyBeforeStaleAlarm
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await cleanupJob(resumedTarget);
  });

  it.each(RESUME_STATES)(
    "resumes from %s and runs only uncommitted stages",
    async (resumeState) => {
      const seed = await seedFinalizationJob({
        state: resumeState,
      });
      const rank = STATE_RANK[resumeState];

      let preseededAggregate: string | null = null;
      if (rank >= STATE_RANK.aggregate_committed) {
        preseededAggregate = await preseedAggregate(seed);
      }
      if (rank >= STATE_RANK.library_committed) {
        await preseedLibrary(seed);
      }
      if (rank >= STATE_RANK.cohort_committed) {
        await preseedCohort(seed);
      }

      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(null, { status: 204 })
        );

      const wrapped = await runInDurableObject(
        seed.stub,
        async (instance) => {
          const coordinator =
            instance as unknown as CoordinatorHarness;

          const librarySpy = vi.spyOn(
            coordinator,
            "persistFinalizationLibrary"
          );
          const cohortSpy = vi.spyOn(
            coordinator,
            "persistCohortStage"
          );
          const webhookSpy = vi.spyOn(
            coordinator,
            "postWebhook"
          );
          const advanceSpy = vi.spyOn(
            coordinator,
            "advanceFinalization"
          );
          const terminalSpy = vi.spyOn(
            coordinator,
            "commitTerminal"
          );

          await coordinator.finalizeJob(
            seed.jobId,
            seed.config
          );

          return {
            libraryCalls: librarySpy.mock.calls.length,
            cohortCalls: cohortSpy.mock.calls.length,
            webhookCalls: webhookSpy.mock.calls.length,
            terminalCalls: terminalSpy.mock.calls.length,
            advances: advanceSpy.mock.calls.map(
              (call) => call[2]
            ),
          };
        }
      );

      expect(wrapped.libraryCalls).toBe(
        rank <= STATE_RANK.aggregate_committed ? 1 : 0
      );
      expect(wrapped.cohortCalls).toBe(
        rank <= STATE_RANK.library_committed ? 1 : 0
      );
      expect(wrapped.webhookCalls).toBe(
        rank <= STATE_RANK.cohort_committed ? 1 : 0
      );
      expect(wrapped.terminalCalls).toBe(1);
      expect(wrapped.advances).toEqual(
        ADVANCE_TARGETS.slice(rank)
      );

      const snapshot = await getJobSnapshot(seed);
      expect(snapshot.job).toMatchObject({
        status: "complete",
        finalization_state: "terminal_committed",
        final_status: "complete",
        finalized_at: seed.finalizedAt,
      });
      expect(
        snapshot.events.filter(
          (event) => event.event_type === "job_done"
        )
      ).toHaveLength(1);

      expect(await libraryRows(seed.jobId)).toHaveLength(2);

      const aggregateObject = await bucket.get(
        `results/${seed.jobId}.json`
      );
      if (!aggregateObject) {
        throw new Error(
          `missing aggregate after ${resumeState} resume`
        );
      }
      const aggregateBody = await aggregateObject.text();
      if (preseededAggregate !== null) {
        expect(aggregateBody).toBe(preseededAggregate);
      } else {
        expect(
          JSON.parse(aggregateBody) as JobResults
        ).toEqual(expectedAggregate(seed));
      }

      const cohortRun = await db
        .prepare(
          `SELECT status, summary_json
           FROM cohort_runs
           WHERE id = ? AND owner = ?`
        )
        .bind(seed.runId, seed.owner)
        .first<{
          status: string;
          summary_json: string | null;
        }>();
      expect(cohortRun?.status).toBe("complete");

      if (rank >= STATE_RANK.cohort_committed) {
        expect(
          JSON.parse(cohortRun?.summary_json ?? "{}")
        ).toEqual({ preseeded: true });
      } else {
        const summary = JSON.parse(
          cohortRun?.summary_json ?? "{}"
        ) as {
          per_brand_access?: Record<string, number>;
        };
        expect(summary.per_brand_access).toEqual({
          TREMFYA: 50,
          SKYRIZI: 75,
        });
      }

      expect(fetchMock).toHaveBeenCalledTimes(
        rank <= STATE_RANK.cohort_committed ? 1 : 0
      );
      if (fetchMock.mock.calls.length === 1) {
        const headers = new Headers(
          fetchMock.mock.calls[0][1]?.headers
        );
        expect(headers.get("Idempotency-Key")).toBe(
          `pa-policy-extractor/cohort-run/${seed.runId}`
        );
      }

      await cleanupJob(seed);
    }
  );
});

describe("finalization invariants", () => {
  it("fails the library stage when result events have no file_sha256", async () => {
    const seed = await seedFinalizationJob({
      state: "aggregate_committed",
      fileSha256: null,
    });
    await preseedAggregate(seed);

    await expect(
      runInDurableObject(
        seed.stub,
        async (instance) => {
          const coordinator =
            instance as unknown as CoordinatorHarness;
          await coordinator.finalizeJob(
            seed.jobId,
            seed.config
          );
        }
      )
    ).rejects.toThrow(/no file_sha256/);

    const snapshot = await getJobSnapshot(seed);
    expect(snapshot.job.status).toBe("running");
    expect(snapshot.job.finalization_state).toBe(
      "aggregate_committed"
    );
    expect(snapshot.job.finalization_error).toMatch(
      /finalization library failed.*file_sha256/
    );
    expect(await libraryRows(seed.jobId)).toHaveLength(0);
    expect(
      snapshot.events.filter(
        (event) => event.event_type === "job_done"
      )
    ).toHaveLength(0);

    await cleanupJob(seed);
  });

  it("rejects exactly one of cohort_id and run_id", async () => {
    const seed = await seedFinalizationJob({
      state: "prepared",
      webhook: false,
    });
    const invalidConfig: JobConfig = {
      ...seed.config,
      run_id: undefined,
      webhook_url: undefined,
    };

    await runInDurableObject(
      seed.stub,
      async (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE jobs SET config_json = ? WHERE id = ?",
          JSON.stringify(invalidConfig),
          seed.jobId
        );
      }
    );

    await expect(
      runInDurableObject(
        seed.stub,
        async (instance) => {
          const coordinator =
            instance as unknown as CoordinatorHarness;
          await coordinator.finalizeJob(
            seed.jobId,
            invalidConfig
          );
        }
      )
    ).rejects.toThrow(
      /cohort_id and run_id must be set together/
    );

    const snapshot = await getJobSnapshot(seed);
    expect(snapshot.job.status).toBe("running");
    expect(snapshot.job.finalization_state).toBe(
      "prepared"
    );
    expect(snapshot.job.finalization_error).toMatch(
      /finalization configuration failed/
    );
    expect(
      await bucket.head(`results/${seed.jobId}.json`)
    ).toBeNull();

    await cleanupJob(seed);
  });

  it("allows a missing cohort_run only when its parent cohort is deleted", async () => {
    const seed = await seedFinalizationJob({
      state: "library_committed",
      insertRun: false,
      webhook: false,
    });
    await preseedAggregate(seed);
    await preseedLibrary(seed);

    await runInDurableObject(
      seed.stub,
      async (instance) => {
        const coordinator =
          instance as unknown as CoordinatorHarness;
        await coordinator.finalizeJob(
          seed.jobId,
          seed.config
        );
      }
    );

    const snapshot = await getJobSnapshot(seed);
    expect(snapshot.job).toMatchObject({
      status: "complete",
      finalization_state: "terminal_committed",
    });
    expect(
      snapshot.events.filter(
        (event) => event.event_type === "job_done"
      )
    ).toHaveLength(1);
    expect(await libraryRows(seed.jobId)).toHaveLength(2);

    await cleanupJob(seed);
  });

  it("adds every finalization column to a legacy jobs table", async () => {
    const jobId = crypto.randomUUID();
    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(jobId)
    );

    const columns = await runInDurableObject(
      stub,
      async (instance, state) => {
        const coordinator =
          instance as unknown as CoordinatorHarness;
        const sql = state.storage.sql;

        sql.exec("DROP TABLE IF EXISTS job_events");
        sql.exec("DROP TABLE IF EXISTS job_pdfs");
        sql.exec("DROP TABLE IF EXISTS jobs");
        sql.exec(
          `CREATE TABLE jobs (
             id              TEXT PRIMARY KEY,
             status          TEXT NOT NULL,
             created_at      INTEGER NOT NULL,
             total_pdfs      INTEGER NOT NULL,
             completed_pdfs  INTEGER NOT NULL DEFAULT 0,
             failed_pdfs     INTEGER NOT NULL DEFAULT 0,
             config_json     TEXT NOT NULL
           )`
        );

        coordinator.initSchema();

        const names = sql
          .exec<{ name: string }>(
            "PRAGMA table_info(jobs)"
          )
          .toArray()
          .map((column) => column.name);

        await state.storage.deleteAll();
        return names;
      }
    );

    expect(columns).toEqual(
      expect.arrayContaining([
        "finalization_state",
        "final_status",
        "finalized_at",
        "finalization_error",
      ])
    );
  });
});

describe("abandonment split", () => {
  it("routes processing-time abandonment through normal partial-success finalization", async () => {
    await ensureLibrarySchema(db);

    const jobId = crypto.randomUUID();
    const owner = `processing-abandon-${jobId}@example.test`;
    const completeFilename = "complete-before-timeout.pdf";
    const pendingFilename = "pending-at-timeout.pdf";
    const createdAt =
      Date.now() - MAX_JOB_AGE_MS - 60_000;
    const config: JobConfig = {
      brands: "TREMFYA",
      runs: 1,
      explain: false,
      pdfs: [
        { index: 0, filename: completeFilename },
        { index: 1, filename: pendingFilename },
      ],
      owner,
    };
    const result = makeExtractResult(
      completeFilename,
      "TREMFYA",
      50,
      "completed-before-processing-timeout"
    );
    const envelope = resultEnvelope(
      result,
      0,
      completeFilename,
      1
    );
    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(jobId)
    );

    await runInDurableObject(
      stub,
      async (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec(
          `INSERT INTO jobs
             (id, status, created_at, total_pdfs, completed_pdfs,
              failed_pdfs, config_json, finalization_state,
              final_status, finalized_at, finalization_error)
           VALUES (?, 'running', ?, 2, 1, 0, ?, 'none',
                   NULL, NULL, NULL)`,
          jobId,
          createdAt,
          JSON.stringify(config)
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error,
              file_sha256)
           VALUES (0, ?, 'complete', 1, 1, NULL, ?)`,
          completeFilename,
          "b".repeat(64)
        );
        sql.exec(
          `INSERT INTO job_pdfs
             (pdf_index, filename, status, attempt, results, error,
              file_sha256)
           VALUES (1, ?, 'pending', 1, 0, NULL, NULL)`,
          pendingFilename
        );
        sql.exec(
          `INSERT INTO job_events
             (seq_num, event_type, pdf_index, attempt, brand,
              payload, created_at)
           VALUES (1, 'result', 0, 1, 'TREMFYA', ?, ?)`,
          JSON.stringify(envelope),
          createdAt
        );
        await state.storage.setAlarm(
          Date.now() + TEST_ALARM_DELAY_MS
        );
      }
    );

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const snapshot = await getJobSnapshot({
      jobId,
      stub,
    });
    expect(snapshot.job).toMatchObject({
      status: "complete",
      completed_pdfs: 1,
      failed_pdfs: 1,
      finalization_state: "terminal_committed",
      final_status: "complete",
      finalization_error:
        "abandoned: processing-time ceiling",
    });
    expect(snapshot.pdfs).toEqual([
      expect.objectContaining({
        pdf_index: 0,
        status: "complete",
      }),
      expect.objectContaining({
        pdf_index: 1,
        status: "failed",
        error:
          "abandoned: job never completed (instance churn)",
      }),
    ]);

    const doneEvents = snapshot.events.filter(
      (event) => event.event_type === "job_done"
    );
    expect(doneEvents).toHaveLength(1);
    const donePayload = JSON.parse(
      doneEvents[0].payload
    ) as Record<string, unknown>;
    expect(donePayload).toMatchObject({
      event: "job_done",
      status: "complete",
      total_pdfs: 2,
      completed_pdfs: 1,
      failed_pdfs: 1,
      abandoned: true,
    });
    expect(donePayload).not.toHaveProperty(
      "results_available"
    );

    const aggregateObject = await bucket.get(
      `results/${jobId}.json`
    );
    if (!aggregateObject) {
      throw new Error(
        "processing abandonment did not write aggregate"
      );
    }
    const aggregate = JSON.parse(
      await aggregateObject.text()
    ) as JobResults;
    expect(aggregate.pdfs).toHaveLength(2);
    expect(aggregate.pdfs[0].results).toHaveLength(1);
    expect(aggregate.pdfs[1]).toMatchObject({
      status: "failed",
      results: [],
      errors: [],
    });

    const rows = await libraryRows(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0].brand).toBe("TREMFYA");

    await cleanupJob({ jobId, stub });
  });

  it("forces failed finalization abandonment with a pinned empty-partial document", async () => {
    const oldFinalizedAt =
      Date.now() - MAX_JOB_AGE_MS - 60_000;
    const seed = await seedFinalizationJob({
      state: "cohort_committed",
      createdAt: oldFinalizedAt - 1000,
      finalizedAt: oldFinalizedAt,
      scheduleAlarm: true,
    });

    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await runDurableObjectAlarm(seed.stub)).toBe(
      true
    );

    const snapshot = await getJobSnapshot(seed);
    expect(snapshot.job).toMatchObject({
      status: "failed",
      finalization_state: "abandoned",
      final_status: "failed",
      finalized_at: oldFinalizedAt,
      finalization_error:
        "abandoned: finalization-time ceiling",
    });

    const doneEvents = snapshot.events.filter(
      (event) => event.event_type === "job_done"
    );
    expect(doneEvents).toHaveLength(1);
    const donePayload = JSON.parse(
      doneEvents[0].payload
    ) as Record<string, unknown>;
    expect(donePayload).toMatchObject({
      event: "job_done",
      status: "failed",
      total_pdfs: 1,
      completed_pdfs: 1,
      failed_pdfs: 0,
      abandoned: true,
      results_available: true,
    });

    const aggregateObject = await bucket.get(
      `results/${seed.jobId}.json`
    );
    if (!aggregateObject) {
      throw new Error(
        "forced abandonment did not write empty partial"
      );
    }
    const aggregate = JSON.parse(
      await aggregateObject.text()
    ) as JobResults;
    expect(aggregate).toEqual({
      jobId: seed.jobId,
      created_at: seed.createdAt,
      finished_at: oldFinalizedAt,
      config: {
        brands: seed.config.brands,
        runs: seed.config.runs,
        explain: seed.config.explain,
      },
      pdfs: [
        {
          index: 0,
          filename: seed.filename,
          status: "complete",
          results: [],
          errors: [],
        },
      ],
    });

    expect(await libraryRows(seed.jobId)).toHaveLength(0);
    const cohortRun = await db
      .prepare(
        `SELECT status, summary_json
         FROM cohort_runs
         WHERE id = ? AND owner = ?`
      )
      .bind(seed.runId, seed.owner)
      .first<{
        status: string;
        summary_json: string | null;
      }>();
    expect(cohortRun).toEqual({
      status: "running",
      summary_json: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await cleanupJob(seed);
  });
});

describe("interactive library regression", () => {
  it("keeps random ids and permits duplicate interactive saves", async () => {
    const owner =
      `interactive-${crypto.randomUUID()}@example.test`;
    const fileSha256 = "c".repeat(64);
    const result = makeExtractResult(
      "interactive.pdf",
      "TREMFYA",
      75,
      "interactive-duplicate"
    );

    const first = await persistResults({
      db,
      bucket,
      owner,
      kind: "single",
      jobId: null,
      fileSha256,
      runs: 1,
      explain: false,
      results: [result],
    });
    const second = await persistResults({
      db,
      bucket,
      owner,
      kind: "single",
      jobId: null,
      fileSha256,
      runs: 1,
      explain: false,
      results: [result],
    });

    expect(first.count).toBe(1);
    expect(second.count).toBe(1);
    expect(first.saved[0].id).not.toBe(
      second.saved[0].id
    );

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first.saved[0].id).toMatch(uuidPattern);
    expect(second.saved[0].id).toMatch(uuidPattern);

    const rows = (
      await db
        .prepare(
          `SELECT id, result_key
           FROM analyses
           WHERE owner = ?
             AND kind = 'single'
             AND file_sha256 = ?
             AND brand = 'TREMFYA'
           ORDER BY id`
        )
        .bind(owner, fileSha256)
        .all<{
          id: string;
          result_key: string;
        }>()
    ).results;

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(
      2
    );

    for (const row of rows) {
      expect(await bucket.head(row.result_key)).not.toBeNull();
    }

    await bucket.delete(
      rows.map((row) => row.result_key)
    );
    await db
      .prepare("DELETE FROM analyses WHERE owner = ?")
      .bind(owner)
      .run();
  });
});
