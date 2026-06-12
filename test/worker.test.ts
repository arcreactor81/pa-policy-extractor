import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrandsResponse, ErrorResponse, ExtractResult } from "../src/types";
import { ensureCohortSchema } from "../src/cohorts";
import { pdfOutcomeAfterDone } from "../src/job-coordinator";
import { buildFdaUrl, isSafeUrl, packAroundBrand } from "../src/web-check";
import type { WebCheckDoc } from "../src/web-check";
import {
  buildAnalysisDigest,
  buildWebCheckDigest,
  digestKey,
} from "../src/knowledge";

/**
 * Worker-level tests. These exercise ONLY the paths the Worker resolves itself
 * (without waking the container Durable Object): /api/brands, the per-route HTTP
 * method guards, and the unknown-/api/* 404. The container-backed routes
 * (/api/analyze, /api/extract, /api/health) need the PaContainer DO + a built
 * image, so they are validated by reading + the Python CI gate, not here.
 *
 * We hit the Worker through SELF.fetch so the real routing + bindings apply.
 */

const ALL_BRANDS = [
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
];

describe("/api/brands", () => {
  it("returns the 15 in-scope brands as JSON", async () => {
    const res = await SELF.fetch("https://example.com/api/brands");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as BrandsResponse;
    expect(body.brands).toEqual(ALL_BRANDS);
    expect(body.brands).toHaveLength(15);
  });

  it("rejects non-GET methods with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/brands", {
      method: "POST",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/method not allowed/i);
  });
});

describe("HTTP method guards (no container wake)", () => {
  it("/api/analyze rejects GET with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/analyze", {
      method: "GET",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/use POST/i);
  });

  it("/api/extract rejects GET with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/extract", {
      method: "GET",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/use POST/i);
  });

  it("/api/health rejects POST with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/health", {
      method: "POST",
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/method not allowed/i);
  });
});

