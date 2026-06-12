/**
 * knowledge.ts — "Ask": advisory Q&A over the project's collected knowledge.
 *
 * Every saved analysis (POST /api/library) and every web-check verdict (the
 * WebCheckWorkflow's persist step) ALSO writes a clean MARKDOWN DIGEST to a
 * dedicated R2 bucket (binding KNOWLEDGE_BUCKET, bucket "pa-knowledge"). A
 * Cloudflare AI Search instance — created by the operator in the dashboard,
 * pointed at that bucket — continuously indexes the digests; POST /api/ask
 * queries it (retrieval + generation + citations) scoped to the caller's own
 * documents. ADVISORY ONLY: nothing here ever modifies an analysis, a library
 * row, or a web-check verdict.
 *
 * TENANCY: digests live at knowledge/<encodeURIComponent(owner)>/<sha>-<brand>[
 * -webcheck].md. AI Search exposes each object's parent path as the `folder`
 * metadata attribute, so scoping retrieval to the caller is ONE comparison
 * filter: { type: "eq", key: "folder", value: "knowledge/<owner>/" }. Digests
 * are written FLAT in that folder (no subfolders), so the exact-folder `eq`
 * match covers the whole tenant corpus. The owner segment is the tenancy
 * boundary — no cross-tenant key ever shares a folder.
 *
 * BINDING API (verified against the installed @cloudflare/workers-types
 * 4.20260611.1 and https://developers.cloudflare.com/ai-search/api/migration/
 * workers-binding/): the legacy `env.AI.autorag("<instance>").aiSearch({...})`
 * binding is deprecated in favour of the standalone `ai_search` bindings but
 * "will continue to work indefinitely". We use it DELIBERATELY: the instance is
 * referenced BY STRING at call time, so the Worker deploys and runs before the
 * dashboard instance exists (an absent/misnamed instance degrades to 503 here
 * — it can never break the analysis/library/webcheck flows), whereas the new
 * `ai_search` config binding references the instance at deploy time. The
 * non-streaming aiSearch response is `AutoRagAiSearchResponse`:
 * `{ response, data: [{ file_id, filename, score, attributes, content:
 * [{type:"text", text}] }], ... }` — `filename` is the R2 object key.
 *
 * EVERY digest write is best-effort (writeDigest never throws): a failed or
 * skipped digest never fails the primary flow that triggered it.
 */

import type { Env } from "../worker-configuration";
import type { ExtractResult, ResultRow } from "./types";
import type { WebCheckDoc } from "./web-check";
// NOTE: library.ts also imports from THIS module (the save-hook digest write).
// The cycle is benign: both edges are referenced only inside function bodies,
// never at module-evaluation time, so ES module init order is unaffected.
import { ensureLibrarySchema } from "./library";

// ── caps (every digest stays well under ~100KB; quotes are the long tail) ────

/** Hard cap on one digest's markdown (chars; R2 write stays ≲100KB). */
const MAX_DIGEST_CHARS = 100_000;

/** Max verbatim evidence quotes surfaced per parameter. */
const MAX_QUOTES_PER_FIELD = 3;

/** Truncation cap per surfaced quote (chars). */
const MAX_QUOTE_CHARS = 600;

/** Truncation cap for the access-score justification (chars). */
const MAX_JUSTIFICATION_CHARS = 2_000;

/** Truncation cap for free-text notes in a web-check digest (chars). */
const MAX_NOTES_CHARS = 2_000;

/** POST /api/ask question length bounds (chars). */
const MAX_QUESTION_CHARS = 1_000;

/** Retrieval depth for one /api/ask call (docs allow 1..50). */
const ASK_MAX_RESULTS = 10;

/** Citation snippet cap (chars) in the /api/ask response. */
const MAX_SNIPPET_CHARS = 400;

/** Backfill row cap per POST /api/knowledge/backfill call. */
const MAX_BACKFILL_ROWS = 200;

