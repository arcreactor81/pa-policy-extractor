import {
  SELF,
  createExecutionContext,
  createScheduledController,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { JobCoordinator } from "../src/job-coordinator";
import type { Env } from "../worker-configuration";

const OWNER_HEADER = "cf-access-authenticated-user-email";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LEGACY_JOB_CAP = 100 * 1024 * 1024;
const encoder = new TextEncoder();

const bucket = (
  env as unknown as { RESULT_BUCKET: R2Bucket }
).RESULT_BUCKET;
const coordinatorNamespace = (
  env as unknown as {
    JOB_COORDINATOR: DurableObjectNamespace<JobCoordinator>;
  }
).JOB_COORDINATOR;

interface ManifestEntry {
  index: number;
  filename: string;
  size: number;
}

interface StageCreated {
  uploadId: string;
  jobId: string;
  uploads: { index: number; url: string }[];
  expires_at: number;
}

interface StageError {
  error: string;
  missing?: number[];
}

interface TestStageMarker {
  owner: string;
  config: {
    brands: string;
    runs: number;
    explain: boolean;
    consensus: boolean;
  };
  manifest: ManifestEntry[];
  state: "uploading" | "committing" | "started";
  updated_at: number;
  expires: number;
}

let ipSequence = 0;

function nextIp(): string {
  ipSequence += 1;
  return `198.51.110.${ipSequence}`;
}

function baseConfig(): Record<string, unknown> {
  return {
    brands: "TREMFYA",
    runs: 1,
    explain: false,
    consensus: false,
  };
}

function manifestOf(
  count: number,
  size: number
): ManifestEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    filename: `policy-${index}.pdf`,
    size,
  }));
}

async function postStage(
  manifest: ManifestEntry[],
  options: {
    owner?: string;
    ip?: string;
    config?: Record<string, unknown>;
  } = {}
): Promise<{ response: Response; body: StageCreated | StageError }> {
  const response = await SELF.fetch("https://example.com/api/jobs/stage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [OWNER_HEADER]: options.owner ?? "stage-owner@example.test",
      "cf-connecting-ip": options.ip ?? nextIp(),
    },
    body: JSON.stringify({
      config: options.config ?? baseConfig(),
      manifest,
    }),
  });
  const body = (await response.json()) as StageCreated | StageError;
  return { response, body };
}

async function createStage(
  manifest: ManifestEntry[],
  options: {
    owner?: string;
    ip?: string;
    config?: Record<string, unknown>;
  } = {}
): Promise<StageCreated> {
  const result = await postStage(manifest, options);
  expect(result.response.status).toBe(201);
  expect("uploadId" in result.body).toBe(true);
  return result.body as StageCreated;
}

function streamingRequest(
  url: string,
  chunks: Uint8Array[],
  headers: HeadersInit,
  method = "PUT"
): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method,
    headers,
    body,
    duplex: "half",
  };
  return new Request(url, init);
}

async function putStageFile(
  stage: StageCreated,
  index: number,
  bytes: Uint8Array,
  options: {
    owner?: string;
    ip?: string;
    contentLength?: string | null;
    chunks?: Uint8Array[];
  } = {}
): Promise<Response> {
  const upload = stage.uploads.find((item) => item.index === index);
  if (!upload) throw new Error(`stage has no upload URL for index ${index}`);

  const headers = new Headers({
    "content-type": "application/pdf",
    [OWNER_HEADER]: options.owner ?? "stage-owner@example.test",
    "cf-connecting-ip": options.ip ?? nextIp(),
  });
  if (options.contentLength !== null) {
    headers.set(
      "content-length",
      options.contentLength ?? String(bytes.byteLength)
    );
  }

  return SELF.fetch(
    streamingRequest(
      `https://example.com${upload.url}`,
      options.chunks ?? [bytes],
      headers
    )
  );
}

async function markerKeys(): Promise<string[]> {
  const listed = await bucket.list({ prefix: "staging/" });
  return listed.objects.map((object) => object.key).sort();
}

async function cleanStage(stage: StageCreated): Promise<void> {
  const keys = stage.uploads.map((upload) =>
    `pdfs/${stage.uploadId}/${upload.index}.pdf`
  );
  keys.push(`staging/${stage.uploadId}.json`);
  await bucket.delete(keys);
}

function validPdf(marker = "x"): Uint8Array {
  return encoder.encode(`%PDF-1.7\n${marker}`);
}

