/**
 * cohorts.ts — W5: saved cohorts + versioning + webhook.
 *
 * A COHORT is a named, persistent set of policy PDFs + a fixed analysis config
 * ({brands, runs, explain}) + an optional webhook_url + a schedule_enabled flag.
 * Unlike a one-off batch job, a cohort's PDFs are stored PERSISTENTLY under R2
 * cohorts/<cohortId>/<i>.pdf and are NOT subject to the JobCoordinator's 7-day
 * retention cleanup — they are deleted only when the cohort itself is deleted.
 *
 * Running a cohort STAGES its persistent PDFs into a NEW batch job (reusing the
 * exact JobCoordinator path — copy to pdfs/<newJobId>/<i>.pdf, then POST /start),
 * recording a `cohort_runs` row. Each run is a VERSION; two runs can be COMPARED
 * field-by-field via the owner-scoped library rows the job persisted on finalize.
 *
 * STORAGE (reuses the SAME env.LIBRARY D1 + env.RESULT_BUCKET R2 as W1):
 *   - D1 tables (lazy CREATE TABLE IF NOT EXISTS, every read/write owner-scoped):
 *       cohorts(id PK, owner, name, created_at, brands csv, runs, explain,
 *               webhook_url NULL, schedule_enabled, pdf_count)
 *       cohort_pdfs(cohort_id, idx, filename, r2_key, PK(cohort_id, idx))
 *       cohort_runs(id PK, cohort_id, owner, created_at, job_id, status, summary_json)
 *   - R2: cohorts/<cohortId>/<i>.pdf — the persistent cohort PDFs.
 *
 * SSRF: webhook URLs are validated to be https with a non-private host (see
 * validateWebhookUrl). The same guard is re-applied in the DO at POST time.
 *
 * VERIFIED-DOC GOTCHAS honoured: D1 access here is via prepared statements with
 * bound params (never string-interpolated user input), and EVERY query carries an
 * owner predicate so a tenant can only ever see/mutate its own cohorts.
 */

import type { ExtractResult } from "./types";
import { ensureLibrarySchema } from "./library";
import { clampRuns, parseExplain, validateWebhookUrl } from "./util";

// Re-export the SSRF webhook guard so any existing importer that pulled it from
// this module keeps working after it was hoisted into ./util.
export { validateWebhookUrl };

/** R2 key prefix for a cohort's persistent PDFs. */
const COHORT_PDF_PREFIX = "cohorts/";

/** Max PDFs a single cohort may hold (mirrors a per-job batch cap). */
const MAX_COHORT_PDFS = 25;

/** A JSON responder matching the Worker's security-header JSON helper. */
type JsonResponder = (body: unknown, status?: number) => Response;

/** The Worker-side surface a cohort handler needs (reuses existing bindings). */
export interface CohortEnv {
  LIBRARY: D1Database;
  RESULT_BUCKET: R2Bucket;
  JOB_COORDINATOR: DurableObjectNamespace;
}

// ── D1 schema (lazy, idempotent) ──────────────────────────────────────────────

/**
 * Apply the cohort schema LAZILY (CREATE TABLE/INDEX IF NOT EXISTS). Reuses the
 * SAME env.LIBRARY D1 database as the analysis library — just more tables. Also
 * ensures the library schema, since cohort compare reads the `analyses` table.
 */