describe("oversized upload guard (rejected before container wake)", () => {
  it("/api/analyze returns 413 when content-length exceeds the cap", async () => {
    const res = await SELF.fetch("https://example.com/api/analyze", {
      method: "POST",
      headers: { "content-length": String(21 * 1024 * 1024) },
      body: "x",
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/too large/i);
  });
});

describe("unknown /api/* paths", () => {
  it("returns a 404 JSON error", async () => {
    const res = await SELF.fetch("https://example.com/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/unknown endpoint/i);
  });
});

/**
 * W5 regression: PATCH schedule_enabled must be turnable ON from the SHIPPED
 * client, which sends `schedule_enabled` as a JSON NUMBER (1 / 0). Before the
 * fix, parseExplain only matched `=== true` or string truthiness, so a numeric
 * `1` stored 0 and the daily cron's `WHERE schedule_enabled = 1` SELECT never
 * matched a UI-enabled cohort. These tests seed a cohort directly in the shared
 * LIBRARY D1, PATCH it through the REAL HTTP route, then run the exact cron
 * SELECT and assert the row's visibility flips correctly.
 */
describe("cohort PATCH schedule_enabled (numeric, as the UI sends)", () => {
  const OWNER_HEADER = "cf-access-authenticated-user-email";
  const db = (env as { LIBRARY: D1Database }).LIBRARY;

  // The exact SELECT the scheduled() cron runs to find opted-in cohorts.
  async function cronSelectIds(): Promise<string[]> {
    const res = await db
      .prepare(`SELECT id, owner FROM cohorts WHERE schedule_enabled = 1`)
      .all<{ id: string; owner: string }>();
    return (res.results ?? []).map((r) => r.id);
  }

  // Seed a cohort row directly (schedule_enabled = 0, as CREATE hard-codes it).
  async function seedCohort(owner: string): Promise<string> {
    await ensureCohortSchema(db);
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO cohorts
           (id, owner, name, created_at, brands, runs, explain, webhook_url, schedule_enabled, pdf_count)
         VALUES (?, ?, ?, ?, ?, 1, 0, NULL, 0, 1)`
      )
      .bind(id, owner, "test cohort", Date.now(), "TREMFYA")
      .run();
    return id;
  }

  it("turns scheduling ON via PATCH {schedule_enabled:1} so the cron SELECT matches", async () => {
    const owner = `sched-on-${crypto.randomUUID()}@example.com`;
    const id = await seedCohort(owner);

    // Pre-condition: not opted in, so the cron SELECT does NOT see it.
    expect(await cronSelectIds()).not.toContain(id);

    const res = await SELF.fetch(
      `https://example.com/api/cohorts/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          [OWNER_HEADER]: owner,
        },
        // The shipped UI (public/cohorts.js saveConfig) sends a JSON NUMBER.
        body: JSON.stringify({ schedule_enabled: 1, webhook_url: null }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; id?: string };
    expect(body.ok).toBe(true);

    // Stored as 1 -> the daily cron's SELECT now returns this cohort.
    expect(await cronSelectIds()).toContain(id);
  });

  it("turns scheduling OFF via PATCH {schedule_enabled:0} (no regression)", async () => {
    const owner = `sched-off-${crypto.randomUUID()}@example.com`;
    const id = await seedCohort(owner);

    // First enable it.
    await SELF.fetch(`https://example.com/api/cohorts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", [OWNER_HEADER]: owner },
      body: JSON.stringify({ schedule_enabled: 1 }),
    });
    expect(await cronSelectIds()).toContain(id);

    // Numeric 0 must turn it back OFF.
    const res = await SELF.fetch(
      `https://example.com/api/cohorts/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [OWNER_HEADER]: owner },
        body: JSON.stringify({ schedule_enabled: 0 }),
      }
    );
    expect(res.status).toBe(200);
    expect(await cronSelectIds()).not.toContain(id);
  });

  it("does not let a non-owner flip another tenant's schedule (owner-scoped, 404)", async () => {
    const owner = `owner-${crypto.randomUUID()}@example.com`;
    const attacker = `attacker-${crypto.randomUUID()}@example.com`;
    const id = await seedCohort(owner);

    const res = await SELF.fetch(
      `https://example.com/api/cohorts/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json", [OWNER_HEADER]: attacker },
        body: JSON.stringify({ schedule_enabled: 1 }),
      }
    );
    expect(res.status).toBe(404);
    // The attacker's PATCH must NOT have opted the victim's cohort in.
    expect(await cronSelectIds()).not.toContain(id);
  });
});

/**
 * B1 regression: a batch PDF whose stream cleanly reaches `done` but whose
 * brands ALL errored produced zero `result` events. The DO must record it as
 * FAILED ("all brands failed"), not as an empty "complete". Driving the DO's
 * NDJSON consumer needs a live container, so the decision is factored into the
 * exported pure helper pdfOutcomeAfterDone — unit-tested here against the
 * job_pdfs.results count the DO reads back after `done`.
 */
describe("batch fail-soft: per-PDF outcome after a clean `done` (B1)", () => {
  it("fails a PDF with zero result events (every brand errored)", () => {
    expect(pdfOutcomeAfterDone(0)).toEqual({
      status: "failed",
      error: "all brands failed",
    });
  });

  it("keeps a PDF complete when at least one brand produced a result", () => {
    expect(pdfOutcomeAfterDone(1)).toEqual({ status: "complete" });
    expect(pdfOutcomeAfterDone(15)).toEqual({ status: "complete" });
  });
});

/**
 * B5 regression: a jobId is unguessable but NOT authorization. POST /api/cohorts
 * must verify the caller OWNS the source job (via the owner-scoped `analyses`
 * index rows the DO persists on finalize) before copying its staged PDFs into a
 * cohort; a foreign jobId answers the same 404 as a missing job. These tests
 * seed a finished job's artifacts (R2 results doc + staged PDF + analyses row)
 * and exercise the REAL HTTP route under two identities.
 */
describe("cohort create source-job owner check (B5)", () => {
  const OWNER_HEADER = "cf-access-authenticated-user-email";
  const db = (env as { LIBRARY: D1Database }).LIBRARY;
  const bucket = (env as { RESULT_BUCKET: R2Bucket }).RESULT_BUCKET;

  // Stage a FINISHED batch job for `owner`: the aggregated results doc + one
  // staged PDF in R2, plus the owner-scoped `analyses` index row finalizeJob
  // writes — the row handleCohortCreate's owner check verifies against.
  async function seedFinishedJob(owner: string): Promise<string> {
    await ensureCohortSchema(db); // also ensures the library (`analyses`) schema
    const jobId = crypto.randomUUID();
    await bucket.put(
      `results/${jobId}.json`,
      JSON.stringify({
        jobId,
        config: { brands: "TREMFYA", runs: 1, explain: false },
        pdfs: [
          {
            index: 0,
            filename: "policy.pdf",
            status: "complete",
            results: [],
            errors: [],
          },
        ],
      })
    );
    await bucket.put(
      `pdfs/${jobId}/0.pdf`,
      new TextEncoder().encode("%PDF-1.4 test")
    );
    await db
      .prepare(
        `INSERT INTO analyses
           (id, created_at, owner, kind, job_id, filename, file_sha256, brand, result_key)
         VALUES (?, ?, ?, 'batch', ?, 'policy.pdf', ?, 'TREMFYA', ?)`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        owner,
        jobId,
        "ab".repeat(32),
        `results/lib/${crypto.randomUUID()}`
      )
      .run();
    return jobId;
  }

  it("404s a cohort create whose source job belongs to another owner", async () => {
    const victim = `victim-${crypto.randomUUID()}@example.com`;
    const attacker = `attacker-${crypto.randomUUID()}@example.com`;
    const jobId = await seedFinishedJob(victim);

    const res = await SELF.fetch("https://example.com/api/cohorts", {
      method: "POST",
      headers: { "Content-Type": "application/json", [OWNER_HEADER]: attacker },
      body: JSON.stringify({ name: "stolen", source_job_id: jobId }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/not found/i);
  });

  it("still lets the job's own tenant create a cohort from it", async () => {
    const owner = `owner-${crypto.randomUUID()}@example.com`;
    const jobId = await seedFinishedJob(owner);

    const res = await SELF.fetch("https://example.com/api/cohorts", {
      method: "POST",
      headers: { "Content-Type": "application/json", [OWNER_HEADER]: owner },
      body: JSON.stringify({ name: "mine", source_job_id: jobId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string; pdf_count?: number };
    expect(body.id).toBeTruthy();
    expect(body.pdf_count).toBe(1);
  });
});

/**
 * B4 regression: POST /api/jobs must ACCEPT a `consensus` form field (it is
 * parsed + forwarded to the JobCoordinator, which relays it to the container).
 * The harness has no container/DO mock, so full forwarding isn't asserted here;
 * instead we prove the field validates cleanly: the magic-byte guard (415)
 * fires only AFTER every form field (brands/runs/explain/consensus) has parsed,
 * and BEFORE any R2 staging or DO start — so a 415 (not a 400) shows the
 * consensus field sailed through validation.
 */
describe("POST /api/jobs accepts the consensus form field (B4)", () => {
  function jobForm(consensus?: string): FormData {
    const form = new FormData();
    // Deliberately NOT a real PDF — see the describe note above.
    const file = new File(["not a pdf"], "x.pdf", { type: "application/pdf" });
    form.append("file", file);
    form.append("brands", "TREMFYA");
    form.append("runs", "1");
    form.append("explain", "0");
    if (consensus !== undefined) form.append("consensus", consensus);
    return form;
  }

  it("does not 400 on consensus=1 (validation reaches the per-file guard)", async () => {
    const res = await SELF.fetch("https://example.com/api/jobs", {
      method: "POST",
      body: jobForm("1"),
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/not a PDF/i);
  });

  it("behaves identically with the field absent (back-compat)", async () => {
    const res = await SELF.fetch("https://example.com/api/jobs", {
      method: "POST",
      body: jobForm(),
    });
    expect(res.status).toBe(415);
  });
});

/**
 * P0 (live web check): POST /api/webcheck validation + GET /api/webcheck.
 * Only the Worker-resolved paths are exercised: every 400 asserted here
 * returns BEFORE env.WEB_CHECK_WF is touched, and the GET reads only R2.
 * Actually CREATING a Workflow instance (the POST happy path) is deliberately
 * NOT tested — it needs a live WEB_CHECK_WF workflow binding in the vitest
 * pool plus outbound network for the run itself; the workflow's fetch/compare
 * steps are covered by reading + the helper unit tests below.
 */
describe("POST /api/webcheck validation (no workflow started)", () => {
  const GOOD_SHA = "ab".repeat(32);
  const goodBody = {
    sha: GOOD_SHA,
    brand: "TREMFYA",
    params: { Age: "18 years or older" },
  };

  // Unique caller IP per request: without cf-connecting-ip every test request
  // shares the limiter's "unknown" bucket, and this block alone fires enough
  // POSTs to trip the 15/min window mid-suite (observed in CI as 429-not-400).
  let ipSeq = 0;
  function post(body: unknown): Promise<Response> {
    ipSeq += 1;
    return SELF.fetch("https://example.com/api/webcheck", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": `198.51.100.${ipSeq}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("400s a malformed sha", async () => {
    const res = await post({ ...goodBody, sha: "not-a-sha" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/sha/i);
  });

  it("400s an unknown brand", async () => {
    const res = await post({ ...goodBody, brand: "HUMIRA" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/unknown brand/i);
  });

  it.each([
    "http://localhost/policy",
    "https://127.0.0.1/policy",
    "https://10.1.2.3/policy",
    "https://203.0.113.7/policy", // raw PUBLIC IP — still rejected
  ])("400s the unsafe url %s (SSRF guard)", async (url) => {
    const res = await post({ ...goodBody, url });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/url/i);
  });

  it("400s oversized params (too many entries)", async () => {
    const params: Record<string, string> = {};
    for (let i = 0; i < 21; i++) params[`p${i}`] = "x";
    const res = await post({ ...goodBody, params });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/too many params/i);
  });

  it("400s an oversized param value", async () => {
    const res = await post({ ...goodBody, params: { Age: "x".repeat(2001) } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/too long/i);
  });

  it("400s a missing params object", async () => {
    const res = await post({ sha: GOOD_SHA, brand: "TREMFYA" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/params/i);
  });
});

describe("GET /api/webcheck (persisted verdict)", () => {
  const OWNER_HEADER = "cf-access-authenticated-user-email";
  const bucket = (env as { RESULT_BUCKET: R2Bucket }).RESULT_BUCKET;

  // Same per-request IP isolation as the POST block: keep these GETs out of
  // the limiter's shared "unknown" bucket so suite-order can't 429 them.
  let getIpSeq = 0;
  function wcGet(url: string, headers?: Record<string, string>): Promise<Response> {
    getIpSeq += 1;
    return SELF.fetch(url, {
      headers: { ...(headers ?? {}), "cf-connecting-ip": `198.51.101.${getIpSeq}` },
    });
  }

  it("404s when no verdict has been persisted for (sha, brand)", async () => {
    const res = await wcGet(
      `https://example.com/api/webcheck?sha=${"cd".repeat(32)}&brand=TREMFYA`
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/not found/i);
  });

  it("400s a malformed sha", async () => {
    const res = await wcGet(
      "https://example.com/api/webcheck?sha=zz&brand=TREMFYA"
    );
    expect(res.status).toBe(400);
  });

  it("404s a verdict owned by another tenant (owner-scoped, not 403)", async () => {
    const sha = "ef".repeat(32);
    await bucket.put(
      `webchecks/${sha}/TREMFYA.json`,
      JSON.stringify({
        checked_at: Date.now(),
        sha,
        brand: "TREMFYA",
        owner: "victim@example.com",
        url: null,
        payer: { skipped: true },
        fda: { found: false },
        verdicts: {},
        version: 1,
      })
    );
    const res = await wcGet(
      `https://example.com/api/webcheck?sha=${sha}&brand=TREMFYA`,
      { [OWNER_HEADER]: "attacker@example.com" }
    );
    expect(res.status).toBe(404);
  });

  it("serves the verdict to its owner", async () => {
    const sha = "0a".repeat(32);
    const owner = `wc-owner-${crypto.randomUUID()}@example.com`;
    await bucket.put(
      `webchecks/${sha}/TREMFYA.json`,
      JSON.stringify({
        checked_at: Date.now(),
        sha,
        brand: "TREMFYA",
        owner,
        url: null,
        payer: { skipped: true },
        fda: { found: false },
        verdicts: {},
        version: 1,
      })
    );
    const res = await wcGet(
      `https://example.com/api/webcheck?sha=${sha}&brand=TREMFYA`,
      { [OWNER_HEADER]: owner }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { brand?: string; version?: number };
    expect(body.brand).toBe("TREMFYA");
    expect(body.version).toBe(1);
  });
});

describe("web-check helpers: packAroundBrand", () => {
  // Small caps keep the fixtures readable; production caps are
  // { head: 8000, window: 4000, maxWindows: 6, total: 60000 }.
  const caps = { head: 10, window: 5, maxWindows: 2, total: 60 };

  it("returns text at/under the total cap whole (no packing needed)", () => {
    const text = "short page, brand TREMFYA mentioned";
    expect(packAroundBrand(text, "TREMFYA", caps)).toBe(text);
  });

  it("keeps the head plus a window around a brand mention (case-insensitive)", () => {
    const text = "0123456789" + "x".repeat(30) + "tremfya" + "y".repeat(30);
    const packed = packAroundBrand(text, "TREMFYA", caps);
    expect(packed.startsWith("0123456789")).toBe(true); // head kept
    expect(packed).toContain("\n[...]\n"); // gap marker between segments
    expect(packed).toContain("xxxxxtremfyayyyyy"); // ±window chars around the hit
  });

  it("caps the number of windows and respects the total cap", () => {
    const blob = ("z".repeat(40) + "TREMFYA").repeat(10) + "z".repeat(40);
    const packed = packAroundBrand(blob, "TREMFYA", caps);
    expect(packed.length).toBeLessThanOrEqual(caps.total);
    expect(packed.match(/TREMFYA/g)?.length).toBe(caps.maxWindows);
  });

  it("falls back to head-only when the brand is never mentioned", () => {
    const text = "a".repeat(100);
    expect(packAroundBrand(text, "TREMFYA", caps)).toBe("a".repeat(caps.head));
  });
});

describe("web-check helpers: isSafeUrl (SSRF guard)", () => {
  it.each([
    "https://www.uhcprovider.com/en/policies-protocols.html",
    "http://example.com/policy.pdf",
  ])("accepts the public URL %s", (u) => {
    expect(isSafeUrl(u)).toBe(true);
  });

  it.each([
    "https://localhost/x",
    "https://localhost./x", // trailing-dot variant
    "http://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://203.0.113.7/x", // ANY raw IP literal is rejected
    "https://[::1]/x",
    "https://intranet/x", // single-label internal hostname
    "ftp://example.com/x",
    "https://user:pass@example.com/x",
    "not a url",
  ])("rejects %s", (u) => {
    expect(isSafeUrl(u)).toBe(false);
  });
});

/**
 * Ask (advisory Q&A over the knowledge corpus): POST /api/ask validation +
 * graceful degradation. Every 400 asserted here returns BEFORE the AI binding
 * is touched. The "valid question" case asserts the 503 DEGRADATION path: in
 * the vitest pool the AI Search instance does not exist (it is created in the
 * dashboard over the pa-knowledge bucket), so the binding call fails and the
 * handler must answer the clean setup-hint 503 — never a throw. Each request
 * carries a UNIQUE cf-connecting-ip (the wc tests' ipSeq pattern): without it
 * every request shares the limiter's "unknown" bucket and this block would
 * trip the 15/min window mid-suite.
 */
describe("POST /api/ask (validation + 503 degradation)", () => {
  let ipSeq = 0;
  function post(body: BodyInit | undefined, jsonBody?: unknown): Promise<Response> {
    ipSeq += 1;
    return SELF.fetch("https://example.com/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-connecting-ip": `198.51.102.${ipSeq}`,
      },
      body: jsonBody !== undefined ? JSON.stringify(jsonBody) : body,
    });
  }

  it("rejects non-POST methods with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/ask", {
      headers: { "cf-connecting-ip": "198.51.102.250" },
    });
    expect(res.status).toBe(405);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/use POST/i);
  });

  it("400s a non-JSON body", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/JSON body/i);
  });

  it("400s a missing question", async () => {
    const res = await post(undefined, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/question/i);
  });

  it("400s an empty/whitespace question", async () => {
    const res = await post(undefined, { question: "   " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/question/i);
  });

  it("400s an oversized question (> 1000 chars)", async () => {
    const res = await post(undefined, { question: "x".repeat(1001) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/too long/i);
  });

  it("degrades to 503 with a setup hint when the AI Search instance is absent", async () => {
    const res = await post(undefined, {
      question: "Which payers restrict TREMFYA the most?",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/not configured/i);
    expect(body.error).toMatch(/pa-knowledge/i);
  });
});

/**
 * Knowledge backfill: owner-scoped + idempotent. With a brand-new owner the
 * library has no rows, so the endpoint must answer 200 {written:0, skipped:0}
 * (and apply the lazy schema rather than erroring on a missing table).
 */
describe("POST /api/knowledge/backfill", () => {
  const OWNER_HEADER = "cf-access-authenticated-user-email";
  let ipSeq = 0;
  function post(owner: string): Promise<Response> {
    ipSeq += 1;
    return SELF.fetch("https://example.com/api/knowledge/backfill", {
      method: "POST",
      headers: {
        [OWNER_HEADER]: owner,
        "cf-connecting-ip": `198.51.103.${ipSeq}`,
      },
    });
  }

  it("rejects non-POST methods with 405", async () => {
    const res = await SELF.fetch("https://example.com/api/knowledge/backfill", {
      headers: { "cf-connecting-ip": "198.51.103.250" },
    });
    expect(res.status).toBe(405);
  });

  it("answers 200 {written:0, skipped:0} on an empty library", async () => {
    const owner = `kb-${crypto.randomUUID()}@example.com`;
    const res = await post(owner);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { written?: number; skipped?: number };
    expect(body.written).toBe(0);
    expect(body.skipped).toBe(0);
  });
});

describe("knowledge digest builders", () => {
  const SHA = "ab".repeat(32);

  /** A representative saved analysis doc (spans + confidence + consensus). */
  function sampleResult(): ExtractResult {
    return {
      result: {
        Filename: "policy.pdf",
        Brand: "TREMFYA",
        Age: "18 years or older",
        "Step Therapy Requirements Documented in Policy": "Yes",
        "Number of Steps through Brands": "2",
        "Number of Steps through Generic": "1",
        "Step through-Phototherapy": "No",
        "TB Test required": "Yes",
        "Quantity Limits": "Yes",
        "Specialist Types": "Dermatologist",
        "Initial Authorization Duration(in-months)": "12",
        "Reauthorization Duration(in-months)": "12",
        "Reauthorization Required": "Yes",
        "Reauthorization Requirements Documented in Policy": "Yes",
        "Access Score": 75,
      },
      access_justification:
        "The policy is broader than the FDA label for TREMFYA.",
      meta: {
        source: "reduced",
        full_markdown_chars: 1000,
        reduced_chars: 500,
        reduction_pct: 50,
        timings_ms: { docling_ms: 1, reduce_ms: 1, extract_ms: 1, score_ms: 1 },
        model: "deepseek-v4-pro",
        runs: 3,
      },
      policy_text: "irrelevant for the digest",
      confidence: {
        Age: { value: "18 years or older", agreement: 2 / 3, distinct: ["18 years or older", "18+"] },
      },
      spans: {
        Age: { found: true, quotes: ["Members must be 18 years of age or older."] },
      },
      consensus: {
        Age: { primary: "18 years or older", secondary: "18 years or older", agree: true },
      },
    };
  }

  it("buildAnalysisDigest carries brand/filename/sha/score bucket/evidence", () => {
    const md = buildAnalysisDigest({
      sha: SHA,
      brand: "TREMFYA",
      filename: "policy.pdf",
      savedAt: 1750000000000,
      runs: 3,
      result: sampleResult(),
    });
    expect(md).toContain("# TREMFYA — policy.pdf");
    expect(md).toContain(SHA);
    expect(md).toContain("**75 — Preferred.**");
    expect(md).toContain("broader than the FDA label");
    // Evidence quote (verbatim from spans) + agreement + consensus notes.
    expect(md).toContain("Members must be 18 years of age or older.");
    expect(md).toMatch(/Run agreement: 67%/);
    expect(md).toMatch(/primary and secondary models agree/);
    // Every extracted parameter section is present.
    expect(md).toContain("### Quantity Limits");
    expect(md).toContain("- Value: Dermatologist");
  });

  it("buildAnalysisDigest truncates long quotes and caps the digest size", () => {
    const result = sampleResult();
    result.spans = {
      Age: { found: true, quotes: ["q".repeat(5000), "r".repeat(5000)] },
    };
    result.access_justification = "j".repeat(10_000);
    const md = buildAnalysisDigest({
      sha: SHA,
      brand: "TREMFYA",
      filename: "policy.pdf",
      savedAt: Date.now(),
      runs: 1,
      result,
    });
    // Each quote is clipped (600 chars + marker), never embedded whole.
    expect(md).not.toContain("q".repeat(601));
    expect(md).toContain("q".repeat(600) + " […]");
    expect(md.length).toBeLessThanOrEqual(100_100);
  });

  it("buildWebCheckDigest carries the advisory line, verdicts and FDA findings", () => {
    const doc: WebCheckDoc = {
      checked_at: 1750000000000,
      sha: SHA,
      brand: "TREMFYA",
      owner: "user@example.com",
      url: "https://payer.example.com/policy",
      payer: { markdown: "..." },
      fda: { found: true, matched_field: "brand_name" },
      verdicts: {
        params: {
          Age: {
            web_value: "18 years or older",
            status: "confirmed",
            quote: "Patients must be at least 18 years old.",
          },
        },
        fda_label: {
          found: true,
          age_consistent: "yes",
          indication_quote: "TREMFYA is indicated for adults.",
          notes: "Label agrees with the policy age limit.",
        },
        policy_notes: "The page shows a 2026 policy revision.",
      },
      version: 1,
    };
    const md = buildWebCheckDigest(doc);
    expect(md).toContain("# TREMFYA — live web check (advisory)");
    expect(md).toMatch(/ADVISORY ONLY/);
    expect(md).toContain(SHA);
    expect(md).toContain("https://payer.example.com/policy");
    expect(md).toContain("### Age — confirmed");
    expect(md).toContain("Patients must be at least 18 years old.");
    expect(md).toContain("- Age consistency vs label: yes");
    expect(md).toContain("TREMFYA is indicated for adults.");
    expect(md).toContain("The page shows a 2026 policy revision.");
    expect(md).toContain(new Date(1750000000000).toISOString());
  });

  it("digestKey shapes the tenancy path and percent-encodes the owner", () => {
    expect(digestKey("user@example.com", SHA, "TREMFYA", "analysis")).toBe(
      `knowledge/user%40example.com/${SHA}-TREMFYA.md`
    );
    expect(digestKey("user@example.com", SHA, "TREMFYA", "webcheck")).toBe(
      `knowledge/user%40example.com/${SHA}-TREMFYA-webcheck.md`
    );
    // The owner segment can never escape its folder (no raw "/" survives).
    expect(digestKey("a/b@example.com", SHA, "TREMFYA", "analysis")).toBe(
      `knowledge/a%2Fb%40example.com/${SHA}-TREMFYA.md`
    );
  });
});

describe("web-check helpers: buildFdaUrl", () => {
  it("builds the brand_name query with the brand URL-encoded", () => {
    expect(buildFdaUrl("TREMFYA")).toBe(
      "https://api.fda.gov/drug/label.json?search=openfda.brand_name:%22TREMFYA%22&limit=1"
    );
  });

  it("supports the generic_name fallback field (ACITRETIN)", () => {
    expect(buildFdaUrl("ACITRETIN", "generic_name")).toContain(
      "openfda.generic_name"
    );
  });
});