describe("staged streaming job uploads", () => {
  it("accepts a 25 x 20 MiB manifest without allocating the PDF bytes", async () => {
    const stage = await createStage(manifestOf(25, MAX_FILE_BYTES));

    expect(stage.jobId).toBe(stage.uploadId);
    expect(stage.uploads).toHaveLength(25);
    expect(stage.uploads.map((upload) => upload.index)).toEqual(
      Array.from({ length: 25 }, (_, index) => index)
    );

    const markerObject = await bucket.get(`staging/${stage.uploadId}.json`);
    expect(markerObject).not.toBeNull();
    const marker = await markerObject!.json<TestStageMarker>();
    expect(marker.manifest).toHaveLength(25);
    expect(
      marker.manifest.reduce((total, item) => total + item.size, 0)
    ).toBe(25 * MAX_FILE_BYTES);
    expect(marker.state).toBe("uploading");

    await cleanStage(stage);
  });

  it("rejects 26 files before creating a marker", async () => {
    const before = await markerKeys();
    const result = await postStage(manifestOf(26, 1));

    expect(result.response.status).toBe(400);
    expect((result.body as StageError).error).toMatch(/too many PDFs/i);
    expect(await markerKeys()).toEqual(before);
  });

  it("rejects a declared total over the 25 x 20 MiB ceiling", async () => {
    const manifest = manifestOf(25, MAX_FILE_BYTES);
    manifest[24] = {
      ...manifest[24],
      size: MAX_FILE_BYTES + 1,
    };

    const before = await markerKeys();
    const result = await postStage(manifest);

    expect(result.response.status).toBe(413);
    expect((result.body as StageError).error).toMatch(/too large|too many bytes/i);
    expect(await markerKeys()).toEqual(before);
  });

  it("enforces the 64 KiB stage metadata bound before parsing", async () => {
    const oversized = JSON.stringify({
      config: baseConfig(),
      manifest: [
        {
          index: 0,
          filename: "x".repeat(70 * 1024),
          size: 10,
        },
      ],
    });
    expect(encoder.encode(oversized).byteLength).toBeGreaterThan(64 * 1024);

    const before = await markerKeys();
    const response = await SELF.fetch(
      "https://example.com/api/jobs/stage",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [OWNER_HEADER]: "metadata-owner@example.test",
          "cf-connecting-ip": nextIp(),
        },
        body: oversized,
      }
    );

    expect(response.status).toBe(413);
    expect(await markerKeys()).toEqual(before);
  });

  it("executes missing, non-decimal, and mismatched length requests", async () => {
    const pdf = validPdf("length-cases");
    const stage = await createStage([
      { index: 0, filename: "length.pdf", size: pdf.byteLength },
    ]);

    const missing = await putStageFile(stage, 0, pdf, {
      contentLength: null,
    });
    expect(missing.status).toBe(411);

    const nonDecimal = await putStageFile(stage, 0, pdf, {
      contentLength: "not-a-number",
    });
    expect(nonDecimal.status).toBe(400);

    const mismatch = await putStageFile(stage, 0, pdf, {
      contentLength: String(pdf.byteLength - 1),
    });
    expect(mismatch.status).toBe(409);

    expect(await bucket.head(`pdfs/${stage.uploadId}/0.pdf`)).toBeNull();
    await cleanStage(stage);
  });

  it("rejects an actual streamed-length mismatch without R2 residue", async () => {
    const pdf = validPdf("short-body");
    const declaredSize = pdf.byteLength + 1;
    const stage = await createStage([
      { index: 0, filename: "short.pdf", size: declaredSize },
    ]);

    const response = await putStageFile(stage, 0, pdf, {
      contentLength: String(declaredSize),
    });

    expect(response.status).toBe(400);
    expect(await bucket.head(`pdfs/${stage.uploadId}/0.pdf`)).toBeNull();
    await cleanStage(stage);
  });

  it("returns 415 for bad PDF magic and leaves no R2 object", async () => {
    const bad = encoder.encode("xxxxx-1.7\nbad");
    const stage = await createStage([
      { index: 0, filename: "bad.pdf", size: bad.byteLength },
    ]);

    const response = await putStageFile(stage, 0, bad);
    expect(response.status).toBe(415);
    expect(await bucket.head(`pdfs/${stage.uploadId}/0.pdf`)).toBeNull();

    await cleanStage(stage);
  });

  it("allows an idempotent re-PUT to overwrite the same index", async () => {
    const first = validPdf("first-version");
    const second = validPdf("other-version");
    expect(second.byteLength).toBe(first.byteLength);

    const stage = await createStage([
      { index: 0, filename: "retry.pdf", size: first.byteLength },
    ]);

    const firstResponse = await putStageFile(stage, 0, first);
    expect(firstResponse.status).toBe(204);

    const secondResponse = await putStageFile(stage, 0, second);
    expect(secondResponse.status).toBe(204);

    const object = await bucket.get(`pdfs/${stage.uploadId}/0.pdf`);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe(new TextDecoder().decode(second));

    await cleanStage(stage);
  });

  it("returns the pinned 409 missing-index shape at start", async () => {
    const pdf = validPdf("missing-index");
    const owner = "missing-owner@example.test";
    const stage = await createStage(
      [
        { index: 0, filename: "present.pdf", size: pdf.byteLength },
        { index: 1, filename: "missing.pdf", size: pdf.byteLength },
      ],
      { owner }
    );

    expect(
      (await putStageFile(stage, 0, pdf, { owner })).status
    ).toBe(204);

    const response = await SELF.fetch(
      `https://example.com/api/jobs/stage/${stage.uploadId}/start`,
      {
        method: "POST",
        headers: { [OWNER_HEADER]: owner },
      }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "not all staged PDFs have been uploaded",
      missing: [1],
    });

    await cleanStage(stage);
  });

  it("commits a complete stage and repeats the started 202 idempotently", async () => {
    const pdf = validPdf("successful-start");
    const owner = "successful-start-owner@example.test";
    const stage = await createStage(
      [{ index: 0, filename: "complete.pdf", size: pdf.byteLength }],
      { owner }
    );

    expect(
      (await putStageFile(stage, 0, pdf, { owner })).status
    ).toBe(204);

    const stub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(stage.jobId)
    );
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs
           (id, status, created_at, total_pdfs, completed_pdfs,
            failed_pdfs, config_json)
         VALUES (?, 'complete', ?, 0, 0, 0, ?)`,
        stage.jobId,
        Date.now(),
        JSON.stringify({
          brands: "TREMFYA",
          runs: 1,
          explain: false,
          pdfs: [],
          owner,
        })
      );
    });

    const startUrl =
      `https://example.com/api/jobs/stage/${stage.uploadId}/start`;
    const first = await SELF.fetch(startUrl, {
      method: "POST",
      headers: { [OWNER_HEADER]: owner },
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ jobId: stage.jobId });

    const markerObject = await bucket.get(
      `staging/${stage.uploadId}.json`
    );
    expect(markerObject).not.toBeNull();
    const marker = await markerObject!.json<TestStageMarker>();
    expect(marker.state).toBe("started");

    const repeated = await SELF.fetch(startUrl, {
      method: "POST",
      headers: { [OWNER_HEADER]: owner },
    });
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual({ jobId: stage.jobId });

    await cleanStage(stage);
  });

  it("makes owner mismatch and unknown upload IDs indistinguishable", async () => {
    const owner = "real-owner@example.test";
    const stage = await createStage(
      [{ index: 0, filename: "owner.pdf", size: 10 }],
      { owner }
    );

    const mismatch = await SELF.fetch(
      `https://example.com/api/jobs/stage/${stage.uploadId}/start`,
      {
        method: "POST",
        headers: { [OWNER_HEADER]: "other-owner@example.test" },
      }
    );
    const unknown = await SELF.fetch(
      `https://example.com/api/jobs/stage/${crypto.randomUUID()}/start`,
      {
        method: "POST",
        headers: { [OWNER_HEADER]: "other-owner@example.test" },
      }
    );

    expect(mismatch.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await mismatch.text()).toBe(await unknown.text());

    await cleanStage(stage);
  });

  it("does not charge the 25 per-file PUTs to the heavy rate limiter", async () => {
    const pdf = validPdf("rate-limit");
    const owner = "rate-owner@example.test";
    const ip = nextIp();
    const stage = await createStage(
      manifestOf(25, pdf.byteLength),
      { owner, ip }
    );

    for (let index = 0; index < 25; index++) {
      const response = await putStageFile(stage, index, pdf, {
        owner,
        ip,
      });
      expect(response.status).toBe(204);
    }

    await cleanStage(stage);
  });
});