export async function ensureCohortSchema(db: D1Database): Promise<void> {
  await ensureLibrarySchema(db);
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS cohorts (
         id               TEXT PRIMARY KEY,
         owner            TEXT NOT NULL,
         name             TEXT NOT NULL,
         created_at       INTEGER NOT NULL,
         brands           TEXT NOT NULL,
         runs             INTEGER NOT NULL DEFAULT 1,
         explain          INTEGER NOT NULL DEFAULT 0,
         webhook_url      TEXT,
         schedule_enabled INTEGER NOT NULL DEFAULT 0,
         pdf_count        INTEGER NOT NULL DEFAULT 0
       )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_cohorts_owner ON cohorts (owner, created_at)`
    ),
    // Cron support: cheap lookup of opted-in cohorts across owners.
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_cohorts_schedule
         ON cohorts (schedule_enabled)`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS cohort_pdfs (
         cohort_id  TEXT NOT NULL,
         idx        INTEGER NOT NULL,
         filename   TEXT NOT NULL,
         r2_key     TEXT NOT NULL,
         PRIMARY KEY (cohort_id, idx)
       )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS cohort_runs (
         id           TEXT PRIMARY KEY,
         cohort_id    TEXT NOT NULL,
         owner        TEXT NOT NULL,
         created_at   INTEGER NOT NULL,
         job_id       TEXT NOT NULL,
         status       TEXT NOT NULL,
         summary_json TEXT
       )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_cohort_runs_cohort
         ON cohort_runs (cohort_id, created_at)`
    ),
  ]);
}

// ── route handlers ────────────────────────────────────────────────────────────

/**
 * POST /api/cohorts — create a cohort from an existing FINISHED batch job.
 * Body: { name, source_job_id, brands?, runs?, explain? }. We read the source
 * job's results doc (results/<source_job_id>.json) to learn how many PDFs it had
 * and its default config, COPY each staged PDF pdfs/<source_job_id>/<i>.pdf to the
 * persistent key cohorts/<cohortId>/<i>.pdf, and insert the cohort + cohort_pdfs
 * rows (owner-scoped). Config defaults come from the job unless overridden.
 */
export async function handleCohortCreate(
  env: CohortEnv,
  request: Request,
  owner: string,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  let body: {
    name?: unknown;
    source_job_id?: unknown;
    brands?: unknown;
    runs?: unknown;
    explain?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "expected a JSON object body" }, 400);
  }

  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 200)
      : "";
  if (!name) {
    return json({ error: "missing 'name'" }, 400);
  }
  const sourceJobId =
    typeof body.source_job_id === "string" ? body.source_job_id.trim() : "";
  if (!sourceJobId) {
    return json({ error: "missing 'source_job_id'" }, 400);
  }

  // OWNER CHECK: a jobId is unguessable but NOT authorization — anyone holding
  // a foreign jobId could otherwise copy that job's PDFs into their own cohort.
  // The JobCoordinator persists owner-scoped `analyses` index rows (keyed by
  // job_id) on finalize, so verify THIS owner actually ran the source job before
  // touching its R2 objects. Absent/foreign -> the same 404 as a missing job,
  // so a foreign jobId is indistinguishable from an expired one.
  const owned = await env.LIBRARY.prepare(
    `SELECT id FROM analyses WHERE owner = ? AND job_id = ? LIMIT 1`
  )
    .bind(owner, sourceJobId)
    .first<{ id: string }>();
  if (!owned) {
    return json({ error: "source job not found or not finished" }, 404);
  }

  // Read the source job's aggregated results to discover its PDFs + config. This
  // is the authoritative record of a FINISHED job (written by finalizeJob); a job
  // that never finished (or was reaped) has no doc -> 404.
  const resultsObj = await env.RESULT_BUCKET.get(`results/${sourceJobId}.json`);
  if (!resultsObj) {
    return json(
      { error: "source job not found or not finished" },
      404
    );
  }
  let jobDoc: {
    config?: { brands?: string; runs?: number; explain?: boolean };
    pdfs?: { index: number; filename: string }[];
  };
  try {
    jobDoc = (await resultsObj.json()) as typeof jobDoc;
  } catch {
    return json({ error: "source job results are unreadable" }, 500);
  }

  const sourcePdfs = Array.isArray(jobDoc.pdfs) ? jobDoc.pdfs : [];
  if (sourcePdfs.length === 0) {
    return json({ error: "source job has no PDFs to save" }, 400);
  }
  if (sourcePdfs.length > MAX_COHORT_PDFS) {
    return json(
      { error: `source job has too many PDFs (${sourcePdfs.length} > ${MAX_COHORT_PDFS})` },
      400
    );
  }

  // Config: prefer explicit overrides, else inherit the source job's config.
  const brands =
    typeof body.brands === "string" && body.brands.trim()
      ? body.brands.trim()
      : typeof jobDoc.config?.brands === "string"
        ? jobDoc.config.brands
        : "";
  if (!brands) {
    return json({ error: "could not determine 'brands' for the cohort" }, 400);
  }
  const runs =
    body.runs !== undefined ? clampRuns(body.runs) : clampRuns(jobDoc.config?.runs);
  const explain =
    body.explain !== undefined
      ? parseExplain(body.explain)
      : jobDoc.config?.explain === true;

  const cohortId = crypto.randomUUID();
  const createdAt = Date.now();

  // COPY each staged source PDF to the persistent cohort key. We read the bytes
  // and re-put (R2 has no server-side copy in the binding). A missing source
  // object is skipped (the cohort just gets the PDFs that still exist).
  const pdfRows: { idx: number; filename: string; r2_key: string }[] = [];
  let idx = 0;
  for (const p of sourcePdfs) {
    const srcKey = `pdfs/${sourceJobId}/${p.index}.pdf`;
    const src = await env.RESULT_BUCKET.get(srcKey);
    if (!src) continue; // staged PDF already reaped — skip it.
    const bytes = await src.arrayBuffer();
    const dstKey = `${COHORT_PDF_PREFIX}${cohortId}/${idx}.pdf`;
    await env.RESULT_BUCKET.put(dstKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    pdfRows.push({
      idx,
      filename: typeof p.filename === "string" ? p.filename : `pdf-${idx}.pdf`,
      r2_key: dstKey,
    });
    idx += 1;
  }

  if (pdfRows.length === 0) {
    return json(
      { error: "no source PDFs available to copy (job may have expired)" },
      400
    );
  }

  // Insert the cohort + its PDF rows. R2 copies are already done, so a row never
  // points at a missing object.
  const statements: D1PreparedStatement[] = [
    env.LIBRARY.prepare(
      `INSERT INTO cohorts
         (id, owner, name, created_at, brands, runs, explain, webhook_url, schedule_enabled, pdf_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
    ).bind(cohortId, owner, name, createdAt, brands, runs, explain ? 1 : 0, pdfRows.length),
  ];
  for (const r of pdfRows) {
    statements.push(
      env.LIBRARY.prepare(
        `INSERT INTO cohort_pdfs (cohort_id, idx, filename, r2_key) VALUES (?, ?, ?, ?)`
      ).bind(cohortId, r.idx, r.filename, r.r2_key)
    );
  }
  await env.LIBRARY.batch(statements);

  return json(
    {
      id: cohortId,
      name,
      brands,
      runs,
      explain,
      pdf_count: pdfRows.length,
      created_at: createdAt,
    },
    201
  );
}

