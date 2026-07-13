/**
 * pa-policy-extractor — Cloudflare Worker
 *
 * This Worker is a thin, robust front for a Cloudflare Container that runs the
 * Python extraction pipeline (Docling/Surya OCR -> brand reducer -> DeepSeek v4-pro
 * extraction + access scoring). The Worker:
 *   - serves the static UI from ./public via the ASSETS binding
 *   - routes /api/* to the container Durable Object (PaContainer)
 *
 * Container HTTP API (see container/app.py):
 *   GET  /health   liveness + LLM config + warm state
 *   GET  /brands   the 15 in-scope brands
 *   POST /extract  multipart { file: PDF, brand: <one of 15> } -> rich result JSON
 *   POST /analyze  multipart { file: PDF, brands: csv, runs, explain } -> NDJSON
 *                  stream (multi-brand); used by the JobCoordinator DO + Worker
 *
 * The container reads DeepSeek / AI Gateway config from process env; the Worker
 * forwards those values into the container via the `envVars` map below.
 */

import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "../worker-configuration";
import type {
  Brand,
  BrandsResponse,
  ErrorResponse,
  HealthDownResponse,
} from "./types";
import type { RateLimitVerdict } from "./rate-limiter";
import {
  ensureLibrarySchema,
  handleLibraryGet,
  handleLibraryList,
  handleLibraryLookup,
  handleLibrarySave,
  resolveOwner,
} from "./library";
import {
  ensureCohortSchema,
  handleCohortCompare,
  handleCohortCreate,
  handleCohortDelete,
  handleCohortList,
  handleCohortPatch,
  handleCohortRun,
  handleCohortRuns,
  runCohort,
} from "./cohorts";
import {
  handleWebCheckCreate,
  handleWebCheckGet,
  handleWebCheckStatus,
} from "./web-check";
import { handleAsk, handleKnowledgeBackfill } from "./knowledge";
import { clampRuns, parseBrandsCsv, parseExplain } from "./util";

// Re-export the RateLimiter DO so wrangler can bind the class from src/index.ts
// (the configured `main`). The implementation lives in ./rate-limiter.
export { RateLimiter } from "./rate-limiter";

// Re-export the JobCoordinator DO (Layer 3: async/batch jobs) so wrangler can
// bind the class from this `main` entrypoint. Implementation in ./job-coordinator.
export { JobCoordinator } from "./job-coordinator";

// Re-export the WebCheckWorkflow (P0: advisory live web check) so wrangler can
// bind the Workflow class from this `main` entrypoint. Implementation in
// ./web-check.
export { WebCheckWorkflow } from "./web-check";

/**
 * The 15 in-scope brands (exact, uppercase). Kept in the Worker so /api/brands
 * can answer instantly without spinning up the container. Typed as Brand[] so it
 * stays in lockstep with the Brand union in ./types.
 */
const BRANDS: readonly Brand[] = [
  "TREMFYA",
  "STELARA",
  "COSENTYX",
  "SKYRIZI",
  "ENBREL",
  "OTEZLA",
  "BIMZELX",
  "SILIQ",
  "ILUMYA",
  "CIMZIA",
  "AMJEVITA",
  "REMICADE",
  "OTULFI",
  "YESINTEK",
  "ACITRETIN",
] as const;

/** Reject uploads larger than ~20MB before paying to wake the container. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Hard cap on a whole /api/jobs multipart body. request.formData() BUFFERS the
 * body in memory and a Workers isolate has a 128MB memory limit, so the cap must
 * stay safely under it regardless of MAX_PDFS_PER_JOB * MAX_UPLOAD_BYTES (which
 * alone would allow ~500MB at the defaults).
 */
const MAX_JOB_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Layer 3 LLM-call budget per PDF — the Worker's up-front mirror of the
 * container's configurable MAX_LLM_CALLS (#4: default "200"). A job submission is
 * rejected up front if any PDF would exceed it, so we never stage work the
 * container will refuse: brands * (2*runs + (explain ? 1 : 0) + validators*runs),
 * where `validators` is non-zero only when the job opts into W3-ext consensus
 * AND the secondary provider is configured (numValidators mirrors the container's
 * llm.secondary_enabled() gate). The JobCoordinator forwards the job's
 * `consensus` flag to the container per PDF.
 */
const DEFAULT_MAX_LLM_CALLS = 200;

/** Resolve the configurable per-PDF LLM-call budget from env (default 200 — sized for the worst legal request: 15 brands * (2*3 deep runs + 1 spans + 2 validators * 3 runs) = 195). */
function maxLlmCalls(env: Env): number {
  const n = Number(env.MAX_LLM_CALLS ?? "");
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_MAX_LLM_CALLS;
}

/**
 * Default Workers AI validator list — mirrors PaContainer.envVars below.
 * Both models have 128k context on Workers AI (policy docs reach ~75k tokens;
 * Workers AI hard-errors on oversized input) and top-tier JSON reliability.
 */
const DEFAULT_VALIDATOR_MODELS =
  "@cf/openai/gpt-oss-20b,@cf/mistralai/mistral-small-3.1-24b-instruct";

/**
 * Mirror the container's llm.secondary_enabled() gate for the batch budget: the
 * W3-ext validators only run when CF_API_TOKEN (the Workers AI token) AND
 * CF_AIG_ACCOUNT_ID (which builds the secondary base URL) are configured AND the
 * VALIDATOR_MODELS list is non-empty. Returns the active validator count — 0
 * whenever consensus would silently no-op in the container, so the Worker's
 * budget check never rejects a job the container would have accepted.
 */
function numValidators(env: Env): number {
  if (!env.CF_API_TOKEN?.trim() || !env.CF_AIG_ACCOUNT_ID?.trim()) return 0;
  const csv = env.VALIDATOR_MODELS ?? DEFAULT_VALIDATOR_MODELS;
  return csv.split(",").filter((m) => m.trim()).length;
}

/**
 * Sticky routing (Layer 2): the dashboard sends ?route=<sha256hex-of-pdf>. We
 * map that to a stable container instance name ("pa-" + route) so the SAME PDF
 * always lands on the SAME instance (OCR-once cache hit), while DISTINCT PDFs
 * land on distinct instances and run in parallel. The container is expensive to
 * wake (it loads OCR models), so a stable name per PDF keeps the relevant
 * instance warm across the multi-brand fan-out (it sleeps after `sleepAfter`).
 */
const ROUTE_PREFIX = "pa-";

/**
 * Fallback round-robin pool used only when ?route= is absent. A small fixed set
 * of named instances spreads stray/manual requests without spinning up an
 * unbounded number of containers.
 */
const FALLBACK_POOL: readonly string[] = ["pa-pool-0", "pa-pool-1", "pa-pool-2"];

/** Hex sha256 is 64 lowercase hex chars; we sanity-check `route` against this. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Round-robin cursor for the fallback pool (per isolate; good enough to spread). */
let fallbackCursor = 0;

/**
 * Pick the container instance name for this request. With a valid ?route= hash
 * we key on it (sticky); otherwise we round-robin the small fallback pool.
 */
function instanceNameFor(url: URL): string {
  const route = url.searchParams.get("route");
  if (route && SHA256_HEX.test(route)) {
    return ROUTE_PREFIX + route;
  }
  const name = FALLBACK_POOL[fallbackCursor % FALLBACK_POOL.length];
  fallbackCursor += 1;
  return name;
}

/**
 * PaContainer — the Container Durable Object. Listens on 8080 and forwards the
 * DeepSeek / AI Gateway environment into the container process so llm.py can
 * build the gateway endpoint (and fall back to api.deepseek.com if absent).
 */
