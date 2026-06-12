/**
 * Env — the bindings and variables available to the Worker at runtime.
 *
 * Generated/maintained to match wrangler.jsonc. You can regenerate the
 * Cloudflare-provided types with `npm run cf-typegen` (wrangler types).
 */
export interface Env {
  /**
   * Durable Object namespace backing the PaContainer container. Typed with the
   * concrete class so `getContainer(env.PA_CONTAINER, ...)` from
   * @cloudflare/containers (which requires DurableObjectNamespace<Container>)
   * accepts it. The type-only import avoids a runtime dependency.
   */
  PA_CONTAINER: DurableObjectNamespace<import("./src/index").PaContainer>;

  /** Durable Object namespace backing the per-IP RateLimiter. */
  RATE_LIMITER: DurableObjectNamespace;

  /**
   * Durable Object namespace backing the per-job JobCoordinator (Layer 3). W5
   * reuses this same DO to drive cohort RUNS (the Worker stages a cohort's
   * persistent PDFs into a new job and calls /start with webhook_url/cohort_id/
   * run_id); the DO fires the best-effort webhook + updates the cohort_runs row
   * on finalize. No new binding is required for W5.
   */
  JOB_COORDINATOR: DurableObjectNamespace;

  /** Static assets binding (serves ./public). */
  ASSETS: Fetcher;

  // --- Layer 3 (async/batch jobs) ---------------------------------------------

  /** R2 bucket holding staged PDFs (pdfs/<jobId>/<i>.pdf) + results (results/<jobId>.json). */
  RESULT_BUCKET: R2Bucket;

  // --- Persistent library (D1 index; full results live in RESULT_BUCKET) ------

  /**
   * D1 database backing the queryable persistent library (table `analyses`).
   * The schema is applied LAZILY (CREATE TABLE IF NOT EXISTS) on first use — no
   * local `wrangler d1 migrations` step is needed. The operator only CREATEs the
   * D1 database in the dashboard and pastes its database_id into wrangler.jsonc.
   */
  LIBRARY: D1Database;

  // --- P0: live web check (advisory live-source cross-check) -------------------

  /**
   * Workflow binding driving the ADVISORY "Live Web Check" (class
   * WebCheckWorkflow in src/web-check.ts, re-exported from src/index.ts):
   * payer policy page (Browser Rendering REST via CF_API_TOKEN, which needs
   * the "Browser Rendering: Edit" scope — else that half degrades gracefully)
   * + FDA label (openFDA) → one DeepSeek compare call → verdict persisted to
   * RESULT_BUCKET at webchecks/<sha>/<brand>.json. Every network-bound step
   * gets durable retries. Typed with the params payload so
   * `create({ params })` is checked end-to-end.
   */
  WEB_CHECK_WF: Workflow<import("./src/web-check").WebCheckParams>;

  /** Max PDFs accepted per job (string from wrangler vars; default "25"). */
  MAX_PDFS_PER_JOB: string;

  /** Max PDFs processed concurrently per job (<= container max_instances; default "2"). */
  MAX_CONCURRENT_PDFS: string;

  /** Days before a job's R2 objects + DO storage are deleted (default "7"). */
  RETENTION_DAYS: string;

  /**
   * #4 (deploy): configurable per-PDF LLM-call budget, forwarded to the container
   * (container/app.py reads MAX_LLM_CALLS) AND used by the Worker's up-front job
   * budget check. Default "200" — sized for the worst legal request: 15 brands
   * * (2*3 deep runs + 1 spans + 2 validators * 3 runs) = 195.
   */
  MAX_LLM_CALLS: string;

  /**
   * Confidence-runs default applied when a request omits `runs` (forwarded to
   * the container; core.DEFAULT_CONFIDENCE_RUNS reads CONFIDENCE_RUNS). Default
   * "1" — interactive uploads stay fast; the UI Deep-Confidence toggle and the
   * batch path (Worker clampRuns default 3) send runs explicitly.
   */
  CONFIDENCE_RUNS?: string;

  /**
   * Override-layer tunable: reducer full-document passthrough threshold in
   * markdown chars (container/pipeline/overrides.py). Default "100000".
   */
  REDUCER_PASSTHROUGH_CHARS?: string;

  /**
   * Pipeline tunable: max policy-text chars for the SCORING call and the
   * Workers AI consensus validators (the validated original's scoring-loop
   * 300k cap; 128k-token validator contexts fit this window-packed). Default
   * "300000".
   */
  SCORING_MAX_CHARS?: string;