/**
 * GET /api/cohorts — list the owner's cohorts, each with its most-recent run
 * summary (status + created_at) joined in. Owner-scoped.
 */
export async function handleCohortList(
  env: CohortEnv,
  owner: string,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  const res = await env.LIBRARY.prepare(
    `SELECT id, name, created_at, brands, runs, explain, webhook_url,
            schedule_enabled, pdf_count
       FROM cohorts WHERE owner = ? ORDER BY created_at DESC`
  )
    .bind(owner)
    .all<{
      id: string;
      name: string;
      created_at: number;
      brands: string;
      runs: number;
      explain: number;
      webhook_url: string | null;
      schedule_enabled: number;
      pdf_count: number;
    }>();

  const cohorts = res.results ?? [];

  // Most-recent run per cohort (owner-scoped), in one query.
  const lastRuns = await env.LIBRARY.prepare(
    `SELECT cr.cohort_id AS cohort_id, cr.id AS run_id, cr.created_at AS created_at,
            cr.job_id AS job_id, cr.status AS status, cr.summary_json AS summary_json
       FROM cohort_runs cr
       JOIN (
         SELECT cohort_id, MAX(created_at) AS mx
           FROM cohort_runs WHERE owner = ? GROUP BY cohort_id
       ) m ON m.cohort_id = cr.cohort_id AND m.mx = cr.created_at
      WHERE cr.owner = ?`
  )
    .bind(owner, owner)
    .all<{
      cohort_id: string;
      run_id: string;
      created_at: number;
      job_id: string;
      status: string;
      summary_json: string | null;
    }>();

  const lastByCohort = new Map<string, unknown>();
  for (const r of lastRuns.results ?? []) {
    lastByCohort.set(r.cohort_id, {
      run_id: r.run_id,
      created_at: r.created_at,
      job_id: r.job_id,
      status: r.status,
      summary: r.summary_json ? safeParse(r.summary_json) : null,
    });
  }

  return json({
    cohorts: cohorts.map((c) => ({
      id: c.id,
      name: c.name,
      created_at: c.created_at,
      brands: c.brands,
      runs: c.runs,
      explain: c.explain === 1,
      webhook_url: c.webhook_url,
      schedule_enabled: c.schedule_enabled === 1,
      pdf_count: c.pdf_count,
      last_run: lastByCohort.get(c.id) ?? null,
    })),
  });
}