export class PaContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "3m";

  // Forward the secret + plain vars from the Worker env into the container
  // process. ALL names the container expects are listed here.
  envVars = {
    DEEPSEEK_API_KEY: this.env.DEEPSEEK_API_KEY ?? "",
    CF_AIG_TOKEN: this.env.CF_AIG_TOKEN ?? "",
    CF_AIG_ACCOUNT_ID: this.env.CF_AIG_ACCOUNT_ID ?? "",
    CF_AIG_GATEWAY_ID: this.env.CF_AIG_GATEWAY_ID ?? "",
    DEEPSEEK_MODEL: this.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    DEEPSEEK_THINKING: this.env.DEEPSEEK_THINKING ?? "on",
    DEEPSEEK_REASONING_EFFORT: this.env.DEEPSEEK_REASONING_EFFORT ?? "high",
    // W3 (optional multi-model consensus): the SECONDARY Workers AI extractor.
    // CF_API_TOKEN is a dashboard SECRET (Cloudflare account token scoped to
    // Workers AI); absent => consensus silently no-ops in the container.
    // The container reuses CF_AIG_ACCOUNT_ID (+ CF_AIG_GATEWAY_ID, forwarded
    // above) to route validator calls through the AI Gateway (spend cap applies).
    CF_API_TOKEN: this.env.CF_API_TOKEN ?? "",
    SECONDARY_MODEL: this.env.SECONDARY_MODEL ?? "@cf/openai/gpt-oss-20b",
    // W3-ext (3-model consensus): the LIST of Workers AI VALIDATOR models (CSV of
    // @cf/ ids) the container runs alongside the canonical DeepSeek extractor when
    // the request opts into consensus (the UI enables it by default). Both
    // defaults are 128k-context models (docs reach ~75k tokens; Workers AI
    // hard-errors on oversized input) with top-tier JSON reliability.
    VALIDATOR_MODELS: this.env.VALIDATOR_MODELS ?? DEFAULT_VALIDATOR_MODELS,
    // #4 (deploy): the documented, configurable per-PDF LLM-call budget the
    // container enforces (container/app.py reads MAX_LLM_CALLS from env). Default
    // "200" (worst legal request: 15 brands * (2*3 + 1 + 2*3) = 195) — mirrored
    // by the Worker's up-front job budget check (maxLlmCalls).
    MAX_LLM_CALLS: this.env.MAX_LLM_CALLS ?? "200",
    // Accuracy-pipeline tunables (container/pipeline reads these; defaults match
    // the in-code constants so omitting them changes nothing). CONFIDENCE_RUNS
    // is the omitted-`runs` default — "1" keeps interactive uploads fast (the UI
    // Deep-Confidence toggle / batch path send runs explicitly); the other two
    // are the override layer's reducer-passthrough and scoring-truncation
    // thresholds.
    CONFIDENCE_RUNS: this.env.CONFIDENCE_RUNS ?? "1",
    REDUCER_PASSTHROUGH_CHARS: this.env.REDUCER_PASSTHROUGH_CHARS ?? "100000",
    SCORING_MAX_CHARS: this.env.SCORING_MAX_CHARS ?? "300000",
    // Primary input guard — above the scoring cap so small/medium documents
    // reach the model whole; huge documents get brand-aware window packing.
    // Kept well under DeepSeek's 1M-token window: maximal-context prefill
    // measured at 10+ min/call, untenable for interactive use.
    PRIMARY_MAX_CHARS: this.env.PRIMARY_MAX_CHARS ?? "600000",
  };
}

/**
 * Content-Security-Policy and companion security headers applied to EVERY
 * response (assets + api), per the shared contract. No inline <script> is
 * allowed (script-src 'self'); inline style attributes remain allowed via
 * style-src 'unsafe-inline'.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; font-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'self'; object-src 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Mutate a Headers object in place to carry the shared security headers. */
function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
}

/**
 * Wrap a Response so the security headers are present without copying/buffering
 * the body (the body stream is reused as-is — safe for the NDJSON passthrough).
 */
function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** Small helper: JSON response with sane defaults (incl. security headers). */
function json(body: unknown, status = 200): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Empty response carrying the shared security headers. */
function empty(status = 204): Response {
  const headers = new Headers();
  applySecurityHeaders(headers);
  return new Response(null, { status, headers });
}

/**
 * Proxy a request to the container at `path`. The original request is streamed
 * through unchanged (method + headers + body) by re-pointing its URL at the
 * container path — we never re-parse the multipart body. `instanceName`
 * implements sticky routing (see instanceNameFor): the same PDF reuses one warm
 * instance; distinct PDFs fan out across instances.
 */
async function proxyToContainer(
  env: Env,
  path: string,
  request: Request,
  instanceName: string
): Promise<Response> {
  const containerUrl = new URL(path, "http://c").toString();
  const proxied = new Request(containerUrl, request);
  const instance = getContainer(env.PA_CONTAINER, instanceName);
  return instance.fetch(proxied);
}

/**
 * Sliding-window rate-limit check, keyed by client IP (cf-connecting-ip). The
 * verdict comes from the per-IP RateLimiter Durable Object. Fail-open: if the
 * limiter itself errors we allow the request (availability > strictness here).
 * Returns null when allowed, or a ready-to-return 429 Response when blocked.
 */
async function enforceRateLimit(
  env: Env,
  request: Request
): Promise<Response | null> {
  // Identify the caller. Behind Cloudflare, cf-connecting-ip is the real client
  // IP; fall back to a shared bucket if it is somehow missing.
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";

  let verdict: RateLimitVerdict;
  try {
    const id = env.RATE_LIMITER.idFromName(ip);
    const stub = env.RATE_LIMITER.get(id);
    const res = await stub.fetch("https://rl/check");
    verdict = (await res.json()) as RateLimitVerdict;
  } catch {
    // Limiter unavailable -> fail open so a DO hiccup never blocks real users.
    return null;
  }

  if (verdict.allowed) {
    return null;
  }

  const retryAfter = Math.max(1, verdict.retry_after || 1);
  const res = json(
    {
      error:
        "rate limit exceeded: too many requests; retry in " +
        retryAfter +
        "s",
    } satisfies ErrorResponse,
    429
  );
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

// ─── Layer 3: async/batch jobs (/api/jobs, /api/results) ──────────────────────
//
// These routes are ADDITIVE — the live single-PDF flow above is untouched. The
// Worker stages uploads in R2 and delegates job lifecycle to the JobCoordinator
// DO (addressed by idFromName(jobId)); long work + streaming happen in the DO.

/** Set of valid brand names (uppercase) for validating the job `brands` csv. */
const BRAND_SET: ReadonlySet<string> = new Set(BRANDS);

/** Maximum JSON bytes accepted by POST /api/jobs/stage. */
const MAX_STAGE_JSON_BYTES = 64 * 1024;

/** Staging markers expire 48 hours after their latest successful upload. */
const STAGING_TTL_MS = 48 * 60 * 60 * 1000;

/** R2 prefix for staged-upload ownership and lifecycle markers. */
const STAGING_PREFIX = "staging/";

/** Strict base-10 byte-count syntax used for staged Content-Length headers. */
const DECIMAL_BYTES = /^[0-9]+$/;

/** The five bytes every staged PDF must begin with. */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

interface JobStageConfig {
  brands: string;
  runs: number;
  explain: boolean;
  consensus: boolean;
}

interface StageManifestEntry {
  index: number;
  filename: string;
  size: number;
}

type StageMarkerState = "uploading" | "committing" | "started";

interface StageMarker {
  owner: string;
  config: JobStageConfig;
  manifest: StageManifestEntry[];
  state: StageMarkerState;
  updated_at: number;
  expires: number;
}

interface LoadedStageMarker {
  marker: StageMarker;
  object: R2Object;
}

interface StreamLimitState {
  limit: number;
  bytes: number;
  exceeded: boolean;
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeded its byte limit");
    this.name = "BodyTooLargeError";
  }
}

class PdfMagicError extends Error {
  constructor() {
    super("staged upload is not a PDF");
    this.name = "PdfMagicError";
  }
}

class PdfLengthError extends Error {
  constructor() {
    super("staged upload body length did not match Content-Length");
    this.name = "PdfLengthError";
  }
}

/** True for a non-null JSON object that is not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve the configured batch PDF count cap, defaulting to 25. */
function maxPdfsPerJob(env: Env): number {
  const raw = Number(env.MAX_PDFS_PER_JOB ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 25;
}

/** Resolve the legacy multipart body cap without changing its existing size. */
function jobUploadCap(env: Env): number {
  return Math.min(
    maxPdfsPerJob(env) * MAX_UPLOAD_BYTES + 1024 * 1024,
    MAX_JOB_UPLOAD_BYTES
  );
}

/** Consistent 413 response for the legacy multipart stream limiter. */
function legacyJobTooLarge(bytes: string | number, cap: number): Response {
  return json(
    {
      error: `payload too large (${bytes} bytes > the ${cap} byte job upload limit)`,
    } satisfies ErrorResponse,
    413
  );
}

/**
 * Wrap a request body in an actual-byte counting stream. The multipart parser
 * consumes this wrapped request, so missing, malformed, or understated
 * Content-Length values cannot bypass the legacy job cap.
 */
function limitRequestBody(
  request: Request,
  limit: number
): { request: Request; state: StreamLimitState } {
  const state: StreamLimitState = {
    limit,
    bytes: 0,
    exceeded: false,
  };
  if (!request.body) {
    return { request, state };
  }

  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      state.bytes += chunk.byteLength;
      if (state.bytes > state.limit) {
        state.exceeded = true;
        throw new BodyTooLargeError();
      }
      controller.enqueue(chunk);
    },
  });

  return {
    request: new Request(request, {
      body: request.body.pipeThrough(counter),
    }),
    state,
  };
}

/** Read and parse a JSON request while enforcing an actual 64 KiB byte cap. */
async function readBoundedJson(
  request: Request,
  limit: number
): Promise<unknown> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && DECIMAL_BYTES.test(lengthHeader)) {
    const declared = BigInt(lengthHeader);
    if (declared > BigInt(limit)) {
      throw new BodyTooLargeError();
    }
  }
  if (!request.body) {
    throw new SyntaxError("missing JSON body");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel("request body exceeded its byte limit");
        } catch {
          // The size error below is authoritative.
        }
        throw new BodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Validate and normalize staged job config before any PDF can be uploaded. */
