/**
 * library.ts — the persistent, queryable analysis library.
 *
 * Every analysis (single /api/analyze run saved by the client, or a batch job
 * saved server-side by the JobCoordinator DO) is persisted so users can browse/
 * search past results, share permalinks, and reuse cached results. The split is:
 *
 *   - D1 (binding LIBRARY, table `analyses`): one INDEX/FACET row per
 *     (analysis, pdf, brand) result. Lean + fast to query/facet.
 *   - R2 (binding RESULT_BUCKET): the FULL result JSON (an ExtractResult — result
 *     + access_justification + meta + confidence + spans + policy_text) at key
 *     results/lib/<id>.json. D1.result_key points to it.
 *
 * TENANT SCOPING: `owner` is the authenticated identity. By DEFAULT it is taken
 * from the request header `cf-access-authenticated-user-email` (set by
 * Cloudflare Access), falling back to "anonymous" when absent. That header is
 * SPOOFABLE if the Worker is reachable without Access in front of it, so tenant
 * isolation REQUIRES Access enforcement on the route — OR the OPT-IN JWT mode
 * below. When ACCESS_TEAM_DOMAIN + ACCESS_AUD are configured, the owner is
 * derived from a cryptographically VERIFIED `Cf-Access-Jwt-Assertion` instead,
 * and a missing/invalid assertion is rejected with 401 (see resolveOwner).
 * EVERY library read and write is scoped to owner.
 *
 * The D1 schema is applied LAZILY via CREATE TABLE IF NOT EXISTS (ensureSchema)
 * before any query, so no local `wrangler d1 migrations` step is needed — the
 * operator only CREATEs the D1 database in the dashboard and pastes its
 * database_id into wrangler.jsonc.
 *
 * This module exports:
 *   - ownerFromRequest()        — header-trust owner (synchronous fallback).
 *   - resolveOwner()            — opt-in Access-JWT verification, else header-trust.
 *   - ensureLibrarySchema()     — idempotent lazy schema (call before any query).
 *   - rowFromExtractResult()    — build a LibraryRow from one ExtractResult.
 *   - insertLibraryRow()        — INSERT one index row into D1.
 *   - persistResults()          — shared write path (R2 full json + D1 rows);
 *                                 used by the Worker route AND the DO on finalize.
 *   - the 4 route handlers (POST/GET list/GET by id/GET lookup) for the Worker.
 */

import type {
  ExtractResult,
  LibraryKind,
  LibraryListResponse,
  LibraryRow,
  LibrarySaveBody,
  LibrarySaveResponse,
  ResultRow,
} from "./types";
import {
  ACCESS_JWT_HEADER,
  clampRuns,
  parseExplain,
  verifyAccessJwt,
} from "./util";

/** Cloudflare Access identity header carrying the authenticated user email. */
const OWNER_HEADER = "cf-access-authenticated-user-email";

/** Fallback owner when the Access header is absent (unauthenticated). */
const ANON_OWNER = "anonymous";

/**
 * Opt-in Cloudflare Access JWT config. When BOTH are set (non-empty), tenant
 * identity is derived from a VERIFIED `Cf-Access-Jwt-Assertion` and a missing/
 * invalid assertion is a 401. When either is unset, the Worker keeps today's
 * header-trust behaviour (see resolveOwner).
 */