/**
 * PATCH /api/cohorts/:id — update mutable fields: name, brands, runs, explain,
 * webhook_url (validated/cleared), schedule_enabled. Owner-scoped: a non-owner
 * (or unknown id) gets 404. Only the provided fields are touched.
 */
export async function handleCohortPatch(
  env: CohortEnv,
  request: Request,
  owner: string,
  cohortId: string,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  // Owner check first.
  const existing = await env.LIBRARY.prepare(
    `SELECT id FROM cohorts WHERE id = ? AND owner = ? LIMIT 1`
  )
    .bind(cohortId, owner)
    .first<{ id: string }>();
  if (!existing) {
    return json({ error: "not found" }, 404);
  }

  let body: {
    name?: unknown;
    brands?: unknown;
    runs?: unknown;
    explain?: unknown;
    webhook_url?: unknown;
    schedule_enabled?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "expected a JSON object body" }, 400);
  }

  const sets: string[] = [];
  const bind: (string | number | null)[] = [];

  if (typeof body.name === "string" && body.name.trim()) {
    sets.push("name = ?");
    bind.push(body.name.trim().slice(0, 200));
  }
  if (typeof body.brands === "string" && body.brands.trim()) {
    sets.push("brands = ?");
    bind.push(body.brands.trim());
  }
  if (body.runs !== undefined) {
    sets.push("runs = ?");
    bind.push(clampRuns(body.runs));
  }
  if (body.explain !== undefined) {
    sets.push("explain = ?");
    bind.push(parseExplain(body.explain) ? 1 : 0);
  }
  if (body.schedule_enabled !== undefined) {
    sets.push("schedule_enabled = ?");
    bind.push(parseExplain(body.schedule_enabled) ? 1 : 0);
  }
  if (body.webhook_url !== undefined) {
    // null / "" clears the webhook; any other value must pass the SSRF guard.
    if (body.webhook_url === null || body.webhook_url === "") {
      sets.push("webhook_url = ?");
      bind.push(null);
    } else {
      const v = validateWebhookUrl(body.webhook_url);
      if ("error" in v) {
        return json({ error: v.error }, 400);
      }
      sets.push("webhook_url = ?");
      bind.push(v.url);
    }
  }

  if (sets.length === 0) {
    return json({ error: "no updatable fields provided" }, 400);
  }

  bind.push(cohortId, owner);
  await env.LIBRARY.prepare(
    `UPDATE cohorts SET ${sets.join(", ")} WHERE id = ? AND owner = ?`
  )
    .bind(...bind)
    .run();

  return json({ ok: true, id: cohortId });
}

/**
 * DELETE /api/cohorts/:id — delete the cohort, its persistent R2 PDFs
 * (cohorts/<id>/*), and all of its D1 rows (cohort + cohort_pdfs + cohort_runs).
 * Owner-scoped. The cohort_runs' source jobs (their pdfs/<jobId>/* + results) are
 * NOT touched here — those expire on their own retention alarm.
 */
export async function handleCohortDelete(
  env: CohortEnv,
  owner: string,
  cohortId: string,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  // Owner check.
  const existing = await env.LIBRARY.prepare(
    `SELECT id FROM cohorts WHERE id = ? AND owner = ? LIMIT 1`
  )
    .bind(cohortId, owner)
    .first<{ id: string }>();
  if (!existing) {
    return json({ error: "not found" }, 404);
  }

  // Collect the persistent PDF keys to delete from R2.
  const pdfRes = await env.LIBRARY.prepare(
    `SELECT r2_key FROM cohort_pdfs WHERE cohort_id = ?`
  )
    .bind(cohortId)
    .all<{ r2_key: string }>();
  const keys = (pdfRes.results ?? []).map((r) => r.r2_key);
  if (keys.length > 0) {
    // R2 delete is a no-op on a missing key, so this is idempotent.
    await env.RESULT_BUCKET.delete(keys);
  }

  // Delete all D1 rows for this cohort (owner-scoped where the table carries it).
  await env.LIBRARY.batch([
    env.LIBRARY.prepare(`DELETE FROM cohort_pdfs WHERE cohort_id = ?`).bind(cohortId),
    env.LIBRARY.prepare(`DELETE FROM cohort_runs WHERE cohort_id = ? AND owner = ?`).bind(
      cohortId,
      owner
    ),
    env.LIBRARY.prepare(`DELETE FROM cohorts WHERE id = ? AND owner = ?`).bind(
      cohortId,
      owner
    ),
  ]);

  return json({ ok: true, id: cohortId, deleted_pdfs: keys.length });
}