function validateStageConfig(
  env: Env,
  raw: unknown
):
  | { config: JobStageConfig }
  | { error: string; status: number } {
  if (!isRecord(raw)) {
    return { error: "config must be a JSON object", status: 400 };
  }

  const { csv: brands, error: brandError } = parseBrandsCsv(
    typeof raw.brands === "string" ? raw.brands : "",
    BRAND_SET
  );
  if (brandError) {
    return { error: brandError, status: 400 };
  }

  let runs = 3;
  if (raw.runs !== undefined) {
    const parsed =
      typeof raw.runs === "number" || typeof raw.runs === "string"
        ? Number(raw.runs)
        : NaN;
    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > 5
    ) {
      return { error: "runs must be an integer from 1 through 5", status: 400 };
    }
    runs = parsed;
  }

  const explain = parseExplain(raw.explain);
  const consensus = parseExplain(raw.consensus);
  const brandCount = brands.split(",").length;
  const validators = consensus ? numValidators(env) : 0;
  const callsPerPdf =
    brandCount * (2 * runs + (explain ? 1 : 0) + validators * runs);
  const budget = maxLlmCalls(env);
  if (callsPerPdf > budget) {
    return {
      error: `too many LLM calls per PDF (${callsPerPdf} > ${budget}); reduce brands or runs`,
      status: 400,
    };
  }

  return {
    config: {
      brands,
      runs,
      explain,
      consensus,
    },
  };
}

/** Validate a complete, contiguous staged manifest before creating its marker. */
function validateStageManifest(
  env: Env,
  raw: unknown
):
  | { manifest: StageManifestEntry[] }
  | { error: string; status: number } {
  if (!Array.isArray(raw)) {
    return { error: "manifest must be a JSON array", status: 400 };
  }
  if (raw.length === 0) {
    return { error: "manifest must contain at least one PDF", status: 400 };
  }

  const maxPdfs = maxPdfsPerJob(env);
  if (raw.length > maxPdfs) {
    return {
      error: `too many PDFs (${raw.length} > ${maxPdfs} per job)`,
      status: 400,
    };
  }

  const manifest: StageManifestEntry[] = [];
  let totalDeclared = 0;
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isRecord(item)) {
      return {
        error: `manifest entry ${i} must be a JSON object`,
        status: 400,
      };
    }

    if (
      item.index !== undefined &&
      (!Number.isInteger(item.index) || item.index !== i)
    ) {
      return {
        error: `manifest indexes must be contiguous from 0; expected ${i}`,
        status: 400,
      };
    }

    if (
      typeof item.filename !== "string" ||
      item.filename.trim().length === 0
    ) {
      return {
        error: `manifest entry ${i} has an invalid filename`,
        status: 400,
      };
    }

    if (
      typeof item.size !== "number" ||
      !Number.isSafeInteger(item.size) ||
      item.size <= 0
    ) {
      return {
        error: `manifest entry ${i} has an invalid declared size`,
        status: 400,
      };
    }
    if (item.size > MAX_UPLOAD_BYTES) {
      return {
        error: `PDF '${item.filename}' too large (${item.size} > ${MAX_UPLOAD_BYTES} bytes)`,
        status: 413,
      };
    }

    totalDeclared += item.size;
    if (!Number.isSafeInteger(totalDeclared)) {
      return { error: "manifest declared byte total is invalid", status: 400 };
    }

    manifest.push({
      index: i,
      filename: item.filename,
      size: item.size,
    });
  }

  const totalCap = maxPdfs * MAX_UPLOAD_BYTES;
  if (totalDeclared > totalCap) {
    return {
      error: `manifest declares too many bytes (${totalDeclared} > ${totalCap})`,
      status: 413,
    };
  }

  return { manifest };
}

/** R2 key for one staged-upload marker. */
function stageMarkerKey(uploadId: string): string {
  return `${STAGING_PREFIX}${uploadId}.json`;
}

/** Existing final R2 layout for one job PDF. */
function stagedPdfKey(uploadId: string, index: number): string {
  return `pdfs/${uploadId}/${index}.pdf`;
}

/** Structural guard for persisted staging markers. */
function isStageMarker(value: unknown): value is StageMarker {
  if (!isRecord(value) || !isRecord(value.config)) return false;
  if (
    typeof value.owner !== "string" ||
    !["uploading", "committing", "started"].includes(
      String(value.state)
    ) ||
    typeof value.updated_at !== "number" ||
    !Number.isFinite(value.updated_at) ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires) ||
    typeof value.config.brands !== "string" ||
    typeof value.config.runs !== "number" ||
    typeof value.config.explain !== "boolean" ||
    typeof value.config.consensus !== "boolean" ||
    !Array.isArray(value.manifest)
  ) {
    return false;
  }

  return value.manifest.every(
    (item, index) =>
      isRecord(item) &&
      item.index === index &&
      typeof item.filename === "string" &&
      typeof item.size === "number" &&
      Number.isSafeInteger(item.size) &&
      item.size > 0 &&
      item.size <= MAX_UPLOAD_BYTES
  );
}

/** Load and validate a staging marker, treating corrupt markers as absent. */
async function loadStageMarker(
  env: Env,
  uploadId: string
): Promise<LoadedStageMarker | null> {
  const object = await env.RESULT_BUCKET.get(stageMarkerKey(uploadId));
  if (!object) return null;

  try {
    const marker = await object.json<unknown>();
    if (!isStageMarker(marker)) return null;
    return { marker, object };
  } catch {
    return null;
  }
}

/** Write a marker, optionally using its previous ETag as a compare-and-swap. */
async function writeStageMarker(
  env: Env,
  uploadId: string,
  marker: StageMarker,
  etag?: string
): Promise<R2Object | null> {
  return env.RESULT_BUCKET.put(
    stageMarkerKey(uploadId),
    JSON.stringify(marker),
    etag
      ? {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagMatches: etag },
        }
      : {
          httpMetadata: { contentType: "application/json" },
        }
  );
}

/** Indistinguishable response for an unknown upload and an owner mismatch. */
function stageNotFound(): Response {
  return json(
    { error: "staging upload not found" } satisfies ErrorResponse,
    404
  );
}

/** Resolve the owner and owner-check a staging marker. */
async function accessStageMarker(
  env: Env,
  request: Request,
  uploadId: string
): Promise<
  | { owner: string; loaded: LoadedStageMarker }
  | { response: Response }
> {
  const ownerRes = await resolveOwner(env, request);
  if ("unauthorized" in ownerRes) {
    return {
      response: json(
        { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
        401
      ),
    };
  }

  const loaded = await loadStageMarker(env, uploadId);
  if (!loaded || loaded.marker.owner !== ownerRes.owner) {
    return { response: stageNotFound() };
  }
  return { owner: ownerRes.owner, loaded };
}

/**
 * Extend an active marker after a successful PUT. ETag compare-and-swap keeps
 * this update from reverting a concurrent start transition to "uploading".
 */
async function extendStageMarker(
  env: Env,
  uploadId: string,
  owner: string
): Promise<"extended" | "inactive" | "missing"> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await loadStageMarker(env, uploadId);
    if (!loaded || loaded.marker.owner !== owner) return "missing";
    if (loaded.marker.state !== "uploading") return "inactive";

    const now = Date.now();
    const next: StageMarker = {
      ...loaded.marker,
      updated_at: now,
      expires: now + STAGING_TTL_MS,
    };
    const written = await writeStageMarker(
      env,
      uploadId,
      next,
      loaded.object.etag
    );
    if (written) return "extended";
  }
  throw new Error("staging marker changed repeatedly; retry the upload");
}

/**
 * A validation stream that checks the five PDF magic bytes without buffering
 * the upload and independently checks the actual byte count. FixedLengthStream
 * remains the authoritative known-length stream passed to R2.
 */
function createPdfValidationStream(
  expectedLength: number
): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;
  let magicOffset = 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > expectedLength) {
        throw new PdfLengthError();
      }

      const magicBytes = Math.min(
        PDF_MAGIC.byteLength - magicOffset,
        chunk.byteLength
      );
      for (let i = 0; i < magicBytes; i++) {
        if (chunk[i] !== PDF_MAGIC[magicOffset + i]) {
          throw new PdfMagicError();
        }
      }
      magicOffset += magicBytes;
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes !== expectedLength) {
        throw new PdfLengthError();
      }
      if (magicOffset < PDF_MAGIC.byteLength) {
        throw new PdfMagicError();
      }
    },
  });
}

/** Whether any rejected operation contains an error of the requested class. */
function settledHasError(
  settled: PromiseSettledResult<unknown>[],
  errorType: typeof PdfMagicError | typeof PdfLengthError
): boolean {
  return settled.some(
    (result) =>
      result.status === "rejected" && result.reason instanceof errorType
  );
}