  /**
   * Pipeline tunable: max policy-text chars for the PRIMARY model's
   * extraction + source-span inputs. Above the scoring cap (small/medium
   * documents reach the model whole) but deliberately below DeepSeek's
   * 1M-token window — maximal-context prefill measured 10+ min/call; over-cap
   * text is brand-aware window packed to the brand-relevant sections. Default
   * "600000".
   */
  PRIMARY_MAX_CHARS?: string;

  // --- Persistent-library retention (#3) --------------------------------------

  /**
   * Days an `analyses` row (and its R2 results/lib/<id>.json) is retained before
   * the daily scheduled() cron prunes it. Bounds unbounded R2 + D1 growth.
   * Default "30".
   */
  LIBRARY_RETENTION_DAYS: string;

  // --- Opt-in Cloudflare Access JWT verification (security fix #2) -------------

  /**
   * Cloudflare Access team domain (bare team name like "acme" or the full
   * "acme.cloudflareaccess.com"). When set TOGETHER WITH ACCESS_AUD, the Worker
   * VERIFIES the `Cf-Access-Jwt-Assertion` header (RS256 against the team certs)
   * and derives tenant identity from it instead of trusting the spoofable
   * `cf-access-authenticated-user-email` header; a missing/invalid assertion is
   * rejected with 401. Leave UNSET to keep today's header-trust behaviour (which
   * then REQUIRES Cloudflare Access enforcement in front of the Worker).
   */
  ACCESS_TEAM_DOMAIN?: string;

  /**
   * The Cloudflare Access Application AUD tag the verified JWT must carry in its
   * `aud` claim. Required (with ACCESS_TEAM_DOMAIN) to enable JWT verification.
   */
  ACCESS_AUD?: string;

  // --- DeepSeek / Cloudflare AI Gateway config (forwarded to the container) ---

  /** SECRET — set via `wrangler secret put DEEPSEEK_API_KEY`. */
  DEEPSEEK_API_KEY: string;

  /** Optional SECRET — only when the AI Gateway is "authenticated". */
  CF_AIG_TOKEN?: string;

  /** Cloudflare account id used in the AI Gateway URL. */
  CF_AIG_ACCOUNT_ID: string;

  /** AI Gateway id/name used in the AI Gateway URL. */
  CF_AIG_GATEWAY_ID: string;

  /** Model name, e.g. "deepseek-v4-pro". */
  DEEPSEEK_MODEL: string;

  /** Reasoning toggle, e.g. "on". */
  DEEPSEEK_THINKING: string;

  /** Reasoning effort, e.g. "high". */
  DEEPSEEK_REASONING_EFFORT: string;

  // --- W3: optional multi-model consensus (secondary Workers AI extractor) ----

  /**
   * Optional SECRET — a Cloudflare account API token scoped to Workers AI
   * (Read+Edit). Forwarded to the container to authenticate the SECONDARY
   * (cross-check) extractor's OpenAI-compatible chat-completions calls. Set via
   * the Cloudflare dashboard (NOT in wrangler vars). When absent, the consensus
   * cross-check silently no-ops — the canonical DeepSeek result still returns.
   *
   * ALSO reused by the WebCheckWorkflow to call the Browser Rendering REST API
   * (/markdown) for the live web check's payer-page fetch — add the
   * "Browser Rendering: Edit" scope to the same token for that; without it
   * (HTTP 403) payer-page fetches degrade gracefully (FDA-label-only check).
   */
  CF_API_TOKEN?: string;

  /**
   * Secondary (cross-check) Workers AI model id — legacy single-validator
   * fallback when VALIDATOR_MODELS is unset. Default "@cf/openai/gpt-oss-20b"
   * (128k context; the old llama-3.3-70b default is only 24k-ctx on Workers AI
   * and hard-errors on large policy documents).
   */
  SECONDARY_MODEL: string;

  /**
   * W3-ext (3-model consensus): a CSV LIST of Workers AI VALIDATOR model ids
   * (@cf/ ids) the container runs alongside the canonical DeepSeek extractor when
   * a request opts into consensus (the shipped UI enables it by default). Each
   * validator reuses CF_API_TOKEN; calls route through the AI Gateway when
   * CF_AIG_ACCOUNT_ID + CF_AIG_GATEWAY_ID are set (spend cap applies). Default:
   * "@cf/openai/gpt-oss-20b,@cf/mistralai/mistral-small-3.1-24b-instruct" —
   * both 128k-context, top-tier JSON reliability (researched 2026-06; gemma-3
   * deprecated, llama-3.3 24k-ctx unfit). Degrades gracefully (fewer/no
   * validators) when CF_API_TOKEN is unset or a validator errors. Both the
   * interactive path and the BATCH path support it (the JobCoordinator forwards
   * the job's `consensus` flag to the container per PDF).
   */
  VALIDATOR_MODELS: string;
}