/**
 * POST /api/cohorts/:id/run — re-run a cohort as a NEW batch job. We stage the
 * cohort's persistent PDFs into the standard job key space (pdfs/<newJobId>/<i>.
 * pdf) by copying bytes, insert a `cohort_runs` row (status "running"), then call
 * the JobCoordinator's /start with the cohort's config PLUS webhook_url/cohort_id/
 * run_id so the DO can fire the webhook + update the run row on finalize. Returns
 * { jobId, runId }. Owner-scoped.
 *
 * This is the shared path used by BOTH the HTTP route and the scheduled() cron.
 */
export async function runCohort(
  env: CohortEnv,
  owner: string,
  cohortId: string
): Promise<{ jobId: string; runId: string } | { error: string; status: number }> {
  await ensureCohortSchema(env.LIBRARY);

  const cohort = await env.LIBRARY.prepare(
    `SELECT id, name, brands, runs, explain, webhook_url
       FROM cohorts WHERE id = ? AND owner = ? LIMIT 1`
  )
    .bind(cohortId, owner)
    .first<{
      id: string;
      name: string;
      brands: string;
      runs: number;
      explain: number;
      webhook_url: string | null;
    }>();
  if (!cohort) {
    return { error: "not found", status: 404 };
  }

  const pdfRes = await env.LIBRARY.prepare(
    `SELECT idx, filename, r2_key FROM cohort_pdfs WHERE cohort_id = ? ORDER BY idx`
  )
    .bind(cohortId)
    .all<{ idx: number; filename: string; r2_key: string }>();
  const cohortPdfs = pdfRes.results ?? [];
  if (cohortPdfs.length === 0) {
    return { error: "cohort has no PDFs", status: 400 };
  }

  const jobId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  // Stage each persistent cohort PDF into the new job's key space (copy bytes).
  // Re-index 0..N so the JobCoordinator's pdfs/<jobId>/<i>.pdf layout holds.
  const pdfs: { index: number; filename: string }[] = [];
  let i = 0;
  for (const p of cohortPdfs) {
    const src = await env.RESULT_BUCKET.get(p.r2_key);
    if (!src) continue; // should not happen (persistent), but be defensive.
    const bytes = await src.arrayBuffer();
    await env.RESULT_BUCKET.put(`pdfs/${jobId}/${i}.pdf`, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    pdfs.push({ index: i, filename: p.filename });
    i += 1;
  }
  if (pdfs.length === 0) {
    return { error: "cohort PDFs are missing from storage", status: 500 };
  }

  // Record the run BEFORE starting (status "running"); the DO updates it on
  // finalize via the cohort_id/run_id passed in StartJobBody.
  await env.LIBRARY.prepare(
    `INSERT INTO cohort_runs (id, cohort_id, owner, created_at, job_id, status, summary_json)
     VALUES (?, ?, ?, ?, ?, 'running', NULL)`
  )
    .bind(runId, cohortId, owner, Date.now(), jobId)
    .run();

  // Kick off the JobCoordinator (same control plane as POST /api/jobs), passing
  // the cohort linkage + webhook so the DO can fire-and-update on finalize.
  const id = env.JOB_COORDINATOR.idFromName(jobId);
  const stub = env.JOB_COORDINATOR.get(id);
  const startRes = await stub.fetch("https://jc/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId,
      owner,
      brands: cohort.brands,
      runs: cohort.runs,
      explain: cohort.explain === 1,
      pdfs,
      webhook_url: cohort.webhook_url ?? undefined,
      cohort_id: cohortId,
      run_id: runId,
    }),
  });
  if (!startRes.ok) {
    // Mark the run failed so the list view reflects reality.
    await env.LIBRARY.prepare(
      `UPDATE cohort_runs SET status = 'failed' WHERE id = ? AND owner = ?`
    )
      .bind(runId, owner)
      .run();
    return { error: "failed to start job coordinator", status: 502 };
  }

  return { jobId, runId };
}