/**
 * Send the byte-identical start payload used by both legacy multipart and the
 * staged flow to the job's existing JobCoordinator Durable Object.
 */
async function startJobCoordinator(
  env: Env,
  jobId: string,
  owner: string,
  config: JobStageConfig,
  pdfs: { index: number; filename: string }[]
): Promise<Response> {
  const { brands, runs, explain, consensus } = config;
  const id = env.JOB_COORDINATOR.idFromName(jobId);
  const stub = env.JOB_COORDINATOR.get(id);
  return stub.fetch("https://jc/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jobId,
      owner,
      brands,
      runs,
      explain,
      consensus,
      pdfs,
    }),
  });
}

/** POST /api/jobs/stage: validate config and manifest, then mint a marker. */
async function handleCreateStage(
  env: Env,
  request: Request
): Promise<Response> {
  const limited = await enforceRateLimit(env, request);
  if (limited) return limited;

  const ownerRes = await resolveOwner(env, request);
  if ("unauthorized" in ownerRes) {
    return json(
      { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
      401
    );
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request, MAX_STAGE_JSON_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return json(
        {
          error: `stage request JSON exceeds ${MAX_STAGE_JSON_BYTES} bytes`,
        } satisfies ErrorResponse,
        413
      );
    }
    return json(
      { error: "expected a valid JSON stage request" } satisfies ErrorResponse,
      400
    );
  }

  if (!isRecord(body)) {
    return json(
      { error: "stage request must be a JSON object" } satisfies ErrorResponse,
      400
    );
  }

  const configResult = validateStageConfig(env, body.config);
  if ("error" in configResult) {
    return json(
      { error: configResult.error } satisfies ErrorResponse,
      configResult.status
    );
  }

  const manifestResult = validateStageManifest(env, body.manifest);
  if ("error" in manifestResult) {
    return json(
      { error: manifestResult.error } satisfies ErrorResponse,
      manifestResult.status
    );
  }

  const uploadId = crypto.randomUUID();
  const now = Date.now();
  const marker: StageMarker = {
    owner: ownerRes.owner,
    config: configResult.config,
    manifest: manifestResult.manifest,
    state: "uploading",
    updated_at: now,
    expires: now + STAGING_TTL_MS,
  };
  await writeStageMarker(env, uploadId, marker);

  return json(
    {
      uploadId,
      jobId: uploadId,
      uploads: marker.manifest.map((item) => ({
        index: item.index,
        url: `/api/jobs/stage/${uploadId}/files/${item.index}`,
      })),
      expires_at: marker.expires,
    },
    201
  );
}

/**
 * PUT one raw staged PDF into its final deterministic R2 key using a
 * FixedLengthStream. The rate limiter is deliberately not used here because a
 * legal 25-file batch would otherwise consume more than one heavy-request
 * window.
 */
async function handlePutStageFile(
  env: Env,
  request: Request,
  uploadId: string,
  indexText: string
): Promise<Response> {
  if (!DECIMAL_BYTES.test(indexText)) return stageNotFound();
  const index = Number(indexText);
  if (!Number.isSafeInteger(index)) return stageNotFound();

  const access = await accessStageMarker(env, request, uploadId);
  if ("response" in access) return access.response;
  const { owner, loaded } = access;

  const entry = loaded.marker.manifest.find((item) => item.index === index);
  if (!entry) return stageNotFound();
  if (loaded.marker.state !== "uploading") {
    return json(
      { error: "staging upload is no longer accepting files" } satisfies ErrorResponse,
      409
    );
  }

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader === null) {
    return json(
      { error: "Content-Length is required for staged PDF uploads" } satisfies ErrorResponse,
      411
    );
  }
  if (!DECIMAL_BYTES.test(lengthHeader)) {
    return json(
      { error: "Content-Length must be a decimal byte count" } satisfies ErrorResponse,
      400
    );
  }

  const contentLength = BigInt(lengthHeader);
  if (contentLength > BigInt(MAX_UPLOAD_BYTES)) {
    return json(
      {
        error: `PDF upload too large (${lengthHeader} > ${MAX_UPLOAD_BYTES} bytes)`,
      } satisfies ErrorResponse,
      413
    );
  }
  if (contentLength !== BigInt(entry.size)) {
    return json(
      {
        error: `Content-Length does not match the manifest (${lengthHeader} != ${entry.size})`,
      } satisfies ErrorResponse,
      409
    );
  }
  if (!request.body) {
    return json(
      { error: "staged PDF request body is missing" } satisfies ErrorResponse,
      400
    );
  }

  const key = stagedPdfKey(uploadId, index);
  const previous = await env.RESULT_BUCKET.head(key);
  const fixed = new FixedLengthStream(entry.size);
  const pumpPromise = request.body
    .pipeThrough(createPdfValidationStream(entry.size))
    .pipeTo(fixed.writable);
  const putPromise = env.RESULT_BUCKET.put(key, fixed.readable, {
    httpMetadata: { contentType: "application/pdf" },
  });
  const settled = await Promise.allSettled([pumpPromise, putPromise]);

  if (settled.some((result) => result.status === "rejected")) {
    // Streaming R2 puts are atomic. The delete additionally guarantees that a
    // failed first upload cannot leave a key, while preserving a prior good
    // object when an invalid re-PUT is attempted.
    if (!previous) {
      await env.RESULT_BUCKET.delete(key);
    }
    if (settledHasError(settled, PdfMagicError)) {
      return json(
        { error: `file '${entry.filename}' is not a PDF` } satisfies ErrorResponse,
        415
      );
    }
    if (settledHasError(settled, PdfLengthError)) {
      return json(
        {
          error: "uploaded body length did not match Content-Length",
        } satisfies ErrorResponse,
        400
      );
    }
    return json(
      { error: "failed to stage PDF upload" } satisfies ErrorResponse,
      502
    );
  }

  const refresh = await extendStageMarker(env, uploadId, owner);
  if (refresh === "missing") {
    await env.RESULT_BUCKET.delete(key);
    return stageNotFound();
  }

  return empty();
}

/** Return the manifest indexes whose final R2 objects are absent or wrong-size. */
async function missingStageIndexes(
  env: Env,
  uploadId: string,
  manifest: StageManifestEntry[]
): Promise<number[]> {
  const heads = await Promise.all(
    manifest.map((item) =>
      env.RESULT_BUCKET.head(stagedPdfKey(uploadId, item.index))
    )
  );
  const missing: number[] = [];
  for (let i = 0; i < manifest.length; i++) {
    if (!heads[i] || heads[i]!.size !== manifest[i].size) {
      missing.push(manifest[i].index);
    }
  }
  return missing;
}

/** Persist the started tombstone after the idempotent DO start succeeds. */
async function persistStartedStage(
  env: Env,
  uploadId: string,
  owner: string,
  fallback: StageMarker
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const loaded = await loadStageMarker(env, uploadId);
    if (loaded && loaded.marker.owner !== owner) {
      throw new Error("staging marker owner changed");
    }
    if (loaded?.marker.state === "started") return;

    const source = loaded?.marker ?? fallback;
    const now = Date.now();
    const started: StageMarker = {
      ...source,
      state: "started",
      updated_at: now,
      expires: now + STAGING_TTL_MS,
    };
    const written = await writeStageMarker(
      env,
      uploadId,
      started,
      loaded?.object.etag
    );
    if (written) return;
  }
  throw new Error("could not persist staging start tombstone");
}

/** POST /api/jobs/stage/:uploadId/start: verify uploads and start the DO. */
async function handleStartStage(
  env: Env,
  request: Request,
  uploadId: string
): Promise<Response> {
  const access = await accessStageMarker(env, request, uploadId);
  if ("response" in access) return access.response;
  const { owner } = access;
  let loaded = access.loaded;

  if (loaded.marker.state === "started") {
    return json({ jobId: uploadId }, 202);
  }

  if (loaded.marker.state === "uploading") {
    const missing = await missingStageIndexes(
      env,
      uploadId,
      loaded.marker.manifest
    );
    if (missing.length > 0) {
      return json(
        {
          error: "not all staged PDFs have been uploaded",
          missing,
        },
        409
      );
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now();
      const committing: StageMarker = {
        ...loaded.marker,
        state: "committing",
        updated_at: now,
        expires: now + STAGING_TTL_MS,
      };
      const written = await writeStageMarker(
        env,
        uploadId,
        committing,
        loaded.object.etag
      );
      if (written) {
        loaded = { marker: committing, object: written };
        break;
      }

      const reloaded = await loadStageMarker(env, uploadId);
      if (!reloaded || reloaded.marker.owner !== owner) {
        return stageNotFound();
      }
      loaded = reloaded;
      if (loaded.marker.state !== "uploading") break;
    }
  }

  if (loaded.marker.state === "started") {
    return json({ jobId: uploadId }, 202);
  }
  if (loaded.marker.state !== "committing") {
    return json(
      { error: "staging marker changed; retry start" } satisfies ErrorResponse,
      409
    );
  }

  const pdfs = loaded.marker.manifest.map((item) => ({
    index: item.index,
    filename: item.filename,
  }));
  const startRes = await startJobCoordinator(
    env,
    uploadId,
    owner,
    loaded.marker.config,
    pdfs
  );
  if (!startRes.ok) {
    return json(
      { error: "failed to start job coordinator" } satisfies ErrorResponse,
      502
    );
  }

  await persistStartedStage(
    env,
    uploadId,
    owner,
    loaded.marker
  );
  return json({ jobId: uploadId }, 202);
}

