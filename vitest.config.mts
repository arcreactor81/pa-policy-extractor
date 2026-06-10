import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * Vitest configuration for the Worker tests.
 *
 * Tests run INSIDE the Workers runtime (workerd) via
 * @cloudflare/vitest-pool-workers, so `import worker from "../src"` exercises the
 * real fetch handler under the real runtime — no mocking the platform.
 *
 * API note: vitest-pool-workers >= 0.13 (vitest 4) replaced the old
 * `defineWorkersConfig` + `test.poolOptions.workers` shape with the
 * `cloudflareTest()` Vite plugin (this is exactly what the package's bundled
 * vitest-v3-to-v4 codemod rewrites configs to).
 *
 * We point the plugin at wrangler.jsonc so bindings/compat date match production.
 * The container-backed Durable Object (PA_CONTAINER) is NOT exercised here: the
 * tests cover only the Worker-resolved JSON paths (/api/brands, method guards,
 * unknown /api/* 404, static fallback) that never wake the container. The
 * NDJSON streaming passthrough is validated by reading + the Python CI gate.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/**/*.{test,spec}.ts"],
  },
});
