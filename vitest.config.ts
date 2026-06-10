import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Vitest configuration for the Worker tests.
 *
 * Tests run INSIDE the Workers runtime (workerd) via
 * @cloudflare/vitest-pool-workers, so `import worker from "../src"` exercises the
 * real fetch handler under the real runtime — no mocking the platform.
 *
 * We point the pool at wrangler.jsonc so bindings/compat date match production.
 * The container-backed Durable Object (PA_CONTAINER) is NOT exercised here: the
 * tests cover only the Worker-resolved JSON paths (/api/brands, method guards,
 * unknown /api/* 404, static fallback) that never wake the container. The
 * NDJSON streaming passthrough is validated by reading + the Python CI gate.
 */
export default defineWorkersConfig({
  test: {
    include: ["test/**/*.{test,spec}.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