/** Dispatch all staging routes before the generic /api/jobs/:id handler. */
async function handleStageRoute(
  env: Env,
  request: Request,
  pathname: string
): Promise<Response> {
  if (pathname === "/api/jobs/stage") {
    if (request.method !== "POST") {
      return json(
        { error: "method not allowed; use POST" } satisfies ErrorResponse,
        405
      );
    }
    return handleCreateStage(env, request);
  }

  const fileMatch = pathname.match(
    /^\/api\/jobs\/stage\/([^/]+)\/files\/([^/]+)$/
  );
  if (fileMatch) {
    if (request.method !== "PUT") {
      return json(
        { error: "method not allowed; use PUT" } satisfies ErrorResponse,
        405
      );
    }
    return handlePutStageFile(env, request, fileMatch[1], fileMatch[2]);
  }

  const startMatch = pathname.match(
    /^\/api\/jobs\/stage\/([^/]+)\/start$/
  );
  if (startMatch) {
    if (request.method !== "POST") {
      return json(
        { error: "method not allowed; use POST" } satisfies ErrorResponse,
        405
      );
    }
    return handleStartStage(env, request, startMatch[1]);
  }

  return stageNotFound();
}

/**
 * POST /api/jobs — accept a multipart batch (1..MAX_PDFS_PER_JOB files +
 * brands + runs + explain + consensus), stage each PDF in R2
 * (pdfs/<jobId>/<i>.pdf), tell the JobCoordinator DO to start, and return 202
 * {jobId}. Caps enforced: per-file size, file count, total body size, and the
 * per-PDF LLM budget.
 */
async function handleCreateJob(
  env: Env,
  request: Request,
  streamLimit?: StreamLimitState
): Promise<Response> {
  // Rate limit (per client IP) BEFORE doing any work.
  const limited = await enforceRateLimit(env, request);
  if (limited) return limited;

  // Resolve the tenant identity BEFORE staging any PDFs. With opt-in Access-JWT
  // verification configured, an unverified caller is rejected here (401) so we
  // never write R2 objects for a request that has no valid identity.
  const ownerRes = await resolveOwner(env, request);
  if ("unauthorized" in ownerRes) {
    return json(
      { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
      401
    );
  }
  const owner = ownerRes.owner;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    if (streamLimit?.exceeded) {
      return legacyJobTooLarge(streamLimit.bytes, streamLimit.limit);
    }
    return json({ error: "expected multipart/form-data body" } satisfies ErrorResponse, 400);
  }

  // Collect uploaded files (field "file", possibly repeated). NOTE: workers-types
  // mis-types FormData.getAll() as string[] (workerd#3178) even though the runtime
  // returns File objects (formdata_parser_supports_files, on by default). Cast to
  // the real (File | string)[] so the instanceof narrowing typechecks.
  const files = (form.getAll("file") as (File | string)[]).filter(
    (f): f is File => f instanceof File && f.size > 0
  );
  if (files.length === 0) {
    return json({ error: "no PDFs uploaded under field 'file'" } satisfies ErrorResponse, 400);
  }

  const maxPdfs = Number(env.MAX_PDFS_PER_JOB ?? "25") || 25;
  if (files.length > maxPdfs) {
    return json(
      { error: `too many PDFs (${files.length} > ${maxPdfs} per job)` } satisfies ErrorResponse,
      400
    );
  }

  // Validate brands + parse runs/explain, then enforce the per-PDF LLM budget.
  const { csv: brands, error: brandErr } = parseBrandsCsv(
    typeof form.get("brands") === "string" ? (form.get("brands") as string) : "",
    BRAND_SET
  );
  if (brandErr) {
    return json({ error: brandErr } satisfies ErrorResponse, 400);
  }
  const runs = clampRuns(form.get("runs"));
  const explain = parseExplain(form.get("explain"));
  // W3-ext consensus opt-in (off by default). parseExplain honours the same
  // truthy strings as the container's _parse_consensus, so the Worker and the
  // container always agree on whether the flag is on.
  const consensus = parseExplain(form.get("consensus"));

  const brandCount = brands.split(",").length;
  // Mirror container/app.py's _llm_call_count: consensus adds one extraction per
  // validator per run, but ONLY when the secondary provider is actually wired up
  // (numValidators mirrors llm.secondary_enabled(); else it silently no-ops).
  const validators = consensus ? numValidators(env) : 0;
  const callsPerPdf = brandCount * (2 * runs + (explain ? 1 : 0) + validators * runs);
  const budget = maxLlmCalls(env);
  if (callsPerPdf > budget) {
    return json(
      {
        error: `too many LLM calls per PDF (${callsPerPdf} > ${budget}); reduce brands or runs`,
      } satisfies ErrorResponse,
      400
    );
  }

  // Per-file size guard + PDF magic-byte check; stage each PDF in R2.
  const jobId = crypto.randomUUID();
  const pdfs: { index: number; filename: string }[] = [];
  // Sequential, not Promise.all: each iteration's `bytes` is loop-scoped and
  // eligible for GC before the next file is read, so only one ~20MB buffer is
  // live at a time — keeping us clear of the 128MB isolate limit on big batches.
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return json(
        {
          error: `PDF '${file.name}' too large (${bytes.byteLength} > ${MAX_UPLOAD_BYTES} bytes)`,
        } satisfies ErrorResponse,
        413
      );
    }
    const head = new Uint8Array(bytes.slice(0, 5));
    const isPdf =
      head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 &&
      head[3] === 0x46 && head[4] === 0x2d; // "%PDF-"
    if (!isPdf) {
      return json(
        { error: `file '${file.name}' is not a PDF` } satisfies ErrorResponse,
        415
      );
    }
    await env.RESULT_BUCKET.put(`pdfs/${jobId}/${i}.pdf`, bytes, {
      httpMetadata: { contentType: "application/pdf" },
    });
    pdfs.push({ index: i, filename: file.name || `upload-${i}.pdf` });
  }

  // Tell the JobCoordinator DO to start. idFromName(jobId) gives this job its
  // own DO; the DO processes in the background and returns immediately. We pass
  // the OWNER (the verified/derived identity, or "anonymous") so the DO can
  // persist each per-brand result to the owner's library on finalize (server-
  // side, so batch results survive a client disconnect). `owner` was resolved up
  // front (and the request 401'd already if Access-JWT mode rejected it).
  const startRes = await startJobCoordinator(
    env,
    jobId,
    owner,
    { brands, runs, explain, consensus },
    pdfs
  );
  if (!startRes.ok) {
    return json(
      { error: "failed to start job coordinator" } satisfies ErrorResponse,
      502
    );
  }

  return json({ jobId }, 202);
}

/** GET /api/jobs/:id — forward to the DO's /state (poll). */
async function handleGetJob(env: Env, jobId: string): Promise<Response> {
  const id = env.JOB_COORDINATOR.idFromName(jobId);
  const stub = env.JOB_COORDINATOR.get(id);
  const res = await stub.fetch("https://jc/state");
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applySecurityHeaders(headers);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * GET /api/jobs/:id/stream?lastSeq=N — forward the WebSocket upgrade to the DO.
 * The DO accepts via the hibernation API, replays events with seq_num > N, then
 * streams live. We hand the upgrade through unchanged so the 101 + webSocket
 * propagate back to the client.
 */
async function handleJobStream(
  env: Env,
  jobId: string,
  url: URL,
  request: Request
): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected a WebSocket upgrade" } satisfies ErrorResponse, 426);
  }
  const lastSeq = url.searchParams.get("lastSeq") ?? "0";
  const id = env.JOB_COORDINATOR.idFromName(jobId);
  const stub = env.JOB_COORDINATOR.get(id);
  // Re-point the original request (preserving the Upgrade: websocket header) at
  // the DO's /stream path — same technique as proxyToContainer. The 101
  // Switching Protocols + webSocket pass straight back to the client.
  const doUrl = `https://jc/stream?lastSeq=${encodeURIComponent(lastSeq)}`;
  const proxied = new Request(doUrl, request);
  return stub.fetch(proxied);
}

/**
 * GET /api/results?jobId=.. — stream the finished results JSON from R2
 * (results/<jobId>.json); 404 if the job has not finished (or was reaped).
 */