export interface AccessConfig {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

/** Discriminated result of resolveOwner: a verified/derived owner, or a 401. */
export type OwnerResult =
  | { owner: string }
  | { unauthorized: true; reason: string };

/** R2 key prefix for full library result JSON documents. */
const LIB_PREFIX = "results/lib/";

/** Hard cap on rows returned by GET /api/library (defensive against scans). */
const MAX_LIMIT = 200;

/** Default page size when `limit` is absent/invalid. */
const DEFAULT_LIMIT = 50;

/**
 * Derive the OWNER from the (TRUSTED) Cloudflare Access identity HEADER, or
 * "anonymous" when absent. Trimmed + lowercased so the same identity always maps
 * to the same tenant bucket. This is the legacy header-trust path: it is only
 * safe when Cloudflare Access is enforced in front of the Worker (otherwise the
 * header is spoofable). Prefer resolveOwner(), which adds opt-in JWT verification.
 */
export function ownerFromRequest(request: Request): string {
  const raw = request.headers.get(OWNER_HEADER);
  const owner = raw?.trim().toLowerCase();
  return owner ? owner : ANON_OWNER;
}

/**
 * Resolve the OWNER for a request with OPT-IN Access-JWT verification (security
 * fix #2). Behaviour:
 *
 *   - ACCESS_TEAM_DOMAIN + ACCESS_AUD BOTH set  ->  VERIFY the
 *     `Cf-Access-Jwt-Assertion` header (RS256 against the team certs, aud + exp
 *     checks). On success the owner is the verified email; on a missing/invalid
 *     assertion we return { unauthorized } so the caller can answer 401. The
 *     spoofable `cf-access-authenticated-user-email` header is IGNORED in this
 *     mode — identity comes only from the signed assertion.
 *
 *   - either var UNSET  ->  fall back to ownerFromRequest() (today's header
 *     trust). Tenant isolation then REQUIRES Cloudflare Access enforcement on
 *     the route, since the header is otherwise spoofable.
 */
export async function resolveOwner(
  env: AccessConfig,
  request: Request
): Promise<OwnerResult> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();

  // JWT mode disabled -> legacy header trust (unchanged).
  if (!team || !aud) {
    return { owner: ownerFromRequest(request) };
  }

  const assertion = request.headers.get(ACCESS_JWT_HEADER)?.trim();
  if (!assertion) {
    return { unauthorized: true, reason: "missing Access assertion" };
  }

  const verdict = await verifyAccessJwt(assertion, team, aud);
  if (!verdict.ok) {
    return { unauthorized: true, reason: verdict.reason };
  }
  const owner = verdict.email.trim().toLowerCase();
  return { owner: owner || ANON_OWNER };
}

/**
 * Apply the library schema LAZILY. Idempotent (CREATE TABLE/INDEX IF NOT EXISTS)
 * so it is safe to call before every query. We run the statements in a single
 * batch so the round-trip cost is one request, not several.
 */
export async function ensureLibrarySchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS analyses (
         id              TEXT PRIMARY KEY,
         created_at      INTEGER NOT NULL,
         owner           TEXT NOT NULL,
         kind            TEXT NOT NULL,
         job_id          TEXT,
         filename        TEXT NOT NULL,
         file_sha256     TEXT NOT NULL,
         brand           TEXT NOT NULL,
         access_score    INTEGER,
         age             TEXT NOT NULL DEFAULT '',
         branded_steps   TEXT NOT NULL DEFAULT '',
         generic_steps   TEXT NOT NULL DEFAULT '',
         phototherapy    TEXT NOT NULL DEFAULT '',
         tb              TEXT NOT NULL DEFAULT '',
         quantity_limits TEXT NOT NULL DEFAULT '',
         specialist      TEXT NOT NULL DEFAULT '',
         init_auth       TEXT NOT NULL DEFAULT '',
         reauth_required TEXT NOT NULL DEFAULT '',
         runs            INTEGER NOT NULL DEFAULT 1,
         explain         INTEGER NOT NULL DEFAULT 0,
         result_key      TEXT NOT NULL
       )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_analyses_owner_brand
         ON analyses (owner, brand)`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_analyses_owner_created
         ON analyses (owner, created_at)`
    ),
    db.prepare(
      // Cache lookup index: covers the (owner, file_sha256, brand, runs, explain)
      // equality predicate AND the trailing `ORDER BY created_at DESC LIMIT 1`, so
      // the most-recent lookup is index-only (no sort step).
      `CREATE INDEX IF NOT EXISTS idx_analyses_owner_cache
         ON analyses (owner, file_sha256, brand, runs, explain, created_at)`
    ),
  ]);
}

