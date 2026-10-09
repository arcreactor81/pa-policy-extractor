/**
 * util.ts — shared, dependency-free helpers used across the Worker modules
 * (index.ts, library.ts, cohorts.ts, job-coordinator.ts).
 *
 * Hoisted here to remove duplication that had drifted between files:
 *   - SSRF webhook-URL guard (was inline in cohorts.ts; re-used by the DO).
 *   - the runs / explain / brands parsers (were copy-pasted in index.ts +
 *     library.ts + cohorts.ts with subtly different shapes).
 *   - Cloudflare Access JWT verification (RS256) for OPT-IN tenant isolation
 *     (security fix #2): when ACCESS_TEAM_DOMAIN + ACCESS_AUD are configured the
 *     Worker verifies the `Cf-Access-Jwt-Assertion` header instead of trusting
 *     the spoofable `cf-access-authenticated-user-email` header.
 *
 * Nothing here touches a binding or env directly; callers pass what they need.
 */

// ── container offline switch (2026-08-02) ─────────────────────────────────────
//
// The `pa-policy-extractor-pacontainer` container application (version 15)
// was DELETED on 2 August 2026 because it billed wall-clock time in an idle,
// self-rearming Durable Object alarm loop — 180,004 ms of wall time against
// 0 ms of CPU, repeatedly, while serving no traffic. Full root cause, the
// exact deleted configuration, the restore steps and the fix-before-restore
// list live in docs/CONTAINERS-OFFLINE.md.
//
// The `containers` block in wrangler.jsonc is commented out to match, but the
// PaContainer Durable Object CLASS is still bound (the binding, the migration
// tag and the class export all remain). @cloudflare/containers throws
// "Containers have not been enabled for this Durable Object class" from its
// CONSTRUCTOR when `ctx.container` is undefined, so merely CONSTRUCTING the DO
// while the container application is gone surfaces as an opaque runtime
// exception to the browser. Every code path that would reach
// `getContainer(env.PA_CONTAINER, ...)` therefore checks this flag FIRST and
// answers with a human sentence instead.
//
// The switch is a VAR (`CONTAINERS_OFFLINE` in wrangler.jsonc), not a source
// constant, for three reasons: restoring is a config flip plus a redeploy
// rather than a code edit; the container-backed code paths stay reachable to
// the typechecker and to the test suite (which turns the switch off to exercise
// the upload/validation contracts that are independent of the container); and
// an operator can take the container offline again in an emergency without a
// build.
//
// It DEFAULTS TO OFFLINE when the var is absent. That is the fail-safe
// direction: forgetting the var can only leave extraction switched off, never
// silently resurrect a fleet that bills 12 vCPU / 36 GiB to serve nothing.
//
// TO RESTORE: fix the alarm loop, redeploy the container application, uncomment
// the `containers` block in wrangler.jsonc, then set CONTAINERS_OFFLINE to "0".
// All four steps — see docs/CONTAINERS-OFFLINE.md.

/** Strings that explicitly turn the offline switch OFF (i.e. container live). */
const CONTAINERS_ONLINE_VALUES = new Set(["0", "false", "no", "off", "n", "f"]);

/**
 * True while the container application is deleted and every container-backed
 * route must refuse. Reads `env.CONTAINERS_OFFLINE`; absent or unrecognised
 * means OFFLINE (fail safe).
 */
export function containersOffline(env: {
  CONTAINERS_OFFLINE?: string;
}): boolean {
  const raw = env.CONTAINERS_OFFLINE?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !CONTAINERS_ONLINE_VALUES.has(raw);
}

/**
 * The single human sentence every container-backed route answers with while
 * CONTAINERS_OFFLINE is set. Deliberately plain: it says what is unavailable,
 * that it was a decision rather than a fault, and where to read the detail.
 */
export const CONTAINERS_OFFLINE_MESSAGE =
  "PDF extraction is offline — the container has been shut down to stop it " +
  "billing idle wall-clock time. This is a deliberate cost decision, not an " +
  "outage: the saved analyses, library, export and Ask features still work. " +
  "See README (“Status”) and docs/CONTAINERS-OFFLINE.md.";

// ── runs / explain parsers (shared) ───────────────────────────────────────────

/** Truthy string forms accepted for a boolean flag (explain / schedule_enabled). */
const TRUTHY = new Set(["1", "true", "yes", "on", "y", "t"]);

/**
 * Clamp `runs` to the container's 1..5 range, defaulting to 3. This feeds the
 * accuracy-first paths that SEND runs explicitly (batch jobs, library saves,
 * cohort re-runs) — they get majority voting by default. The interactive
 * /api/analyze path does NOT use this default: the UI omits `runs` unless the
 * Deep-Confidence toggle is on, and the container's own CONFIDENCE_RUNS default
 * (1) keeps those uploads fast. Accepts a number, a numeric string, or a
 * FormDataEntryValue/unknown (anything else -> 3).
 */
export function clampRuns(raw: unknown): number {
  const n = Number(
    typeof raw === "number" ? raw : typeof raw === "string" ? raw : NaN
  );
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.trunc(n)));
}

