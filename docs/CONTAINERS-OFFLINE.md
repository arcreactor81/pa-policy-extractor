# Containers offline — root cause, restore, and what to fix first

**Status: the Cloudflare Container behind PDF extraction was deleted on 2 August 2026.**
The Worker, the dashboard, D1, R2, Workers AI and the AI Gateway are all still
live. Extraction is not, and it stays off until the bug below is fixed.

This document is the whole story: what was deleted, why, exactly how to put it
back, and — the part that matters — [what to fix before you do](#fix-before-restoring).

---

## 1. Root cause

The container was **billing continuously while serving nothing**.

Over the ~7 days before the shutdown, the Worker received **six** inbound HTTP
requests in total. Every one is accounted for:

| When (UTC) | Request | Note |
|---|---|---|
| 2026-07-27 | `GET /robots.txt` | crawler |
| 2026-07-28 | `GET /robots.txt` | `OAI-SearchBot/1.0`, validated by Cloudflare as a verified search-engine crawler — benign; notable only because it proves the hostname was publicly discoverable |
| 2026-08-01 05:12 | `GET /theme.js`, `/cohorts.js`, `/fonts/dm-sans-400.woff2`, `/fonts/jetbrains-mono-400.woff2` | one browser page load, static assets only |

Not one `/api/*` request. Not one PDF. Meanwhile the same window contains
**~6,290 Durable Object `alarm` events** on the `PaContainer` entrypoint, each
logging:

```
wallTimeMs: 180004     cpuTimeMs: 0
```

Three minutes of billable wall time, doing nothing, over and over.

### The mechanism

`PaContainer` sets `sleepAfter = "3m"` (`src/index.ts`). The
`@cloudflare/containers` alarm handler (v0.3.7,
`dist/lib/container.js`) does this, in order:

1. **Line 1518** — on entry, unconditionally re-arms:
   `await this.ctx.storage.setAlarm(Date.now())`.
2. **Line 1573** — computes how long to stay alive:
   `minTime = Math.min(minTimeFromSchedules, Date.now() + 3min, this.sleepAfterMs)`.
   With no schedules registered, that resolves to the `sleepAfter` deadline.
3. **Lines 1577–1586** — **parks inside a `setTimeout` promise** for that whole
   window, holding the Durable Object open.
4. **Line 1587** — on waking: `await this.ctx.storage.setAlarm(Date.now())`,
   chaining the next alarm immediately.

So each alarm holds the DO open for the full three minutes and then schedules its
own successor. `180004 ms` of wall time at `0 ms` of CPU is precisely that loop
with nothing in it.

There is a second, reinforcing detail. `sleepAfterMs` is an **in-memory
absolute deadline**, not persisted:

```js
// line 770
renewActivityTimeout() {
  const timeoutInMs = parseTimeExpression(this.sleepAfter) * 1000;
  this.sleepAfterMs = Date.now() + timeoutInMs;   // in-memory only
}
```

and the **constructor** calls both `scheduleNextAlarm()` and
`renewActivityTimeout()` inside `blockConcurrencyWhile` (lines 355–360). Every
time the Durable Object is re-instantiated it arms a fresh alarm *and* resets
the idle deadline it is supposed to be counting down to. The alarm chain
re-instantiates the DO. The idle timer restarts itself.

### Why the billing is the way it is

**Durable Object and container billing is wall-clock duration, not CPU.** An
idle container that is merely *held open* bills as though it were working. This
is the assumption the project got wrong: `sleepAfter: "3m"` was documented in the
README as the primary idle-cost control, and it did not put the container to
sleep.

### What would NOT have fixed it

**Lowering `max_instances` would not have fixed this.** It would have divided the
bill by three and left the loop running forever. Worth stating plainly, because
`max_instances` is the knob that *looks* like the cost control.

### What ignited it

Neither of the two obvious "something keeps waking it" theories survives contact
with the evidence:

- **The daily cron (`scheduled()` → `runScheduledCohorts`) — RULED OUT.**
  It selects `WHERE schedule_enabled = 1` and calls `runCohort` → container, so a
  cohort left scheduled *would* do this indefinitely. But the live `cohorts`
  table is **empty** (0 rows, checked against the `pa-library` D1 database on
  2026-08-02), so `runScheduledCohorts` returns at its `cohorts.length === 0`
  guard without waking anything. Confirmed twice: empty table, and an inert code
  path. Logs show 1 cron invocation in the window.
- **A health-check monitor on `/api/health` — RULED OUT.** That route *does*
  proxy to the container and would keep it warm forever, but there is no periodic
  request in the logs: six inbound requests in seven days, none of them `/api/*`.
  The dashboard itself never polls `/api/health` (no such call exists in
  `public/*.js`).

**The honest conclusion is that no recurring trigger is needed.** The loop is
self-sustaining. Once the container has been started for any ordinary reason —
someone analyzing a PDF — the alarm chain keeps re-arming and the container never
goes idle. There is no external cause to remove; the loop *is* the cause. This is
why the fix has to be in the alarm handling and not in "find what is calling it".

---

## 2. Exactly what was deleted

Deleted **2 August 2026** via the Cloudflare API. The account now reports **zero
container applications** (verified).

| Field | Value |
|---|---|
| Container application | `pa-policy-extractor-pacontainer` |
| Application id | `<container-application-id>` |
| Version | 15 |
| Running instances | **3** |
| Instance type | `standard-4` — **4 vCPU / 12 GiB memory / 20 GB disk each**, the maximum size the account permits per deployment |
| Standing capacity | **12 vCPU and 36 GiB** |
| Durable Object class | `PaContainer` (`defaultPort = 8080`, `sleepAfter = "3m"`) |
| Rollout | `rollout_step_percentage: 100` (single step) |

**Nothing was destroyed.** These all survive, which is what makes the shutdown
reversible:

| Resource | Identifier |
|---|---|
| Container image (still in the registry) | `registry.cloudflare.com/<account-id>/pa-policy-extractor-pacontainer:20577153` |
| Durable Object namespace | `<durable-object-namespace-id>` |
| D1 database | `pa-library` — `<database-id>` |
| R2 buckets | `pa-job-results`, `pa-knowledge` |
| Worker + all other bindings | deployed and serving |

### What changed in this repository

| Change | Where | Why |
|---|---|---|
| `containers` block commented out | `wrangler.jsonc` | so a CI deploy cannot silently resurrect a 3 × 4 vCPU fleet |
| `CONTAINERS_OFFLINE: "1"` var added | `wrangler.jsonc` | runtime kill switch; **absent also means offline** (fail safe) |
| `containersOffline(env)` guards | `src/util.ts`, `src/index.ts`, `src/job-coordinator.ts` | every container-backed route returns before the DO is constructed |
| Service notice | `public/index.html`, `public/styles.css` | unmissable, at the top of the page |
| Control lockdown | `public/offline.js` | disables the three container-backed buttons with a tooltip |
| Status block + corrections | `README.md` | including the retraction of the "$5/mo, no overage" claim |

**The DO class, its binding and its `v1` migration tag were deliberately left in
place.** The Worker still typechecks (`npm run typecheck`), still deploys
(`wrangler deploy --dry-run` resolves `env.PA_CONTAINER` with no container
attached), and the 104-test suite passes.

This matters more than it looks. `@cloudflare/containers` throws from its
**constructor** when no container is attached:

```js
// dist/lib/container.js:350
if (ctx.container === undefined) {
  throw new Error('Containers have not been enabled for this Durable Object class. ...');
}
```

So merely *constructing* `PaContainer` with the application gone produces an
opaque runtime exception in the browser. Every guard therefore returns **before**
`getContainer()` is reached. A request to a container-backed route now gets:

```
HTTP/1.1 503 Service Unavailable
retry-after: 86400
x-pa-containers-offline: 1

{"error":"PDF extraction is offline — the container has been shut down to stop
it billing idle wall-clock time. This is a deliberate cost decision, not an
outage: the saved analyses, library, export and Ask features still work.
See README (\"Status\") and docs/CONTAINERS-OFFLINE.md."}
```

`GET /api/health` is the one exception: it keeps its "never throws" contract and
returns `200` with `{ok: false, warm: false, warm_error: "PDF extraction is offline …"}`.

Guarded routes: `/api/analyze`, `/api/extract`, `/api/health`, the whole
`/api/jobs/stage` family, `POST /api/jobs`, `POST /api/cohorts/:id/run`, the
cron's cohort re-runs, and the JobCoordinator's per-PDF container call (for a job
that was already in flight). Untouched: Library, Ask, Export, web checks, cohort
browsing and diffs, `GET /api/brands`, and reading any existing job or result.

---

## 3. Fix before restoring

**This list is the point of the document.** It is ranked by value-for-effort.

> **Read the ranking correctly.** #1 and #2 are first because they cost minutes
> and buy a permanent floor. **#3 is the one that caused the shutdown.** Doing #1
> and #2 without #3 gets you a cheaper version of exactly the same bug.

| # | Item | Status | Effort | Blocker? |
|---|---|---|---|---|
| 1 | AI Gateway hard spend cap | Recommended | minutes | **Blocker** |
| 2 | `max_instances: 3` → `1` | VERIFIED | one line | **Blocker** |
| 3 | The alarm loop | VERIFIED — *the cause* | real work | **Blocker** |
| 4 | `enforceRateLimit` fails open | VERIFIED | ~10 lines | **Blocker** (spending routes) |
| 5 | `workers.dev` exposure | **VERIFIED — deploys re-open it** | one line | **Blocker** |
| 6 | In-app Access verification | VERIFIED gap | ~1 hour | Advisable |

### 1. Set a hard spend cap on the AI Gateway — **blocker**

The project routes its LLM calls through a Cloudflare AI Gateway (the one named
by `CF_AIG_GATEWAY_ID` in `wrangler.jsonc`). Both the DeepSeek primary and the
Workers AI validators go through it, so one gateway budget can govern all LLM
spend. Before restoring, make sure that gateway has a hard spend limit and a rate
limit.

Do it: dashboard → **AI** → **AI Gateway** → *your gateway* → **Settings** →
budget/spend limit, plus a rate limit. This is the backstop that survives every
other mistake in this list, including the ones nobody has found yet.

Note the scope honestly: **this caps LLM spend, not container wall-clock spend.**
Nothing in the AI Gateway would have stopped the alarm loop. Container cost needs
its own watch (item 3's verification step).

### 2. `max_instances: 3` → `1` — **blocker**

**VERIFIED.** `3` is a leftover from batch concurrency tuning: the README ties it
to `MAX_CONCURRENT_PDFS: 2` ("batch concurrency ≤ container max_instances"). For
interactive single-document use — which is what this actually gets — **one
instance is enough**, and one instance is what a demo should stand up.

Again: this bounds *capacity*, not *idle time*. Restoring at `3` triples the cost
of the bug you have not fixed yet.

### 3. Fix the alarm loop — **blocker; nothing else matters without it**

**VERIFIED — this is the cause.** See [§1](#1-root-cause). The essential point is
that **`sleepAfter` interacts badly with the library's alarm re-arm**: the
handler parks for the sleep window and then unconditionally schedules its
successor, and the idle deadline it checks is in-memory state that the constructor
resets on every re-instantiation.

Options, roughly in order of preference:

1. **Upgrade `@cloudflare/containers` and re-verify empirically.** Pinned at
   `0.3.7` here. Check whether a later release ends the alarm chain when the
   container is genuinely idle — and *verify by watching the logs*, not by
   reading the changelog.
2. **Override `alarm()` / `onActivityExpired()` in `PaContainer`** to stop the
   container and `deleteAlarm()` on a persisted idle deadline (stored in DO
   storage, so it survives re-instantiation) rather than the in-memory
   `sleepAfterMs`.
3. **Drop `sleepAfter` and stop explicitly.** Call `this.stop()` when the last
   in-flight request completes, instead of relying on an inactivity timer that
   the alarm loop keeps resetting.

**Whichever you choose, the acceptance test is empirical, not theoretical:**

> Deploy, run one analysis, then leave it strictly alone for one hour. Query the
> Worker's logs for `alarm`-origin events. **Zero alarm events after the container
> goes idle is a pass. A steady drumbeat of `wallTimeMs ≈ 180000, cpuTimeMs: 0`
> is the bug, unchanged.**

That query, for reference — group Worker logs by `$metadata.origin` over the last
hour and look at the `alarm` count. It was 6,290 over seven days with six real
requests. It should be 0.

### 4. Make `enforceRateLimit` fail CLOSED on spending routes — **blocker**

**VERIFIED by code inspection** (`src/index.ts`):

```ts
} catch {
  // Limiter unavailable -> fail open so a DO hiccup never blocks real users.
  return null;          // null means ALLOWED
}
```

If the RateLimiter Durable Object errors for any reason, the `catch` returns
`null`, which the callers read as "allowed" — **the rate limit disappears
entirely, silently.** Availability-over-strictness is a defensible default for a
read endpoint. It is the wrong default for `/api/analyze`, `/api/extract`,
`/api/jobs` and `/api/ask`, where each admitted request can spend up to
`MAX_LLM_CALLS = 200` provider calls.

Fix: fail **closed** (503 + `Retry-After`) on the LLM-spending routes; keep
fail-open, if you want it, for the cheap read routes. Ten lines, and it removes a
failure mode where a DO wobble turns into an unbounded spend window.

### 5. `workers.dev` exposure — **blocker; a deploy silently re-opens it**

The concern as raised: the Worker may still be reachable on a public
`workers.dev` hostname where **edge Access does not apply**, which would expose
`/api/analyze`, `/api/extract` and `/api/ask` — routes that proxy to a container
holding provider credentials and can spend up to `MAX_LLM_CALLS = 200` per PDF.

This started as an open question. It is no longer one.

**VERIFIED, 2026-08-02 — a routine `wrangler deploy` re-enables the hostname.**
The subdomain was confirmed **disabled** (`{"enabled": false, "previews_enabled":
false}`) before the shutdown commit. The deploy that shipped that commit — which
changed nothing about routing — flipped it back to `{"enabled": true,
"previews_enabled": true}`. Checked immediately before and immediately after. A
dashboard toggle does not survive a deploy, because `workers_dev` was simply
absent from `wrangler.jsonc` and wrangler defaults it on.

**Fix (applied):** `"workers_dev": false` is now declared in `wrangler.jsonc`, so
the setting is enforced by every deploy instead of being undone by it. This is
the difference between a control and a good intention.

Also **VERIFIED**:

- The hostname was live and publicly reachable during the observed window. Every
  inbound request in the logs — both crawler hits and the 1 August browser page
  load — arrived at `https://pa-policy-extractor.<subdomain>.workers.dev/…` and
  returned `200`, at least until **1 August 05:12 UTC**. Access was configured on
  the custom domain around **1–2 August** — *after* the 28 July crawl. (The exact
  cutover time was not independently confirmed here; the reachability evidence is
  from the Worker's own logs.)
- Edge enforcement **is** live on the custom domain (`<custom-domain>`) via the
  Access application.

What remains **UNVERIFIED**, and should be read as an open question rather than a
finding:

- Whether the `workers.dev` hostname actually bypassed Access while it was
  enabled. It is *likely* — Access applications are bound to a hostname, and this
  one names the custom domain — but it was never tested against the live endpoint
  while both were up.
- Whether anything was ever abused through it. The evidence is reassuring but not
  proof: all six logged requests are static-asset GETs and none is an `/api/*`
  route. Worker logs are sampled and retained ~7 days, so this covers the observed
  window and no further back.

Note the current blast radius, for proportion: with `CONTAINERS_OFFLINE` set,
`/api/analyze` and `/api/extract` cannot spend anything — they refuse before
reaching the container. **`/api/ask` still spends** (Workers AI + AI Search) and
is not container-backed, so it is the route that matters most here.

The check to run, **after every deploy** — not just after a restore:

```bash
# 1. Is the workers.dev hostname enabled at all?
curl -sS "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/pa-policy-extractor/subdomain" \
  -H "Authorization: Bearer $CF_API_TOKEN"
# expect {"enabled": false}

# 2. If it IS enabled, does Access actually gate it?
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  https://pa-policy-extractor.<subdomain>.workers.dev/api/brands
# a 200 with no redirect to cloudflareaccess.com means the edge policy does NOT
# apply to that hostname, and every /api/* route is open there.
```

Standing recommendation: keep `"workers_dev": false` in `wrangler.jsonc`, and
make the assertion above a **post-deploy check** rather than something someone
remembers. The general lesson is worth more than the specific setting: **a
security control that lives only in the dashboard is one deploy away from being
gone**, and nothing will tell you.

### 6. In-app Access verification authenticates nothing — advisable

**VERIFIED — found independently twice.** The Cloudflare Access plumbing in
`src/util.ts` / `src/library.ts` is real code, and today it is inert:

- It is gated on `ACCESS_TEAM_DOMAIN` **and** `ACCESS_AUD`. Both are **unset**
  (they exist only as a commented-out suggestion in `wrangler.jsonc`).
- With either unset, `resolveOwner()` falls through to `ownerFromRequest()`,
  which trusts the **spoofable** `cf-access-authenticated-user-email` header and
  falls back to `"anonymous"`.
- It is **non-blocking**: in this mode it never returns `unauthorized`. It only
  attributes ownership — it decides which tenant bucket a row lands in, not
  whether the caller may proceed.
- `/api/analyze` and `/api/extract` do not call it at all. The routes that spend
  the most have no identity handling whatsoever.

**The important nuance, so this is not overstated:** edge enforcement via the
Access application **is** configured on the custom domain (`<custom-domain>`).
Requests through the custom domain *are* authenticated at the edge, and the
identity header they carry is set by Cloudflare. The in-Worker JWT verification
is **defence-in-depth for any path that bypasses the edge** — a `workers.dev`
hostname (item 5), a future route added outside the Access application, or a
misconfiguration.

Fix: set `ACCESS_TEAM_DOMAIN` (the Zero Trust team domain,
`<team>.cloudflareaccess.com`) and `ACCESS_AUD` (the Access application's AUD
tag) to turn on signed-JWT verification, and extend it to the spending routes
rather than only the tenant-scoped read routes. The verification code already
exists (`verifyAccessJwt`, RS256 against the team certs, `aud`/`exp` checks) — it
just has nothing switched on. The commented-out template is at the bottom of the
`vars` block in `wrangler.jsonc`.

---

## 4. Restore

Do **§3 items 1–4 first.** Steps 2–5 below take about five minutes and will
recreate the bill on their own if the alarm loop is still there.

1. **Fix the alarm loop** (§3 item 3) and prove it empirically on a throwaway
   deploy before restoring the real one.

2. **Uncomment the `containers` block** in `wrangler.jsonc` — and change
   `max_instances` to `1` on the way past.

3. **Flip the runtime switch**: `"CONTAINERS_OFFLINE": "0"` in `wrangler.jsonc`.
   (Remember it defaults to *offline* when absent — deleting the line does not
   turn extraction on.)

4. **Set the AI Gateway spend cap** (§3 item 1) before the first deploy, not
   after.

5. **Deploy.** Push to `main`: `ci` runs, and on success `deploy` builds
   `container/Dockerfile` on the GitHub runner, pushes the image, and deploys the
   Worker plus the container-backed DO in one step. There is no supported local
   Docker build path. The manual escape hatch is Actions → **deploy** → *Run
   workflow*.

   The old image is still in the registry
   (`…/pa-policy-extractor-pacontainer:20577153`) if you need to compare, but the
   normal path rebuilds from the Dockerfile.

6. **Revert the UI** — all three are self-contained and cross-referenced:
   - delete `<section class="offline-notice">` from `public/index.html`
   - delete the `<script src="/offline.js">` tag and `public/offline.js`
   - delete the `SERVICE NOTICE` block at the end of `public/styles.css`
   - drop the extra footer line in `public/index.html`

7. **Update `README.md`** — remove the Status block, and rewrite "Cost &
   subscription budget" with numbers you have actually observed rather than
   modelled.

8. **Verify, in this order:**
   - `GET /api/health` returns `ok: true` and warms.
   - One real PDF analysis completes end to end.
   - The container application exists again and reports **1** instance.
   - **Then leave it alone for an hour and check the alarm count is zero.** This
     is the step that was missing the first time.

9. **Re-run the `workers.dev` check** (§3 item 5) — a redeploy is exactly the
   moment a subdomain toggle can come back.

---

## 5. What this cost, in one sentence

A three-minute idle timeout that did not time out, on three of the largest
instances the account allows, billed by wall clock, for a service that received
one crawler request in a week — because the cost model was written for the price
of doing work, and the bill came from not doing any.