/** POST /api/cohorts/:id/run — HTTP wrapper around runCohort. */
export async function handleCohortRun(
  env: CohortEnv,
  owner: string,
  cohortId: string,
  json: JsonResponder
): Promise<Response> {
  const out = await runCohort(env, owner, cohortId);
  if ("error" in out) {
    return json({ error: out.error }, out.status);
  }
  return json({ jobId: out.jobId, runId: out.runId }, 202);
}

/**
 * GET /api/cohorts/:id/runs — list a cohort's runs (versions), newest first,
 * each with status + parsed summary. Owner-scoped (cohort ownership checked).
 */
export async function handleCohortRuns(
  env: CohortEnv,
  owner: string,
  cohortId: string,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  const cohort = await env.LIBRARY.prepare(
    `SELECT id FROM cohorts WHERE id = ? AND owner = ? LIMIT 1`
  )
    .bind(cohortId, owner)
    .first<{ id: string }>();
  if (!cohort) {
    return json({ error: "not found" }, 404);
  }

  const res = await env.LIBRARY.prepare(
    `SELECT id, created_at, job_id, status, summary_json
       FROM cohort_runs WHERE cohort_id = ? AND owner = ? ORDER BY created_at DESC`
  )
    .bind(cohortId, owner)
    .all<{
      id: string;
      created_at: number;
      job_id: string;
      status: string;
      summary_json: string | null;
    }>();

  return json({
    runs: (res.results ?? []).map((r) => ({
      run_id: r.id,
      created_at: r.created_at,
      job_id: r.job_id,
      status: r.status,
      summary: r.summary_json ? safeParse(r.summary_json) : null,
    })),
  });
}

/** The deliverable display columns we diff in a version compare (excludes the
 * echoed Filename/Brand; Access Score IS compared). Mirrors ResultRow keys. */
const COMPARE_FIELDS: readonly string[] = [
  "Age",
  "Step Therapy Requirements Documented in Policy",
  "Number of Steps through Brands",
  "Number of Steps through Generic",
  "Step through-Phototherapy",
  "TB Test required",
  "Quantity Limits",
  "Specialist Types",
  "Initial Authorization Duration(in-months)",
  "Reauthorization Duration(in-months)",
  "Reauthorization Required",
  "Reauthorization Requirements Documented in Policy",
  "Access Score",
];

/**
 * GET /api/cohorts/:id/compare?a=<runId>&b=<runId> — VERSION DIFF. For each run
 * we resolve its job_id, then read that job's owner-scoped per-(filename,brand)
 * library results (the `analyses` rows the DO persisted on finalize, with the
 * full ExtractResult in R2). We key results by (filename, brand) and emit a
 * field-level diff of the deliverable columns. Owner-scoped throughout.
 */