/**
 * Parse an `explain`-style flag into a boolean. `true` and truthy strings are
 * true; a non-zero finite NUMBER is true (the shipped UI sends 1/0 as a JSON
 * number); everything else is false.
 */
export function parseExplain(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw === "number") return Number.isFinite(raw) && raw !== 0;
  if (typeof raw === "string") return TRUTHY.has(raw.trim().toLowerCase());
  return false;
}

/**
 * Validate + normalize the `brands` csv against an allow-set of the 15 brands.
 * Each token is uppercased + trimmed, deduped in first-seen order; 1..15 of them.
 * Returns the cleaned csv or an error string. `brandSet` is the caller's set of
 * valid uppercase brand names.
 */
export function parseBrandsCsv(
  raw: string,
  brandSet: ReadonlySet<string>
): { csv: string; error?: string } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(",")) {
    const b = tok.trim().toUpperCase();
    if (!b) continue;
    if (!brandSet.has(b)) {
      return { csv: "", error: `unknown brand '${b}'` };
    }
    if (!seen.has(b)) {
      seen.add(b);
      out.push(b);
    }
  }
  if (out.length === 0) {
    return {
      csv: "",
      error: "missing 'brands' (comma-separated 1..15 brand names)",
    };
  }
  if (out.length > 15) {
    return { csv: "", error: `too many brands (${out.length}); max 15` };
  }
  return { csv: out.join(",") };
}

// ── SSRF guard for webhook URLs ────────────────────────────────────────────────

/**
 * Validate a user-supplied webhook URL against SSRF. We REQUIRE https and REJECT
 * any host that resolves to a loopback / private / link-local / unique-local
 * address literal, the cloud metadata host (169.254.169.254 / metadata.google.
 * internal), or a bare hostname with no dot (e.g. "localhost", internal service
 * names). We cannot DNS-resolve here, so we block obvious internal HOST forms;
 * the DO re-applies this guard before POSTing. Returns the normalized URL string
 * on success, or an { error } describing why it was rejected.
 */
export function validateWebhookUrl(
  raw: unknown
): { url: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "webhook_url must be a non-empty string" };
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { error: "webhook_url is not a valid URL" };
  }
  // https only — never plaintext, never file:/gopher:/etc.
  if (u.protocol !== "https:") {
    return { error: "webhook_url must use https" };
  }
  // No embedded credentials (user:pass@host can mask the real target).
  if (u.username || u.password) {
    return { error: "webhook_url must not contain credentials" };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Reject explicit cloud-metadata + loopback hostnames.
  const BLOCKED_HOSTS = new Set([
    "localhost",
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
  ]);
  if (BLOCKED_HOSTS.has(host)) {
    return { error: "webhook_url host is not allowed" };
  }
  // A bare single-label hostname (no dot, not an IP) is an internal name.
  if (!host.includes(".") && !host.includes(":") && !isIpLiteral(host)) {
    return { error: "webhook_url host is not allowed" };
  }
  // IPv4 literal: reject private / loopback / link-local / metadata ranges.
  if (isIpv4(host)) {
    if (isPrivateOrLocalIpv4(host)) {
      return { error: "webhook_url host is a private/internal address" };
    }
  }
  // IPv6 literal: reject loopback (::1), link-local (fe80::/10), unique-local
  // (fc00::/7), and IPv4-mapped private addresses.
  if (host.includes(":")) {
    if (isPrivateOrLocalIpv6(host)) {
      return { error: "webhook_url host is a private/internal address" };
    }
  }
  return { url: u.toString() };
}

/** True if `host` looks like any IP literal (v4 or v6). */
function isIpLiteral(host: string): boolean {
  return isIpv4(host) || host.includes(":");
}

/** True for a dotted-quad IPv4 literal. */
function isIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((p) => Number(p) <= 255);
}

/** True if an IPv4 literal is loopback/private/link-local/metadata/etc. */
function isPrivateOrLocalIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number);
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (+metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224+ multicast / reserved
  return false;
}

/** True if an IPv6 literal is loopback/link-local/unique-local/mapped-private. */
function isPrivateOrLocalIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 unique-local
  // Link-local fe80::/10 = first 16-bit group in [0xfe80, 0xfebf]. Parse the
  // leading hextet (everything before the first ":") and mask-check it.
  const firstGroup = h.startsWith("::") ? "0" : h.split(":")[0];
  const lead = parseInt(firstGroup || "0", 16);
  if (Number.isFinite(lead) && lead >= 0xfe80 && lead <= 0xfebf) {
    return true; // fe80::/10 link-local
  }
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isPrivateOrLocalIpv4(mapped[1])) return true;
  return false;
}

// ── Cloudflare Access JWT verification (security fix #2) ──────────────────────
//
// When ACCESS_TEAM_DOMAIN + ACCESS_AUD are configured, tenant identity is taken
// from a VERIFIED `Cf-Access-Jwt-Assertion` (an RS256 JWT minted by Cloudflare
// Access) rather than the spoofable `cf-access-authenticated-user-email` header.
// We verify: RS256 signature against the team's published certs, `aud` contains
// ACCESS_AUD, and `exp`/`nbf` are valid. Public keys are cached in-memory per
// isolate (keyed by team domain) to avoid re-fetching the certs on every request.