/** Fallback AI Search instance name when the AISEARCH_NAME var is unset. */
const DEFAULT_AISEARCH_NAME = "pa-knowledge";

/**
 * Access Score bucket labels/meanings — mirrors the dashboard's SCORE_META
 * (public/app.js) so the indexed corpus and the UI describe a score the same
 * way (better retrieval for questions like "which policies are restricted?").
 */
const SCORE_BUCKETS: Readonly<Record<number, { label: string; meaning: string }>> = {
  0: { label: "Not covered", meaning: "Not covered for plaque psoriasis." },
  25: { label: "Restricted", meaning: "Covered, but with hurdles beyond the FDA label." },
  50: { label: "Parity", meaning: "Coverage at parity with the FDA label." },
  75: { label: "Preferred", meaning: "Preferred / broader than the FDA label." },
  100: { label: "Open access", meaning: "Fully open access — no PA / utilization management." },
};

/**
 * The 12 extracted parameter columns (ResultRow minus the non-clinical
 * Filename/Brand and the scored Access Score) — the digest's section order.
 */
const PARAM_COLUMNS: readonly (keyof ResultRow)[] = [
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
];

// ── small shared helpers ──────────────────────────────────────────────────────

/** A JSON responder matching the Worker's security-header JSON helper. */
type JsonResponder = (body: unknown, status?: number) => Response;

/** Coerce any value to a display string ("" for null/undefined). */
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** Truncate `text` to `max` chars, marking the cut. */
function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + " […]" : text;
}

/** Final defensive cap on a whole digest (keeps every R2 write ≲100KB). */
function capDigest(md: string): string {
  return md.length > MAX_DIGEST_CHARS
    ? md.slice(0, MAX_DIGEST_CHARS) + "\n\n*[digest truncated]*\n"
    : md;
}

// ── digest keys ───────────────────────────────────────────────────────────────

/**
 * The R2 object key for one digest. AI Search folder filters operate on object
 * key prefixes (the `folder` attribute is the object's parent path), so the
 * encoded OWNER segment is the tenancy boundary: every /api/ask call filters on
 * exactly `knowledge/<encodeURIComponent(owner)>/` and digests are written FLAT
 * in that folder so the exact-folder `eq` match covers the whole corpus.
 */
export function digestKey(
  owner: string,
  sha: string,
  brand: string,
  kind: "analysis" | "webcheck"
): string {
  return (
    `knowledge/${encodeURIComponent(owner)}/${sha}-${encodeURIComponent(brand)}` +
    (kind === "webcheck" ? "-webcheck" : "") +
    ".md"
  );
}

// ── digest builders ───────────────────────────────────────────────────────────

/**
 * Markdown digest for one saved (sha, brand) analysis: metadata, the Access
 * Score (bucket label + justification), then a section per extracted parameter
 * with its value plus — when the saved doc carries them — the verbatim evidence
 * quotes (spans), the run-agreement note (confidence) and the model-consensus
 * note. Plain text only; the owner is NOT embedded (the object path carries the
 * tenancy scope) but brand/sha/filename are, for retrieval quality.
 */
