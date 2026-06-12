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
      // The "Ask" feature adds an `ai` binding (wrangler.jsonc), and wrangler
      // hard-classifies `ai`/`ai_search` bindings as remote-only (no local
      // simulator — BINDING_LOCAL_SUPPORT in wrangler). With the pool's
      // default remoteBindings:true that forces an AUTHENTICATED remote proxy
      // session at startup, breaking `npm test` on any machine/CI without
      // Cloudflare credentials. false keeps the suite hermetic: miniflare
      // still provides env.AI, and every call on it throws a "remote
      // required" error — which IS the /api/ask 503 degradation path the
      // tests assert. Deployed behaviour is unaffected.
      remoteBindings: false,
    }),
  ],
  test: {
    include: ["test/**/*.{test,spec}.ts"],
  },
});