async function handleGetResults(env: Env, url: URL): Promise<Response> {
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return json({ error: "missing 'jobId' query param" } satisfies ErrorResponse, 400);
  }
  const obj = await env.RESULT_BUCKET.get(`results/${jobId}.json`);
  if (!obj) {
    return json({ error: "results not found (job unfinished or expired)" } satisfies ErrorResponse, 404);
  }
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applySecurityHeaders(headers);
  return new Response(obj.body, { status: 200, headers });
}

// ─── W5: saved cohorts (/api/cohorts[...]) ───────────────────────────────────
//
// All routes are OWNER-scoped (the cf-access identity) and ADDITIVE — they reuse
// the SAME LIBRARY D1 + RESULT_BUCKET R2 (more tables, persistent cohort PDFs).
// Cohort PDFs live under R2 cohorts/<id>/*; running a cohort stages those PDFs
// into a NEW batch job via the existing JobCoordinator path. POSTs are rate-
// limited; every response carries the security headers via the shared `json`.

/**
 * Dispatch /api/cohorts and /api/cohorts/:id[/run|/runs|/compare]. Returns a
 * ready Response (handlers already use the security-header `json`). The owner is
 * resolved once (opt-in Access-JWT verification, else header trust) and threaded
 * into every handler so all D1 reads/writes stay tenant-scoped; an unverified
 * caller (JWT mode on) is rejected with 401 before any handler runs.
 */