export function buildAnalysisDigest(args: {
  sha: string;
  brand: string;
  filename: string;
  savedAt: number;
  runs: number;
  result: ExtractResult;
}): string {
  const row = (args.result?.result ?? {}) as Partial<ResultRow>;
  const brand = args.brand.trim().toUpperCase();
  const filename = args.filename || str(row.Filename) || "unknown.pdf";
  const lines: string[] = [];

  lines.push(`# ${brand} — ${filename}`);
  lines.push("");
  lines.push(
    `Prior-authorization (PA) policy analysis for drug brand ${brand} ` +
      `(Plaque Psoriasis indication), extracted from the payer policy PDF "${filename}".`
  );
  lines.push("");
  lines.push(`- Brand: ${brand}`);
  lines.push(`- Source PDF: ${filename}`);
  lines.push(`- PDF SHA-256: ${args.sha}`);
  lines.push(`- Saved: ${new Date(args.savedAt).toISOString()}`);
  lines.push(`- Extraction runs: ${args.runs}`);
  lines.push("");

  // Access Score + bucket label + justification.
  lines.push("## Access Score");
  lines.push("");
  const rawScore = row["Access Score"];
  const score =
    rawScore == null || str(rawScore).trim() === "" ? null : Number(rawScore);
  if (score !== null && Number.isFinite(score) && SCORE_BUCKETS[score]) {
    const bucket = SCORE_BUCKETS[score];
    lines.push(`**${score} — ${bucket.label}.** ${bucket.meaning}`);
  } else {
    lines.push("Access Score unavailable for this analysis.");
  }
  const justification = str(args.result?.access_justification).trim();
  if (justification) {
    lines.push("");
    lines.push(`Justification: ${clip(justification, MAX_JUSTIFICATION_CHARS)}`);
  }
  lines.push("");

  // One section per extracted parameter, with optional evidence/agreement.
  lines.push("## Extracted parameters");
  const confidence = args.result?.confidence;
  const spans = args.result?.spans;
  // Tolerate BOTH consensus shapes: the current validator-list one
  // ({primary, validators:[{model,value}], agree_count, total, unanimous})
  // and the legacy two-model one ({primary, secondary, agree}) — the saved
  // docs in R2 can carry either, so the entries are probed as unknown.
  const consensus = args.result?.consensus as
    | Record<string, Record<string, unknown>>
    | undefined;

  for (const col of PARAM_COLUMNS) {
    lines.push("");
    lines.push(`### ${col}`);
    const value = str(row[col]).trim();
    lines.push(`- Value: ${value || "(not stated)"}`);

    const fieldSpans = spans?.[col as string];
    if (fieldSpans?.found && Array.isArray(fieldSpans.quotes)) {
      for (const quote of fieldSpans.quotes.slice(0, MAX_QUOTES_PER_FIELD)) {
        const q = str(quote).trim();
        if (q) lines.push(`- Evidence (verbatim policy quote): "${clip(q, MAX_QUOTE_CHARS)}"`);
      }
    }

    const fieldConf = confidence?.[col as string];
    if (fieldConf && typeof fieldConf.agreement === "number") {
      lines.push(
        `- Run agreement: ${Math.round(fieldConf.agreement * 100)}% across ${args.runs} run(s)`
      );
    }

    const fieldCons = consensus?.[col as string];
    if (fieldCons && typeof fieldCons === "object") {
      if (typeof fieldCons.agree_count === "number" && typeof fieldCons.total === "number") {
        lines.push(
          `- Model consensus: ${fieldCons.agree_count}/${fieldCons.total} models agree` +
            (fieldCons.unanimous === true ? " (unanimous)" : "")
        );
      } else if (typeof fieldCons.agree === "boolean") {
        lines.push(
          `- Model cross-check: primary and secondary models ` +
            (fieldCons.agree ? "agree" : `disagree (secondary: ${str(fieldCons.secondary)})`)
        );
      }
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(
    "*Digest generated automatically from the saved analysis for Ask retrieval. " +
      "Advisory only — the canonical result is the saved analysis JSON.*"
  );
  lines.push("");
  return capDigest(lines.join("\n"));
}

/**
 * Markdown digest of one web-check verdict (the ADVISORY live-source
 * cross-check): per-param status/web_value/quote, the FDA label findings, the
 * source URL and the checked date — with an explicit advisory line so the Ask
 * model always frames these as advisory, never as the canonical extraction.
 */
export function buildWebCheckDigest(doc: WebCheckDoc): string {
  const brand = str(doc.brand).trim().toUpperCase();
  const lines: string[] = [];

  lines.push(`# ${brand} — live web check (advisory)`);
  lines.push("");
  lines.push(
    "ADVISORY ONLY: this is a live-source cross-check of a previously saved " +
      `analysis for brand ${brand}; it never modifies the saved analysis.`
  );
  lines.push("");
  lines.push(`- Brand: ${brand}`);
  lines.push(`- Analyzed PDF SHA-256: ${str(doc.sha)}`);
  lines.push(`- Checked: ${new Date(doc.checked_at || Date.now()).toISOString()}`);
  lines.push(`- Payer source URL: ${doc.url ?? "(none — FDA label only)"}`);
  if (doc.payer?.error) lines.push(`- Payer page note: ${clip(str(doc.payer.error), MAX_NOTES_CHARS)}`);
  lines.push("");

  const verdicts = doc.verdicts ?? {};
  if (verdicts.error) {
    lines.push("## Check error");
    lines.push("");
    lines.push(clip(str(verdicts.error), MAX_NOTES_CHARS));
    lines.push("");
  }

  const params = verdicts.params ?? {};
  const paramNames = Object.keys(params);
  if (paramNames.length > 0) {
    lines.push("## Per-parameter verdicts");
    for (const name of paramNames) {
      const v = params[name];
      lines.push("");
      lines.push(`### ${name} — ${str(v?.status) || "not_found"}`);
      const webValue = str(v?.web_value).trim();
      if (webValue) lines.push(`- Live web value: ${clip(webValue, MAX_QUOTE_CHARS)}`);
      const quote = str(v?.quote).trim();
      if (quote) lines.push(`- Quote (verbatim from the live source): "${clip(quote, MAX_QUOTE_CHARS)}"`);
    }
    lines.push("");
  }

  // FDA label findings: the compare verdict when present, else the fetch state.
  lines.push("## FDA label findings");
  lines.push("");
  const fdaVerdict = verdicts.fda_label;
  const fdaFound = fdaVerdict ? fdaVerdict.found : doc.fda?.found === true;
  lines.push(`- FDA label found: ${fdaFound ? "yes" : "no"}`);
  if (doc.fda?.matched_field) lines.push(`- Matched openFDA field: ${str(doc.fda.matched_field)}`);
  if (fdaVerdict?.age_consistent) lines.push(`- Age consistency vs label: ${fdaVerdict.age_consistent}`);
  const indicationQuote = str(fdaVerdict?.indication_quote).trim();
  if (indicationQuote) {
    lines.push(`- Indication quote (verbatim): "${clip(indicationQuote, MAX_QUOTE_CHARS)}"`);
  }
  const fdaNotes = str(fdaVerdict?.notes).trim();
  if (fdaNotes) lines.push(`- Notes: ${clip(fdaNotes, MAX_NOTES_CHARS)}`);
  if (doc.fda?.error) lines.push(`- Fetch note: ${clip(str(doc.fda.error), MAX_NOTES_CHARS)}`);
  lines.push("");

  const policyNotes = str(verdicts.policy_notes).trim();
  if (policyNotes) {
    lines.push("## Policy notes");
    lines.push("");
    lines.push(clip(policyNotes, MAX_NOTES_CHARS));
    lines.push("");
  }

  lines.push("---");
  lines.push("*Advisory web-check digest generated automatically for Ask retrieval.*");
  lines.push("");
  return capDigest(lines.join("\n"));
}

// ── best-effort digest writes ─────────────────────────────────────────────────

/**
 * Write one digest to the knowledge bucket. NEVER throws (digests are
 * best-effort and must never break the primary flow that triggered them):
 * a missing binding or a failed put is logged and reported as `false`.
 */
export async function writeDigest(
  env: { KNOWLEDGE_BUCKET?: R2Bucket },
  key: string,
  markdown: string
): Promise<boolean> {
  try {
    if (!env.KNOWLEDGE_BUCKET) {
      console.error(`knowledge digest skipped (no KNOWLEDGE_BUCKET binding): ${key}`);
      return false;
    }
    await env.KNOWLEDGE_BUCKET.put(key, markdown, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return true;
  } catch (err) {
    console.error(`knowledge digest write failed (ignored): ${key}`, err);
    return false;
  }
}

/**
 * Build + write the analysis digests for one library save (one digest per
 * per-brand ExtractResult). Fully caught: this promise NEVER rejects, so the
 * caller can ctx.waitUntil() it (or await it) without any risk to the save
 * path. Results without a brand are skipped (no meaningful digest identity).
 */
export async function writeAnalysisDigests(
  env: { KNOWLEDGE_BUCKET?: R2Bucket },
  args: {
    owner: string;
    fileSha256: string;
    savedAt: number;
    runs: number;
    results: ExtractResult[];
  }
): Promise<void> {
  for (const result of args.results) {
    try {
      if (!result || typeof result !== "object") continue;
      const brand = str(result.result?.Brand).trim().toUpperCase();
      if (!brand) continue;
      const markdown = buildAnalysisDigest({
        sha: args.fileSha256,
        brand,
        filename: str(result.result?.Filename),
        savedAt: args.savedAt,
        runs: args.runs,
        result,
      });
      await writeDigest(env, digestKey(args.owner, args.fileSha256, brand, "analysis"), markdown);
    } catch (err) {
      // A malformed result must never break the save (or its sibling digests).
      console.error("analysis digest build failed (ignored):", err);
    }
  }
}

// ── Worker route handlers ─────────────────────────────────────────────────────
//
// Same convention as library.ts / web-check.ts: handlers take the raw request +
// env + the Worker's security-header `json` responder and return a ready
// Response. Rate limiting and resolveOwner happen at the call site in index.ts
// (the owner is passed in, already resolved/401-checked).

/** POST /api/ask request body (unknown until validated). */
interface AskBody {
  question?: unknown;
}

/** POST /api/ask response: the generated answer + the cited digest objects. */
export interface AskResponse {
  /** The model's generated answer, or null when nothing was generated. */
  answer: string | null;
  /** Cited knowledge digests (key = the R2 object key in pa-knowledge). */
  citations: { key: string; snippet?: string; score?: number }[];
}

/**
 * POST /api/ask — body {question: 1..1000 chars}. Queries the dashboard-created
 * AI Search instance (name from AISEARCH_NAME, default "pa-knowledge") via the
 * legacy-but-supported `env.AI.autorag(name).aiSearch()` binding, scoped to the
 * caller's own digests with an exact-folder `eq` filter on
 * `knowledge/<encodeURIComponent(owner)>/`. ADVISORY only.
 *
 * Degradation contract: ANY binding/instance failure (instance not created
 * yet, misnamed, binding unavailable) answers 503 with a setup hint — it never
 * throws into the analysis/library/webcheck flows. An EMPTY corpus is not an
 * error: aiSearch still answers 200 (the model's "no relevant documents"
 * response with zero citations), and a missing response maps to {answer:null}.
 */
export async function handleAsk(
  env: Env,
  request: Request,
  owner: string,
  json: JsonResponder
): Promise<Response> {
  let body: AskBody;
  try {
    body = (await request.json()) as AskBody;
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "expected a JSON object body" }, 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return json({ error: "missing 'question' (non-empty string)" }, 400);
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json(
      { error: `question too long (${question.length} > ${MAX_QUESTION_CHARS} chars)` },
      400
    );
  }

  const instance = env.AISEARCH_NAME?.trim() || DEFAULT_AISEARCH_NAME;
  // Tenancy: digests live FLAT under knowledge/<owner>/, so this exact-folder
  // eq filter (the documented ComparisonFilter shape) covers the whole corpus
  // of THIS caller and nothing else.
  const folder = `knowledge/${encodeURIComponent(owner)}/`;

  let result: AutoRagAiSearchResponse;
  try {
    result = await env.AI.autorag(instance).aiSearch({
      query: question,
      rewrite_query: true,
      max_num_results: ASK_MAX_RESULTS,
      filters: { type: "eq", key: "folder", value: folder },
    });
  } catch (err) {
    // Instance not created yet / misnamed / binding unavailable — degrade to a
    // clean 503 with the setup hint. Never let Ask failures surface elsewhere.
    console.error("ask: AI Search call failed:", err);
    return json(
      {
        error:
          "ask is not configured yet (create the AI Search instance over the pa-knowledge bucket)",
      },
      503
    );
  }

  const citations = (Array.isArray(result.data) ? result.data : []).map((d) => {
    const snippet = str(d.content?.[0]?.text).trim();
    return {
      key: str(d.filename),
      ...(snippet ? { snippet: clip(snippet, MAX_SNIPPET_CHARS) } : {}),
      ...(typeof d.score === "number" ? { score: d.score } : {}),
    };
  });
  const answer =
    typeof result.response === "string" && result.response.trim()
      ? result.response
      : null;

  return json({ answer, citations } satisfies AskResponse);
}

/** POST /api/knowledge/backfill response. */
export interface BackfillResponse {
  /** Digests (re)written from the caller's library rows. */
  written: number;
  /** Rows skipped (R2 doc missing/unparseable, no brand, or write failed). */
  skipped: number;
}

/**
 * POST /api/knowledge/backfill — owner-scoped, idempotent (digests are simply
 * overwritten): walk this OWNER's `analyses` D1 rows (newest first, capped at
 * MAX_BACKFILL_ROWS), fetch each full doc from RESULT_BUCKET (lib/<id>.json),
 * and (re)write its knowledge digest. Lets an operator index the pre-existing
 * library after creating the pa-knowledge bucket / AI Search instance.
 *
 * Web-check digests are deliberately NOT backfilled: webchecks/<sha>/<brand>
 * keys carry no owner segment, so listing that prefix would cross tenants —
 * every NEW web check self-digests in its persist step instead.
 */
export async function handleKnowledgeBackfill(
  env: Env,
  owner: string,
  json: JsonResponder
): Promise<Response> {
  await ensureLibrarySchema(env.LIBRARY);

  const res = await env.LIBRARY.prepare(
    `SELECT created_at, filename, file_sha256, brand, runs, result_key
       FROM analyses WHERE owner = ?
       ORDER BY created_at DESC LIMIT ?`
  )
    .bind(owner, MAX_BACKFILL_ROWS)
    .all<{
      created_at: number;
      filename: string;
      file_sha256: string;
      brand: string;
      runs: number;
      result_key: string;
    }>();
  const rows = res.results ?? [];

  let written = 0;
  let skipped = 0;
  // Sequential on purpose: bounded (<=200) and keeps a single result doc in
  // memory at a time (full docs carry policy_text and can be large).
  for (const row of rows) {
    try {
      const brand = (row.brand ?? "").trim().toUpperCase();
      if (!brand || !row.result_key) {
        skipped += 1;
        continue;
      }
      const obj = await env.RESULT_BUCKET.get(row.result_key);
      if (!obj) {
        skipped += 1; // pruned/expired doc — the index row outlived its object
        continue;
      }
      const result = (await obj.json()) as ExtractResult;
      const markdown = buildAnalysisDigest({
        sha: row.file_sha256,
        brand,
        filename: row.filename,
        savedAt: row.created_at,
        runs: row.runs ?? 1,
        result,
      });
      const ok = await writeDigest(
        env,
        digestKey(owner, row.file_sha256, brand, "analysis"),
        markdown
      );
      if (ok) written += 1;
      else skipped += 1;
    } catch (err) {
      // Unparseable doc / transient R2 read failure — skip, never abort.
      console.error("backfill digest failed for one row (skipped):", err);
      skipped += 1;
    }
  }

  return json({ written, skipped } satisfies BackfillResponse);
}