/** The `Cf-Access-Jwt-Assertion` request header carrying the Access JWT. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** Outcome of an Access JWT verification attempt. */
export type AccessVerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: string };

/** Cached imported public keys per team-certs URL (kid -> CryptoKey). */
interface CertCacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
const certCache = new Map<string, CertCacheEntry>();

/** Re-fetch the team certs at most this often (ms). Cloudflare rotates keys. */
const CERT_TTL_MS = 60 * 60 * 1000; // 1h

/** Decode a base64url string to a Uint8Array. */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a base64url JWT segment to a parsed JSON object. */
function b64urlToJson(s: string): Record<string, unknown> {
  const bytes = b64urlToBytes(s);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as Record<string, unknown>;
}

/** The Cloudflare Access certs endpoint for a team domain. */
function certsUrl(teamDomain: string): string {
  // Accept either a bare team name ("acme") or a full hostname
  // ("acme.cloudflareaccess.com"); normalize to the full https certs URL.
  const host = teamDomain.includes(".")
    ? teamDomain
    : `${teamDomain}.cloudflareaccess.com`;
  return `https://${host}/cdn-cgi/access/certs`;
}

/** Shape of one JWK in the Access certs document. */
interface AccessJwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

/**
 * Fetch + import the team's signing public keys (RS256), cached per certs URL
 * for CERT_TTL_MS. Returns a kid -> CryptoKey map. On a fetch/parse failure with
 * a populated cache we keep serving the cached keys; with no cache we throw.
 */
async function getSigningKeys(
  teamDomain: string
): Promise<Map<string, CryptoKey>> {
  const url = certsUrl(teamDomain);
  const cached = certCache.get(url);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CERT_TTL_MS) {
    return cached.keys;
  }

  let keys: Map<string, CryptoKey>;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600 } });
    if (!res.ok) {
      throw new Error(`certs fetch failed (HTTP ${res.status})`);
    }
    const doc = (await res.json()) as { keys?: AccessJwk[] };
    const jwks = Array.isArray(doc.keys) ? doc.keys : [];
    keys = new Map<string, CryptoKey>();
    for (const jwk of jwks) {
      if (!jwk.kid || jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.set(jwk.kid, key);
    }
  } catch (err) {
    if (cached) return cached.keys; // serve stale on a transient fetch error.
    throw err;
  }

  certCache.set(url, { keys, fetchedAt: now });
  return keys;
}

/**
 * Verify a Cloudflare Access JWT. Checks the RS256 signature against the team's
 * published certs, that `aud` contains ACCESS_AUD, and that the token is within
 * its `nbf`..`exp` window. On success returns the verified identity email (from
 * the `email` claim, falling back to `sub`). Pure-ish: only network side effect
 * is the (cached) certs fetch.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string
): Promise<AccessVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed assertion (expected 3 segments)" };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlToJson(headerB64);
    payload = b64urlToJson(payloadB64);
  } catch {
    return { ok: false, reason: "assertion header/payload not valid JSON" };
  }

  if (header.alg !== "RS256") {
    return { ok: false, reason: `unsupported alg '${String(header.alg)}'` };
  }
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) {
    return { ok: false, reason: "assertion missing kid" };
  }

  let keys: Map<string, CryptoKey>;
  try {
    keys = await getSigningKeys(teamDomain);
  } catch (err) {
    return {
      ok: false,
      reason:
        "could not load Access signing keys: " +
        (err instanceof Error ? err.message : String(err)),
    };
  }
  const key = keys.get(kid);
  if (!key) {
    return { ok: false, reason: "no Access signing key for kid" };
  }

  // Verify the signature over the `header.payload` ASCII bytes.
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let sigOk: boolean;
  try {
    sigOk = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      b64urlToBytes(sigB64),
      signed
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) {
    return { ok: false, reason: "assertion signature is invalid" };
  }

  // aud check — Access `aud` is a string or array of Application AUD tags.
  const aud = payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(expectedAud)
    : aud === expectedAud;
  if (!audOk) {
    return { ok: false, reason: "assertion aud does not match ACCESS_AUD" };
  }

  // Time window (seconds since epoch). Allow a small clock-skew leeway.
  const nowSec = Math.floor(Date.now() / 1000);
  const skew = 60;
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (!exp || nowSec > exp + skew) {
    return { ok: false, reason: "assertion is expired" };
  }
  const nbf = typeof payload.nbf === "number" ? payload.nbf : 0;
  if (nbf && nowSec + skew < nbf) {
    return { ok: false, reason: "assertion is not yet valid" };
  }

  const email =
    typeof payload.email === "string" && payload.email
      ? payload.email
      : typeof payload.sub === "string"
        ? payload.sub
        : "";
  if (!email) {
    return { ok: false, reason: "assertion has no email/sub identity" };
  }

  return { ok: true, email };
}