/** Read a display-column string off a ResultRow, defaulting to "". */
function col(row: ResultRow | undefined, key: keyof ResultRow): string {
  if (!row) return "";
  const v = row[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Coerce the Access Score to an integer bucket, or null when unavailable. */
function accessScore(row: ResultRow | undefined): number | null {
  if (!row) return null;
  const v = row["Access Score"];
  // Number(null) / Number("") coerce to 0 — an absent/blank score must stay
  // "unavailable" (null), never become a real 0 bucket.
  if (v == null || String(v).trim() === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Build the D1 INDEX/FACET row for one ExtractResult. Pulls the facet params off
 * `result.result` (a ResultRow keyed by the exact deliverable display columns)
 * and stamps in the owner/kind/cache fields. `id` is the uuid that is ALSO the
 * R2 object key (results/lib/<id>.json) via `result_key`.
 */
export function rowFromExtractResult(args: {
  id: string;
  createdAt: number;
  owner: string;
  kind: LibraryKind;
  jobId: string | null;
  fileSha256: string;
  runs: number;
  explain: boolean;
  result: ExtractResult;
}): LibraryRow {
  const r = args.result?.result;
  return {
    id: args.id,
    created_at: args.createdAt,
    owner: args.owner,
    kind: args.kind,
    job_id: args.jobId,
    filename: col(r, "Filename"),
    file_sha256: args.fileSha256,
    // Normalize brand on WRITE to match the uppercased read/filter/lookup side,
    // so the cache index + brand filter never miss on casing.
    brand: col(r, "Brand").trim().toUpperCase(),
    access_score: accessScore(r),
    age: col(r, "Age"),
    branded_steps: col(r, "Number of Steps through Brands"),
    generic_steps: col(r, "Number of Steps through Generic"),
    phototherapy: col(r, "Step through-Phototherapy"),
    tb: col(r, "TB Test required"),
    quantity_limits: col(r, "Quantity Limits"),
    specialist: col(r, "Specialist Types"),
    init_auth: col(r, "Initial Authorization Duration(in-months)"),
    reauth_required: col(r, "Reauthorization Required"),
    runs: args.runs,
    explain: args.explain ? 1 : 0,
    result_key: LIB_PREFIX + args.id,
  };
}

/** Build the prepared INSERT statement for one library row (bound, unrun). */
function insertStatement(db: D1Database, row: LibraryRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO analyses (
         id, created_at, owner, kind, job_id, filename, file_sha256, brand,
         access_score, age, branded_steps, generic_steps, phototherapy, tb,
         quantity_limits, specialist, init_auth, reauth_required, runs, explain,
         result_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      row.id,
      row.created_at,
      row.owner,
      row.kind,
      row.job_id,
      row.filename,
      row.file_sha256,
      row.brand,
      row.access_score,
      row.age,
      row.branded_steps,
      row.generic_steps,
      row.phototherapy,
      row.tb,
      row.quantity_limits,
      row.specialist,
      row.init_auth,
      row.reauth_required,
      row.runs,
      row.explain,
      row.result_key
    );
}

/** INSERT one library index row into D1. */
export async function insertLibraryRow(
  db: D1Database,
  row: LibraryRow
): Promise<void> {
  await insertStatement(db, row).run();
}

/**
 * Shared write path used by BOTH the POST /api/library Worker route and the
 * JobCoordinator DO's finalizeJob. For each ExtractResult: mint a uuid, write the
 * FULL object to R2 at results/lib/<id>.json, build the index row, then INSERT all
 * index rows to D1 (batched). Returns a compact descriptor of what was saved.
 *
 * Schema is ensured first so callers never have to remember to. R2 writes happen
 * before the D1 inserts so a row never points at a missing object.
 */
export async function persistResults(args: {
  db: D1Database;
  bucket: R2Bucket;
  owner: string;
  kind: LibraryKind;
  jobId: string | null;
  fileSha256: string;
  runs: number;
  explain: boolean;
  results: ExtractResult[];
}): Promise<LibrarySaveResponse> {
  await ensureLibrarySchema(args.db);

  const createdAt = Date.now();
  const rows: LibraryRow[] = [];

  for (const result of args.results) {
    if (!result || typeof result !== "object") continue;
    const id = crypto.randomUUID();
    const row = rowFromExtractResult({
      id,
      createdAt,
      owner: args.owner,
      kind: args.kind,
      jobId: args.jobId,
      fileSha256: args.fileSha256,
      runs: args.runs,
      explain: args.explain,
      result,
    });

    // Write the full result JSON to R2 first (the row points at this key).
    await args.bucket.put(row.result_key, JSON.stringify(result), {
      httpMetadata: { contentType: "application/json" },
    });
    rows.push(row);
  }

  if (rows.length > 0) {
    await args.db.batch(rows.map((row) => insertStatement(args.db, row)));
  }

  return {
    saved: rows.map((r) => ({ id: r.id, brand: r.brand, filename: r.filename })),
    count: rows.length,
  };
}

// ── Worker route handlers ─────────────────────────────────────────────────────
//
// These take the raw request + env + a `json` helper (so they reuse the Worker's
// security-headers JSON responder) and return a ready Response.

type JsonResponder = (body: unknown, status?: number) => Response;

/**
 * Resolve the owner or short-circuit with a 401 Response. Centralizes the opt-in
 * Access-JWT check so every owner-scoped handler enforces it identically: returns
 * the verified owner string, or a ready 401 Response (when JWT mode is on and the
 * assertion is missing/invalid).
 */
async function ownerOr401(
  env: AccessConfig,
  request: Request,
  json: JsonResponder
): Promise<string | Response> {
  const res = await resolveOwner(env, request);
  if ("unauthorized" in res) {
    return json({ error: `unauthorized: ${res.reason}` }, 401);
  }
  return res.owner;
}

/**
 * POST /api/library — body JSON { kind, job_id?, file_sha256, runs, explain,
 * results:[<ExtractResult>...] }. Owner-scoped. Saves each result to R2 + D1 and
 * returns { saved:[{id,brand,filename}], count }.
 */
export async function handleLibrarySave(
  env: AccessConfig & { LIBRARY: D1Database; RESULT_BUCKET: R2Bucket },
  request: Request,
  json: JsonResponder
): Promise<Response> {
  const owner = await ownerOr401(env, request, json);
  if (owner instanceof Response) return owner;

  let body: LibrarySaveBody;
  try {
    body = (await request.json()) as LibrarySaveBody;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }

  if (!body || typeof body !== "object") {
    return json({ error: "expected a JSON object body" }, 400);
  }

  const kind: LibraryKind = body.kind === "batch" ? "batch" : "single";
  const fileSha256 =
    typeof body.file_sha256 === "string" ? body.file_sha256 : "";
  if (!fileSha256) {
    return json({ error: "missing 'file_sha256'" }, 400);
  }

  const results = Array.isArray(body.results) ? body.results : [];
  if (results.length === 0) {
    return json({ error: "missing 'results' (non-empty array)" }, 400);
  }

  const runs = clampRuns(body.runs);
  const explain = body.explain === true;
  const jobId = typeof body.job_id === "string" && body.job_id ? body.job_id : null;

  const saved = await persistResults({
    db: env.LIBRARY,
    bucket: env.RESULT_BUCKET,
    owner,
    kind,
    jobId,
    fileSha256,
    runs,
    explain,
    results,
  });

  return json(saved satisfies LibrarySaveResponse, 201);
}

/**
 * GET /api/library — owner-scoped browse/search. Query params: brand, q (filename
 * contains), minScore, maxScore, from, to (created_at ms range), limit(<=200),
 * offset. Returns { rows:[<index row>...], total }.
 */
export async function handleLibraryList(
  env: AccessConfig & { LIBRARY: D1Database },
  request: Request,
  url: URL,
  json: JsonResponder
): Promise<Response> {
  const owner = await ownerOr401(env, request, json);
  if (owner instanceof Response) return owner;
  await ensureLibrarySchema(env.LIBRARY);
  const p = url.searchParams;

  // Build a WHERE clause that ALWAYS pins owner first (tenant scope), appending
  // optional facet filters as bound params (never string-interpolated).
  const where: string[] = ["owner = ?"];
  const bind: (string | number)[] = [owner];

  const brand = p.get("brand");
  if (brand) {
    where.push("brand = ?");
    bind.push(brand.trim().toUpperCase());
  }

  const q = p.get("q");
  if (q && q.trim()) {
    where.push("filename LIKE ? ESCAPE '\\'");
    bind.push("%" + escapeLike(q.trim()) + "%");
  }

  const minScore = toInt(p.get("minScore"));
  if (minScore !== null) {
    where.push("access_score >= ?");
    bind.push(minScore);
  }
  const maxScore = toInt(p.get("maxScore"));
  if (maxScore !== null) {
    where.push("access_score <= ?");
    bind.push(maxScore);
  }

  const from = toInt(p.get("from"));
  if (from !== null) {
    where.push("created_at >= ?");
    bind.push(from);
  }
  const to = toInt(p.get("to"));
  if (to !== null) {
    where.push("created_at <= ?");
    bind.push(to);
  }

  const whereSql = where.join(" AND ");

  const limit = clampLimit(p.get("limit"));
  const offset = Math.max(0, toInt(p.get("offset")) ?? 0);

  // total (owner-scoped, same filters) + the page, in one batch.
  const countStmt = env.LIBRARY.prepare(
    `SELECT COUNT(*) AS total FROM analyses WHERE ${whereSql}`
  ).bind(...bind);
  const pageStmt = env.LIBRARY.prepare(
    `SELECT * FROM analyses WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...bind, limit, offset);

  const [countRes, pageRes] = await env.LIBRARY.batch<Record<string, unknown>>([
    countStmt,
    pageStmt,
  ]);

  const total = Number(
    (countRes.results?.[0] as { total?: number } | undefined)?.total ?? 0
  );
  const rows = (pageRes.results ?? []) as unknown as LibraryRow[];

  return json({ rows, total } satisfies LibraryListResponse);
}

/**
 * GET /api/library/:id — owner-checked. Streams the full result JSON from R2
 * (results/lib/<id>.json). 404 if the row is missing, not owned by this caller,
 * or the R2 object is gone.
 */
export async function handleLibraryGet(
  env: AccessConfig & { LIBRARY: D1Database; RESULT_BUCKET: R2Bucket },
  request: Request,
  id: string,
  json: JsonResponder,
  applySecurityHeaders: (h: Headers) => void
): Promise<Response> {
  const owner = await ownerOr401(env, request, json);
  if (owner instanceof Response) return owner;
  await ensureLibrarySchema(env.LIBRARY);

  // Owner check via D1: only this caller's rows are visible.
  const row = await env.LIBRARY.prepare(
    "SELECT result_key FROM analyses WHERE id = ? AND owner = ? LIMIT 1"
  )
    .bind(id, owner)
    .first<{ result_key: string }>();

  if (!row) {
    return json({ error: "not found" }, 404);
  }

  const obj = await env.RESULT_BUCKET.get(row.result_key);
  if (!obj) {
    return json({ error: "not found" }, 404);
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applySecurityHeaders(headers);
  return new Response(obj.body, { status: 200, headers });
}

/**
 * GET /api/library/lookup?sha=&brand=&runs=&explain= — the RESPONSE CACHE. Finds
 * the MOST-RECENT owner-scoped row matching (file_sha256, brand, runs, explain)
 * and streams its full result JSON from R2. 404 if there is no match. Lets the UI
 * offer an instant cached result before re-running an analysis.
 */
export async function handleLibraryLookup(
  env: AccessConfig & { LIBRARY: D1Database; RESULT_BUCKET: R2Bucket },
  request: Request,
  url: URL,
  json: JsonResponder,
  applySecurityHeaders: (h: Headers) => void
): Promise<Response> {
  const owner = await ownerOr401(env, request, json);
  if (owner instanceof Response) return owner;
  await ensureLibrarySchema(env.LIBRARY);
  const p = url.searchParams;

  const sha = (p.get("sha") ?? "").trim();
  const brand = (p.get("brand") ?? "").trim().toUpperCase();
  if (!sha || !brand) {
    return json({ error: "missing 'sha' and/or 'brand'" }, 400);
  }
  const runs = clampRuns(p.get("runs"));
  const explain = parseExplain(p.get("explain"));

  const row = await env.LIBRARY.prepare(
    `SELECT result_key FROM analyses
       WHERE owner = ? AND file_sha256 = ? AND brand = ? AND runs = ? AND explain = ?
       ORDER BY created_at DESC LIMIT 1`
  )
    .bind(owner, sha, brand, runs, explain ? 1 : 0)
    .first<{ result_key: string }>();

  if (!row) {
    return json({ error: "no cached result" }, 404);
  }

  const obj = await env.RESULT_BUCKET.get(row.result_key);
  if (!obj) {
    return json({ error: "no cached result" }, 404);
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applySecurityHeaders(headers);
  return new Response(obj.body, { status: 200, headers });
}

// ── small parse/clamp helpers ─────────────────────────────────────────────────

/** Parse an int from a query value, or null when absent/non-numeric. */
function toInt(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Clamp the list `limit` to 1..MAX_LIMIT, defaulting to DEFAULT_LIMIT. */
function clampLimit(raw: string | null): number {
  const n = toInt(raw);
  if (n === null) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

/** Escape LIKE wildcards (% and _) and the escape char itself for a contains-match. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}