export async function handleCohortCompare(
  env: CohortEnv,
  owner: string,
  cohortId: string,
  url: URL,
  json: JsonResponder
): Promise<Response> {
  await ensureCohortSchema(env.LIBRARY);

  const aRunId = (url.searchParams.get("a") ?? "").trim();
  const bRunId = (url.searchParams.get("b") ?? "").trim();
  if (!aRunId || !bRunId) {
    return json({ error: "missing 'a' and/or 'b' run id query params" }, 400);
  }

  // Resolve both runs (must belong to this cohort + owner).
  const runs = await env.LIBRARY.prepare(
    `SELECT id, job_id FROM cohort_runs
       WHERE cohort_id = ? AND owner = ? AND id IN (?, ?)`
  )
    .bind(cohortId, owner, aRunId, bRunId)
    .all<{ id: string; job_id: string }>();
  const runMap = new Map<string, string>();
  for (const r of runs.results ?? []) {
    runMap.set(r.id, r.job_id);
  }
  const aJob = runMap.get(aRunId);
  const bJob = runMap.get(bRunId);
  if (!aJob || !bJob) {
    return json({ error: "one or both runs not found for this cohort" }, 404);
  }

  // Load each run's per-(filename,brand) result rows from the owner's library.
  const aRows = await loadRunResults(env, owner, aJob);
  const bRows = await loadRunResults(env, owner, bJob);

  // Build the field-level diff keyed by (filename, brand).
  const keys = new Set<string>([...aRows.keys(), ...bRows.keys()]);
  const changes: {
    filename: string;
    brand: string;
    field: string;
    a: string | null;
    b: string | null;
  }[] = [];
  let unchangedCount = 0;
  let onlyInA = 0;
  let onlyInB = 0;

  for (const key of keys) {
    const a = aRows.get(key);
    const b = bRows.get(key);
    const [filename, brand] = splitKey(key);
    if (a && !b) {
      onlyInA += 1;
      changes.push({ filename, brand, field: "(present)", a: "yes", b: null });
      continue;
    }
    if (b && !a) {
      onlyInB += 1;
      changes.push({ filename, brand, field: "(present)", a: null, b: "yes" });
      continue;
    }
    if (!a || !b) continue;
    for (const field of COMPARE_FIELDS) {
      const av = fieldValue(a, field);
      const bv = fieldValue(b, field);
      if (av === bv) {
        unchangedCount += 1;
      } else {
        changes.push({ filename, brand, field, a: av, b: bv });
      }
    }
  }

  return json({
    cohort_id: cohortId,
    a: { run_id: aRunId, job_id: aJob },
    b: { run_id: bRunId, job_id: bJob },
    changes,
    changed_count: changes.length,
    unchanged_count: unchangedCount,
    only_in_a: onlyInA,
    only_in_b: onlyInB,
    pairs_compared: keys.size,
  });
}

/**
 * Load a job's per-(filename,brand) library results into a Map keyed by
 * makeKey(filename, brand) -> the ResultRow (read from the full R2 doc). Reads
 * the owner-scoped `analyses` index rows (job_id) then fetches each result_key
 * from R2. Only the latest row per (filename,brand) is kept (defensive against
 * dupes from re-saves).
 */
async function loadRunResults(
  env: CohortEnv,
  owner: string,
  jobId: string
): Promise<Map<string, Record<string, unknown>>> {
  const idxRes = await env.LIBRARY.prepare(
    `SELECT filename, brand, result_key, created_at
       FROM analyses WHERE owner = ? AND job_id = ? ORDER BY created_at ASC`
  )
    .bind(owner, jobId)
    .all<{
      filename: string;
      brand: string;
      result_key: string;
      created_at: number;
    }>();

  // Keep the LAST row per (filename,brand) (ASC order means later wins).
  const keyToResultKey = new Map<string, string>();
  for (const row of idxRes.results ?? []) {
    keyToResultKey.set(makeKey(row.filename, row.brand), row.result_key);
  }

  const out = new Map<string, Record<string, unknown>>();
  for (const [key, resultKey] of keyToResultKey) {
    const obj = await env.RESULT_BUCKET.get(resultKey);
    if (!obj) continue;
    let doc: ExtractResult;
    try {
      doc = (await obj.json()) as ExtractResult;
    } catch {
      continue;
    }
    const rr = doc?.result as Record<string, unknown> | undefined;
    if (rr && typeof rr === "object") {
      out.set(key, rr);
    }
  }
  return out;
}

/** Read one ResultRow field as a normalized display string (null if absent). */
function fieldValue(row: Record<string, unknown>, field: string): string | null {
  const v = row[field];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : String(v);
}

/**
 * Compose / split the (filename, brand) compare key. We use a multi-char
 * sentinel that cannot appear in one of the 15 uppercase brand tokens, so a
 * filename containing spaces can never collide with the boundary (splitKey
 * handles the pathological filename that itself contains the sentinel).
 */
const KEY_SEP = " :: ";
function makeKey(filename: string, brand: string): string {
  return `${filename}${KEY_SEP}${(brand ?? "").trim().toUpperCase()}`;
}
function splitKey(key: string): [string, string] {
  // lastIndexOf: the BRAND token can never contain the sentinel, but a filename
  // theoretically could — splitting on the LAST occurrence keeps such a
  // filename intact instead of truncating it at its first " :: ".
  const i = key.lastIndexOf(KEY_SEP);
  if (i < 0) return [key, ""];
  return [key.slice(0, i), key.slice(i + KEY_SEP.length)];
}

/** JSON.parse that returns null instead of throwing on malformed input. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
