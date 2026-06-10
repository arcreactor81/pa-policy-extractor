import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrandsResponse, ErrorResponse } from "../src/types";
import { ensureCohortSchema } from "../src/cohorts";
import { pdfOutcomeAfterDone } from "../src/job-coordinator";

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