describe("legacy multipart compatibility", () => {
  it("continues parsing a chunked multipart request with no Content-Length", async () => {
    const boundary = `chunked-${crypto.randomUUID()}`;
    const multipart = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="brands"\r\n\r\n`,
      `TREMFYA\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="runs"\r\n\r\n`,
      `1\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="explain"\r\n\r\n`,
      `false\r\n`,
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="chunked.pdf"\r\n`,
      `Content-Type: application/pdf\r\n\r\n`,
      `not a pdf\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    const bytes = encoder.encode(multipart);
    const chunks = [
      bytes.slice(0, 31),
      bytes.slice(31, 127),
      bytes.slice(127),
    ];

    const request = streamingRequest(
      "https://example.com/api/jobs",
      chunks,
      {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "cf-connecting-ip": nextIp(),
      },
      "POST"
    );
    expect(request.headers.get("content-length")).toBeNull();

    const response = await SELF.fetch(request);
    expect(response.status).toBe(415);
    const body = (await response.json()) as StageError;
    expect(body.error).toMatch(/not a PDF/i);
  });

  it("keeps the legacy fast-path 413 above the 100 MiB cap", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/jobs",
      {
        method: "POST",
        headers: {
          "content-length": String(LEGACY_JOB_CAP + 1),
          "content-type": "multipart/form-data; boundary=unused",
        },
        body: "x",
      }
    );

    expect(response.status).toBe(413);
    const body = (await response.json()) as StageError;
    expect(body.error).toMatch(/job upload limit/i);
  });
});

describe("scheduled staged-upload cleanup", () => {
  function expiredMarker(
    owner: string,
    state: TestStageMarker["state"],
    filename: string,
    size: number
  ): TestStageMarker {
    const old = Date.now() - 1000;
    return {
      owner,
      config: {
        brands: "TREMFYA",
        runs: 1,
        explain: false,
        consensus: false,
      },
      manifest: [{ index: 0, filename, size }],
      state,
      updated_at: old,
      expires: old,
    };
  }

  async function seedExpiredStage(
    uploadId: string,
    marker: TestStageMarker,
    pdf: Uint8Array
  ): Promise<void> {
    await bucket.put(
      `staging/${uploadId}.json`,
      JSON.stringify(marker),
      { httpMetadata: { contentType: "application/json" } }
    );
    await bucket.put(
      `pdfs/${uploadId}/0.pdf`,
      pdf,
      { httpMetadata: { contentType: "application/pdf" } }
    );
  }

  it("handles uploading, committing, and started ownership correctly", async () => {
    const pdf = validPdf("sweep");

    const uploadingId = crypto.randomUUID();
    await seedExpiredStage(
      uploadingId,
      expiredMarker(
        "uploading@example.test",
        "uploading",
        "uploading.pdf",
        pdf.byteLength
      ),
      pdf
    );

    const committingMissingId = crypto.randomUUID();
    await seedExpiredStage(
      committingMissingId,
      expiredMarker(
        "committing-missing@example.test",
        "committing",
        "committing-missing.pdf",
        pdf.byteLength
      ),
      pdf
    );

    const committingOwnedId = crypto.randomUUID();
    await seedExpiredStage(
      committingOwnedId,
      expiredMarker(
        "committing-owned@example.test",
        "committing",
        "committing-owned.pdf",
        pdf.byteLength
      ),
      pdf
    );
    const ownedStub = coordinatorNamespace.get(
      coordinatorNamespace.idFromName(committingOwnedId)
    );
    await runInDurableObject(ownedStub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO jobs
           (id, status, created_at, total_pdfs, completed_pdfs,
            failed_pdfs, config_json)
         VALUES (?, 'complete', ?, 0, 0, 0, ?)`,
        committingOwnedId,
        Date.now(),
        JSON.stringify({
          brands: "TREMFYA",
          runs: 1,
          explain: false,
          pdfs: [],
          owner: "committing-owned@example.test",
        })
      );
    });

    const startedId = crypto.randomUUID();
    await seedExpiredStage(
      startedId,
      expiredMarker(
        "started@example.test",
        "started",
        "started.pdf",
        pdf.byteLength
      ),
      pdf
    );

    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController(),
      env as unknown as Env,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(await bucket.head(`staging/${uploadingId}.json`)).toBeNull();
    expect(await bucket.head(`pdfs/${uploadingId}/0.pdf`)).toBeNull();

    expect(
      await bucket.head(`staging/${committingMissingId}.json`)
    ).toBeNull();
    expect(
      await bucket.head(`pdfs/${committingMissingId}/0.pdf`)
    ).toBeNull();

    expect(
      await bucket.head(`staging/${committingOwnedId}.json`)
    ).toBeNull();
    expect(
      await bucket.head(`pdfs/${committingOwnedId}/0.pdf`)
    ).not.toBeNull();

    expect(await bucket.head(`staging/${startedId}.json`)).toBeNull();
    expect(await bucket.head(`pdfs/${startedId}/0.pdf`)).not.toBeNull();

    await bucket.delete([
      `pdfs/${committingOwnedId}/0.pdf`,
      `pdfs/${startedId}/0.pdf`,
    ]);
  });
});