async function handleCohortRoutes(
  env: Env,
  request: Request,
  url: URL,
  pathname: string
): Promise<Response> {
  const ownerRes = await resolveOwner(env, request);
  if ("unauthorized" in ownerRes) {
    return json(
      { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
      401
    );
  }
  const owner = ownerRes.owner;
  const method = request.method;

  // Collection root: /api/cohorts
  if (pathname === "/api/cohorts") {
    if (method === "POST") {
      // Rate-limit the create (it copies PDFs in R2) on the same per-IP budget.
      const limited = await enforceRateLimit(env, request);
      if (limited) return limited;
      return handleCohortCreate(env, request, owner, json);
    }
    if (method === "GET" || method === "HEAD") {
      return handleCohortList(env, owner, json);
    }
    return json(
      { error: "method not allowed; use GET or POST" } satisfies ErrorResponse,
      405
    );
  }

  // Item routes: /api/cohorts/:id[/run|/runs|/compare]
  const rest = pathname.slice("/api/cohorts/".length);
  if (!rest) {
    return json({ error: "missing cohort id" } satisfies ErrorResponse, 400);
  }

  // /api/cohorts/:id/run
  if (rest.endsWith("/run")) {
    const cohortId = decodeURIComponent(rest.slice(0, -"/run".length));
    if (!cohortId) {
      return json({ error: "missing cohort id" } satisfies ErrorResponse, 400);
    }
    if (method !== "POST") {
      return json(
        { error: "method not allowed; use POST" } satisfies ErrorResponse,
        405
      );
    }
    // A run stages PDFs into a new job (container work) — rate-limit it.
    const limited = await enforceRateLimit(env, request);
    if (limited) return limited;
    return handleCohortRun(env, owner, cohortId, json);
  }

  // /api/cohorts/:id/runs
  if (rest.endsWith("/runs")) {
    const cohortId = decodeURIComponent(rest.slice(0, -"/runs".length));
    if (!cohortId) {
      return json({ error: "missing cohort id" } satisfies ErrorResponse, 400);
    }
    if (method !== "GET" && method !== "HEAD") {
      return json(
        { error: "method not allowed; use GET" } satisfies ErrorResponse,
        405
      );
    }
    return handleCohortRuns(env, owner, cohortId, json);
  }

  // /api/cohorts/:id/compare?a=&b=
  if (rest.endsWith("/compare")) {
    const cohortId = decodeURIComponent(rest.slice(0, -"/compare".length));
    if (!cohortId) {
      return json({ error: "missing cohort id" } satisfies ErrorResponse, 400);
    }
    if (method !== "GET" && method !== "HEAD") {
      return json(
        { error: "method not allowed; use GET" } satisfies ErrorResponse,
        405
      );
    }
    return handleCohortCompare(env, owner, cohortId, url, json);
  }

  // /api/cohorts/:id  (PATCH update | DELETE)
  const cohortId = decodeURIComponent(rest);
  if (method === "PATCH") {
    const limited = await enforceRateLimit(env, request);
    if (limited) return limited;
    return handleCohortPatch(env, request, owner, cohortId, json);
  }
  if (method === "DELETE") {
    const limited = await enforceRateLimit(env, request);
    if (limited) return limited;
    return handleCohortDelete(env, owner, cohortId, json);
  }
  return json(
    { error: "method not allowed; use PATCH or DELETE" } satisfies ErrorResponse,
    405
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // --- /api/brands : answer instantly, never wake the container ----------
    if (pathname === "/api/brands") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" } satisfies ErrorResponse, 405);
      }
      return json({ brands: BRANDS } satisfies BrandsResponse);
    }

    // --- /api/health : proxy GET /health, tolerate container errors --------
    // The container's GET /health returns HealthResponse; on success we pass the
    // body straight through (no parse needed). On failure we synthesise the
    // typed HealthDownResponse so /api/health never throws.
    if (pathname === "/api/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" } satisfies ErrorResponse, 405);
      }
      try {
        // Health is cheap + read-only; route it to the fallback pool (no PDF
        // hash here) just to land on a warm instance.
        const res = await proxyToContainer(
          env,
          "/health",
          request,
          instanceNameFor(url)
        );
        // Pass the container's body/status straight through.
        const headers = new Headers({
          "content-type": "application/json; charset=utf-8",
        });
        applySecurityHeaders(headers);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        // Health must never throw — report the container as down.
        const down: HealthDownResponse = {
          ok: false,
          warm: false,
          warm_error: err instanceof Error ? err.message : String(err),
        };
        return json(down);
      }
    }

    // --- /api/analyze : proxy POST /analyze, STREAM NDJSON back ------------
    // OCR-once + multi-brand. The container responds with an NDJSON event
    // stream (application/x-ndjson) that we pass straight through, unbuffered,
    // so the browser sees stage-by-stage progress as it happens.
    if (pathname === "/api/analyze") {
      if (request.method !== "POST") {
        return json(
          { error: "method not allowed; use POST" } satisfies ErrorResponse,
          405
        );
      }

      // Rate limit (per client IP) BEFORE waking the container.
      const limited = await enforceRateLimit(env, request);
      if (limited) return limited;

      // Guard: reject oversized uploads before waking the container.
      const lenHeader = request.headers.get("content-length");
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
          return json(
            {
              error: `payload too large (${len} bytes > ${MAX_UPLOAD_BYTES} byte limit)`,
            } satisfies ErrorResponse,
            413
          );
        }
      }

      try {
        const res = await proxyToContainer(
          env,
          "/analyze",
          request,
          instanceNameFor(url)
        );
        // CRITICAL: stream the body straight through. Do NOT await/buffer it,
        // do NOT JSON.parse it, do NOT override the NDJSON content-type. The
        // AnalyzeEvent union in ./types describes this stream for clients only;
        // the Worker stays a blind passthrough.
        const headers = new Headers({
          "content-type":
            res.headers.get("content-type") ?? "application/x-ndjson",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
        });
        applySecurityHeaders(headers);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json(
          {
            error:
              "extraction service unavailable: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          502
        );
      }
    }

    // --- /api/extract : proxy POST /extract (the real work) ----------------
    if (pathname === "/api/extract") {
      if (request.method !== "POST") {
        return json(
          { error: "method not allowed; use POST" } satisfies ErrorResponse,
          405
        );
      }

      // Rate limit (per client IP) BEFORE waking the container.
      const limited = await enforceRateLimit(env, request);
      if (limited) return limited;

      // Guard: reject oversized uploads before waking the container.
      const lenHeader = request.headers.get("content-length");
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > MAX_UPLOAD_BYTES) {
          return json(
            {
              error: `payload too large (${len} bytes > ${MAX_UPLOAD_BYTES} byte limit)`,
            } satisfies ErrorResponse,
            413
          );
        }
      }

      try {
        const res = await proxyToContainer(
          env,
          "/extract",
          request,
          instanceNameFor(url)
        );
        // Stream the container's JSON response (success or error) back as-is,
        // preserving its status code. The body is an ExtractResult or
        // ErrorResponse; we don't parse it here.
        const headers = new Headers({
          "content-type": "application/json; charset=utf-8",
        });
        applySecurityHeaders(headers);
        return new Response(res.body, { status: res.status, headers });
      } catch (err) {
        return json(
          {
            error:
              "extraction service unavailable: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          502
        );
      }
    }

    // --- Layer 3: staged streaming batch upload routes ---------------------
    // These must be matched before the generic /api/jobs/:id dispatcher.
    if (
      pathname === "/api/jobs/stage" ||
      pathname.startsWith("/api/jobs/stage/")
    ) {
      try {
        return await handleStageRoute(env, request, pathname);
      } catch (err) {
        return json(
          {
            error:
              "staging request failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    // --- Layer 3: /api/jobs (create batch job) -----------------------------
    if (pathname === "/api/jobs") {
      if (request.method !== "POST") {
        return json(
          { error: "method not allowed; use POST" } satisfies ErrorResponse,
          405
        );
      }

      const cap = jobUploadCap(env);
      const lengthHeader = request.headers.get("content-length");
      if (lengthHeader && DECIMAL_BYTES.test(lengthHeader)) {
        if (BigInt(lengthHeader) > BigInt(cap)) {
          return legacyJobTooLarge(lengthHeader, cap);
        }
      }

      const limitedRequest = limitRequestBody(request, cap);
      try {
        return await handleCreateJob(
          env,
          limitedRequest.request,
          limitedRequest.state
        );
      } catch (err) {
        if (limitedRequest.state.exceeded) {
          return legacyJobTooLarge(
            limitedRequest.state.bytes,
            limitedRequest.state.limit
          );
        }
        return json(
          {
            error:
              "job submission failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    // --- Layer 3: /api/jobs/:id and /api/jobs/:id/stream -------------------
    if (pathname.startsWith("/api/jobs/")) {
      const rest = pathname.slice("/api/jobs/".length);
      const streamSuffix = "/stream";
      if (rest.endsWith(streamSuffix)) {
        const jobId = rest.slice(0, -streamSuffix.length);
        if (!jobId) {
          return json({ error: "missing job id" } satisfies ErrorResponse, 400);
        }
        return handleJobStream(env, jobId, url, request);
      }
      // GET /api/jobs/:id (poll job state)
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { error: "method not allowed; use GET" } satisfies ErrorResponse,
          405
        );
      }
      const jobId = rest;
      if (!jobId) {
        return json({ error: "missing job id" } satisfies ErrorResponse, 400);
      }
      return handleGetJob(env, jobId);
    }

    // --- Layer 3: /api/results?jobId=.. (finished results from R2) ---------
    if (pathname === "/api/results") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { error: "method not allowed; use GET" } satisfies ErrorResponse,
          405
        );
      }
      return handleGetResults(env, url);
    }

    // --- Persistent library: /api/library[...] -----------------------------
    // POST /api/library            — save per-brand results (R2 full json + D1 index).
    // GET  /api/library            — owner-scoped browse/search (facets + paging).
    // GET  /api/library/lookup     — response cache: most-recent match -> full json.
    // GET  /api/library/:id        — owner-checked; stream the full json from R2.
    // All are tenant-scoped to the cf-access-authenticated-user-email identity.
    if (pathname === "/api/library") {
      if (request.method === "POST") {
        // Light rate-limit on the write path (same per-IP budget as the heavy
        // endpoints); reads are cheap and stay unmetered.
        const limited = await enforceRateLimit(env, request);
        if (limited) return limited;
        try {
          // ctx lets the save fire its knowledge digests via waitUntil (after
          // the response); the save result is identical without it.
          return await handleLibrarySave(env, request, json, ctx);
        } catch (err) {
          return json(
            {
              error:
                "library save failed: " +
                (err instanceof Error ? err.message : String(err)),
            } satisfies ErrorResponse,
            500
          );
        }
      }
      if (request.method === "GET" || request.method === "HEAD") {
        try {
          return await handleLibraryList(env, request, url, json);
        } catch (err) {
          return json(
            {
              error:
                "library list failed: " +
                (err instanceof Error ? err.message : String(err)),
            } satisfies ErrorResponse,
            500
          );
        }
      }
      return json(
        { error: "method not allowed; use GET or POST" } satisfies ErrorResponse,
        405
      );
    }

    if (pathname.startsWith("/api/library/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { error: "method not allowed; use GET" } satisfies ErrorResponse,
          405
        );
      }
      const rest = pathname.slice("/api/library/".length);
      try {
        if (rest === "lookup") {
          return await handleLibraryLookup(
            env,
            request,
            url,
            json,
            applySecurityHeaders
          );
        }
        const id = decodeURIComponent(rest);
        if (!id) {
          return json({ error: "missing library id" } satisfies ErrorResponse, 400);
        }
        return await handleLibraryGet(
          env,
          request,
          id,
          json,
          applySecurityHeaders
        );
      } catch (err) {
        return json(
          {
            error:
              "library read failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    // --- W5: saved cohorts /api/cohorts[...] -------------------------------
    if (pathname === "/api/cohorts" || pathname.startsWith("/api/cohorts/")) {
      try {
        return await handleCohortRoutes(env, request, url, pathname);
      } catch (err) {
        return json(
          {
            error:
              "cohorts request failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    // --- P0: live web check /api/webcheck[...] ------------------------------
    // POST /api/webcheck          — start an ADVISORY web-check Workflow (one
    //                               brand's extracted params vs live sources).
    // GET  /api/webcheck/status   — poll the Workflow instance status by id.
    // GET  /api/webcheck          — the persisted verdict JSON from R2 (404
    //                               until the workflow's persist step ran).
    // Advisory only — nothing here ever touches analysis results. The status
    // poll is keyed by the unguessable instance id (same posture as the jobId
    // poll); the verdict GET is owner-checked against the stored doc.
    if (pathname === "/api/webcheck/status") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json(
          { error: "method not allowed; use GET" } satisfies ErrorResponse,
          405
        );
      }
      try {
        return await handleWebCheckStatus(env, url, json);
      } catch (err) {
        return json(
          {
            error:
              "web check status failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    if (pathname === "/api/webcheck") {
      if (request.method === "POST") {
        // Rate limit (per client IP) BEFORE creating a Workflow instance — a
        // check spends Browser Rendering fetches plus a DeepSeek call.
        const limited = await enforceRateLimit(env, request);
        if (limited) return limited;
        // Resolve the tenant identity BEFORE starting any work (the verdict
        // doc is scoped to it). 401 only in opt-in Access-JWT mode.
        const ownerRes = await resolveOwner(env, request);
        if ("unauthorized" in ownerRes) {
          return json(
            { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
            401
          );
        }
        try {
          return await handleWebCheckCreate(
            env,
            request,
            ownerRes.owner,
            BRAND_SET,
            json
          );
        } catch (err) {
          return json(
            {
              error:
                "web check submission failed: " +
                (err instanceof Error ? err.message : String(err)),
            } satisfies ErrorResponse,
            500
          );
        }
      }
      if (request.method === "GET" || request.method === "HEAD") {
        const ownerRes = await resolveOwner(env, request);
        if ("unauthorized" in ownerRes) {
          return json(
            { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
            401
          );
        }
        try {
          return await handleWebCheckGet(
            env,
            ownerRes.owner,
            url,
            json,
            applySecurityHeaders
          );
        } catch (err) {
          return json(
            {
              error:
                "web check read failed: " +
                (err instanceof Error ? err.message : String(err)),
            } satisfies ErrorResponse,
            500
          );
        }
      }
      return json(
        { error: "method not allowed; use GET or POST" } satisfies ErrorResponse,
        405
      );
    }

    // --- Ask: advisory Q&A over the caller's knowledge corpus ---------------
    // POST /api/ask                 — question -> AI Search (retrieval +
    //                                 generation + citations), scoped to the
    //                                 caller's own knowledge/<owner>/ digests.
    // POST /api/knowledge/backfill  — (re)write digests for the caller's
    //                                 existing library rows (idempotent).
    // Both are ADVISORY only and rate-limited + owner-resolved HERE (the
    // handlers in src/knowledge.ts receive the resolved owner — same split as
    // the webcheck routes). When the dashboard-created AI Search instance is
    // absent/misnamed, /api/ask degrades to a clean 503 and NOTHING else is
    // affected — digest writes and Ask errors never touch analysis flows.
    if (pathname === "/api/ask") {
      if (request.method !== "POST") {
        return json(
          { error: "method not allowed; use POST" } satisfies ErrorResponse,
          405
        );
      }
      // Rate limit (per client IP) BEFORE the AI Search call (it spends a
      // retrieval + generation round-trip).
      const limited = await enforceRateLimit(env, request);
      if (limited) return limited;
      const ownerRes = await resolveOwner(env, request);
      if ("unauthorized" in ownerRes) {
        return json(
          { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
          401
        );
      }
      try {
        return await handleAsk(env, request, ownerRes.owner, json);
      } catch (err) {
        return json(
          {
            error:
              "ask failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    if (pathname === "/api/knowledge/backfill") {
      if (request.method !== "POST") {
        return json(
          { error: "method not allowed; use POST" } satisfies ErrorResponse,
          405
        );
      }
      // Rate limit: a backfill fans out up to 200 R2 reads + writes.
      const limited = await enforceRateLimit(env, request);
      if (limited) return limited;
      const ownerRes = await resolveOwner(env, request);
      if ("unauthorized" in ownerRes) {
        return json(
          { error: `unauthorized: ${ownerRes.reason}` } satisfies ErrorResponse,
          401
        );
      }
      try {
        return await handleKnowledgeBackfill(env, ownerRes.owner, json);
      } catch (err) {
        return json(
          {
            error:
              "knowledge backfill failed: " +
              (err instanceof Error ? err.message : String(err)),
          } satisfies ErrorResponse,
          500
        );
      }
    }

    // --- Unknown /api/* path -----------------------------------------------
    if (pathname.startsWith("/api/")) {
      return json(
        { error: `unknown endpoint: ${pathname}` } satisfies ErrorResponse,
        404
      );
    }

    // --- Everything else : static assets (the UI) --------------------------
    // not_found_handling=single-page-application means unknown non-/api paths
    // fall back to index.html. Wrap the asset Response to carry the CSP +
    // security headers (the streamed body is reused unbuffered).
    const assetRes = await env.ASSETS.fetch(request);
    return withSecurityHeaders(assetRes);
  },

  /**
   * scheduled() — W5 budget-safe daily cron (triggers.crons in wrangler.jsonc,
   * default "0 6 * * *"). Re-runs ONLY cohorts that opted in (schedule_enabled=1),
   * across ALL owners. With nothing opted in this is an INERT, near-zero-cost
   * daily D1 check: one indexed SELECT over `cohorts` returns no rows and we
   * return immediately — NO container is woken and NO job is created.
   *
   * COST NOTE: every scheduled cohort that DOES run stages its PDFs into a new
   * batch job, so it spends container vCPU-minutes (the same cost as a manual
   * "Run now"). Opting a cohort in therefore incurs a recurring daily compute
   * cost proportional to its PDF count * brands * runs. This is why the toggle
   * is OFF by default and the cron stays inert until an operator opts a cohort in.
   *
   * waitUntil keeps the invocation alive while the (best-effort) re-runs are
   * kicked off; each runCohort just stages + calls the JobCoordinator and returns
   * (the DO does the long work in its own waitUntil). A failure for one cohort is
   * logged and does not stop the others.
   *
   * The same daily cron ALSO prunes the persistent library (#3): it deletes
   * `analyses` rows older than LIBRARY_RETENTION_DAYS (default 30) and their R2
   * results/lib/<id>.json objects, bounded per run so a large backlog drains over
   * several days. The sweep is owner-AGNOSTIC, safe, and idempotent. It runs even
   * when no cohort is opted in (the cohort sweep stays inert in that case).
   *
   * Expired staged-upload markers are swept in parallel. Uploading sessions
   * delete their deterministic PDF keys; committing sessions probe the DO before
   * deciding ownership; started tombstones delete only the marker.
   */
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runScheduledCohorts(env));
    ctx.waitUntil(pruneLibrary(env));
    ctx.waitUntil(sweepAbandonedStages(env));
  },
};

/**
 * Find every opted-in cohort (schedule_enabled=1) across owners and re-run it,
 * reusing the same staging + JobCoordinator path as the manual run route. Inert
 * (no work, no container) when no cohort has opted in. Best-effort per cohort.
 */
async function runScheduledCohorts(env: Env): Promise<void> {
  // Ensure the cohort tables exist (lazy schema) before the SELECT, so a brand
  // new deployment with no cohorts yet doesn't error on a missing table.
  await ensureCohortSchema(env.LIBRARY);

  const res = await env.LIBRARY.prepare(
    `SELECT id, owner FROM cohorts WHERE schedule_enabled = 1`
  ).all<{ id: string; owner: string }>();
  const cohorts = res.results ?? [];
  if (cohorts.length === 0) {
    // Inert: nothing opted in — return without waking a container or staging work.
    return;
  }

  for (const c of cohorts) {
    try {
      const out = await runCohort(env, c.owner, c.id);
      if ("error" in out) {
        console.error(
          `scheduled run for cohort ${c.id} failed: ${out.error} (${out.status})`
        );
      }
    } catch (err) {
      console.error(`scheduled run for cohort ${c.id} threw:`, err);
    }
  }
}

/** Delete all deterministic PDF keys declared by one staging marker. */
async function deleteStagePdfs(
  env: Env,
  uploadId: string,
  manifest: StageManifestEntry[]
): Promise<void> {
  if (manifest.length === 0) return;
  await env.RESULT_BUCKET.delete(
    manifest.map((item) => stagedPdfKey(uploadId, item.index))
  );
}

/**
 * Sweep expired staging markers. An uploading marker still owns its PDFs and
 * deletes them. A started marker is only a retry tombstone. A committing marker
 * probes the DO: 404 means start never committed and the PDFs are abandoned;
 * any non-404 response means the DO may own them, so only the marker is removed.
 */
async function sweepAbandonedStages(env: Env): Promise<void> {
  try {
    let cursor: string | undefined;
    do {
      const page = await env.RESULT_BUCKET.list({
        prefix: STAGING_PREFIX,
        cursor,
        limit: 1000,
      });

      for (const listed of page.objects) {
        try {
          const uploadId = listed.key
            .slice(STAGING_PREFIX.length)
            .replace(/\.json$/, "");
          if (!uploadId || listed.key !== stageMarkerKey(uploadId)) continue;

          const loaded = await loadStageMarker(env, uploadId);
          if (!loaded || loaded.marker.expires > Date.now()) continue;

          if (loaded.marker.state === "started") {
            await env.RESULT_BUCKET.delete(stageMarkerKey(uploadId));
            continue;
          }

          if (loaded.marker.state === "uploading") {
            await deleteStagePdfs(env, uploadId, loaded.marker.manifest);
            await env.RESULT_BUCKET.delete(stageMarkerKey(uploadId));
            continue;
          }

          try {
            const id = env.JOB_COORDINATOR.idFromName(uploadId);
            const stub = env.JOB_COORDINATOR.get(id);
            const state = await stub.fetch("https://jc/state");
            if (state.status === 404) {
              await deleteStagePdfs(env, uploadId, loaded.marker.manifest);
            }
            await env.RESULT_BUCKET.delete(stageMarkerKey(uploadId));
          } catch {
            // Ambiguous committing state stays intact for the next sweep.
          }
        } catch (err) {
          console.error(
            `staging sweep failed for ${listed.key} (ignored):`,
            err
          );
        }
      }

      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.error("staging sweep failed (ignored):", err);
  }
}

/** Default retention window (days) for the persistent library when unset. */
const DEFAULT_LIBRARY_RETENTION_DAYS = 30;

/** Max `analyses` rows (and their R2 objects) deleted per scheduled run. */
const MAX_LIBRARY_PRUNE_PER_RUN = 500;

/**
 * #3 (cost): prune the persistent library so R2 + D1 do not grow unbounded.
 * Deletes `analyses` rows whose created_at is older than the
 * LIBRARY_RETENTION_DAYS cutoff (default 30) and the R2 results/lib/<id>.json
 * object each row points at. BOUNDED to MAX_LIBRARY_PRUNE_PER_RUN deletes per run
 * so one cron tick can never run long; a large backlog simply drains over a few
 * days. Owner-AGNOSTIC (a maintenance sweep, not a tenant operation). Safe +
 * idempotent: R2 delete on a missing key is a no-op, and we delete the R2 objects
 * BEFORE the D1 rows so a crash mid-prune never orphans a row that still has its
 * object — at worst an object is re-deleted next run.
 */
async function pruneLibrary(env: Env): Promise<void> {
  try {
    await ensureLibrarySchema(env.LIBRARY);

    const days = Number(env.LIBRARY_RETENTION_DAYS ?? "");
    const retentionDays =
      Number.isFinite(days) && days > 0
        ? Math.trunc(days)
        : DEFAULT_LIBRARY_RETENTION_DAYS;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    // Find the oldest expired rows (bounded). result_key is the R2 object key.
    const res = await env.LIBRARY.prepare(
      `SELECT id, result_key FROM analyses
         WHERE created_at < ? ORDER BY created_at ASC LIMIT ?`
    )
      .bind(cutoff, MAX_LIBRARY_PRUNE_PER_RUN)
      .all<{ id: string; result_key: string }>();
    const rows = res.results ?? [];
    if (rows.length === 0) return; // nothing expired — inert.

    // Delete the R2 objects first (idempotent), then the D1 index rows.
    const keys = rows.map((r) => r.result_key).filter((k): k is string => !!k);
    if (keys.length > 0) {
      await env.RESULT_BUCKET.delete(keys);
    }
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(", ");
    await env.LIBRARY.prepare(
      `DELETE FROM analyses WHERE id IN (${placeholders})`
    )
      .bind(...ids)
      .run();

    console.log(
      `library prune: deleted ${ids.length} analyses older than ${retentionDays}d`
    );
  } catch (err) {
    // Never let a prune failure surface; the next daily run retries.
    console.error("library prune failed (ignored):", err);
  }
}
