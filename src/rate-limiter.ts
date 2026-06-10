/**
 * rate-limiter.ts — a sliding-window rate limiter Durable Object.
 *
 * One DO instance is addressed per client IP (via `idFromName(ip)`), so each
 * caller's request timestamps live in their own isolate. The limiter keeps an
 * in-memory ring of recent request timestamps and, on every check, drops the
 * ones older than the window before counting what remains.
 *
 * Contract (see SHARED CONTRACTS): ~15 requests / 60s per client IP on the
 * heavy endpoints (/api/analyze, /api/extract). Over the limit -> the caller is
 * told to back off and the Worker answers HTTP 429 + Retry-After.
 *
 * The DO is reached with a tiny internal request: the Worker calls
 * `stub.fetch("https://rl/check")` and reads back a small JSON verdict. Hits are
 * kept in memory for speed and WRITTEN THROUGH to DO storage so an isolate
 * eviction/restart cannot reset a caller's budget mid-window (a cold DO used to
 * start empty = fail-open). An alarm prunes the buffer (memory + storage) so an
 * idle isolate eventually carries no state at all.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../worker-configuration";

/** Sliding window length in milliseconds (60s). */
const WINDOW_MS = 60_000;

/** Max requests allowed per window per IP. */
const MAX_REQUESTS = 15;

/** DO storage key the in-window hit timestamps persist under. */
const HITS_KEY = "hits";

/** The JSON verdict the DO returns to the Worker. */
export interface RateLimitVerdict {
  /** true when the request is within budget. */
  allowed: boolean;
  /** Seconds the caller should wait before retrying (only meaningful when blocked). */
  retry_after: number;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
}

export class RateLimiter extends DurableObject<Env> {
  /** Monotonic-ish timestamps (ms epoch) of requests inside the live window. */
  private hits: number[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Rehydrate the window from storage so an eviction/restart mid-window does
    // not reset a caller's budget. blockConcurrencyWhile ensures no check runs
    // before the load completes (a missing key = a genuinely fresh limiter).
    ctx.blockConcurrencyWhile(async () => {
      this.hits = (await ctx.storage.get<number[]>(HITS_KEY)) ?? [];
    });
  }

  /**
   * Record-and-check a hit. Returns whether it is allowed plus a Retry-After.
   * Prunes timestamps outside the sliding window first.
   */
  private take(now: number): RateLimitVerdict {
    const cutoff = now - WINDOW_MS;
    // Drop everything older than the window.
    if (this.hits.length) {
      this.hits = this.hits.filter((t) => t > cutoff);
    }

    if (this.hits.length >= MAX_REQUESTS) {
      // Blocked: the window frees up when the OLDEST in-window hit ages out.
      const oldest = this.hits[0];
      const retryAfterMs = oldest + WINDOW_MS - now;
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      return { allowed: false, retry_after: retryAfter, remaining: 0 };
    }

    // Allowed: record this hit, writing through to storage so the window
    // survives eviction (output-gating lands the put before the verdict ships).
    this.hits.push(now);
    void this.ctx.storage.put(HITS_KEY, this.hits);
    // Keep an alarm scheduled so the isolate can be trimmed/evicted; the alarm
    // body just clears stale state. Scheduling is idempotent (latest wins).
    void this.ctx.storage.setAlarm(now + WINDOW_MS + 1000);
    return {
      allowed: true,
      retry_after: 0,
      remaining: MAX_REQUESTS - this.hits.length,
    };
  }

  /**
   * Internal RPC over fetch. The Worker hits any path on this stub; we always
   * treat it as a "consume one token" check and answer with the verdict JSON.
   */
  async fetch(_request: Request): Promise<Response> {
    const verdict = this.take(Date.now());
    return new Response(JSON.stringify(verdict), {
      status: verdict.allowed ? 200 : 429,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  /** Alarm fires after the window; prune so an idle isolate holds no state. */
  async alarm(): Promise<void> {
    const cutoff = Date.now() - WINDOW_MS;
    this.hits = this.hits.filter((t) => t > cutoff);
    // Persist the pruned window — and once fully drained, drop the key so an
    // idle limiter holds no storage at all. If hits remain, re-arm to drain.
    if (this.hits.length) {
      await this.ctx.storage.put(HITS_KEY, this.hits);
      void this.ctx.storage.setAlarm(Date.now() + WINDOW_MS + 1000);
    } else {
      await this.ctx.storage.delete(HITS_KEY);
    }
  }
}
