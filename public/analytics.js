/* =========================================================================
   Prior-Authorization Access Analyzer — analytics.js  (Layer 5, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /analytics.js, no inline
   code). Loaded AFTER app.js / batch.js / library.js so window.PA (+ PA.modes)
   exist.

   W2 analytics views over results — all derived client-side, all reusing the
   shared window.PA.* renderers (SCORE_META / SCORE_STOPS / barrier helpers) and
   the existing design system. Nothing here alters the Single live flow, the
   Batch job flow or the Library browser — it only adds three views:

     1. BRAND-VS-BRAND HEATMAP — for the brands of ONE policy/analysis (the
        current Single result, a Batch job's per-PDF group, or a Library detail):
        a compact grid (rows=brands, cols=Access Score + key barriers), each cell
        coloured by intensity. Inline SVG/CSS only.
     2. CROSS-PAYER BENCHMARKING — in Library mode, pick a brand -> aggregate
        that brand's Access Score across saved policies (paginated GET
        /api/library?brand=X up to the cap) into per-policy bars + a
        most/least-restrictive callout + a barrier-frequency summary.
     3. FACETED-SEARCH presets — quick one-click filters that drive the existing
        Library query (wired in library.js; benchmarking reacts to brand picks).

   Exposes window.PA.analytics for app.js / batch.js / library.js to call. Each
   call site guards on PA.analytics existing, so if this file fails to load the
   rest of the dashboard is unaffected.
   ========================================================================= */
(function () {
  "use strict";

  var PA = window.PA;
  if (!PA) return;

  var $ = function (id) { return document.getElementById(id); };

  // ---- shared column model for the heatmap --------------------------------
  // Columns after the Access-Score column. `key` is the exact deliverable
  // column (used on full ExtractResult objects for the heatmap); `row` is the
  // snake_cased alias the library index uses (used on /api/library facet rows
  // for the barrier-frequency summary). `present` is the barrier-presence
  // predicate (reused from PA). The raw display value comes straight from the
  // result row.
  var BARRIER_COLS = [
    { short: "Branded", label: "Branded steps", key: "Number of Steps through Brands", row: "branded_steps", present: PA.stepPresent },
    { short: "Generic", label: "Generic steps", key: "Number of Steps through Generic", row: "generic_steps", present: PA.stepPresent },
    { short: "Photo", label: "Phototherapy required", key: "Step through-Phototherapy", row: "phototherapy", present: PA.yesPresent },
    { short: "TB", label: "TB test required", key: "TB Test required", row: "tb", present: PA.yesPresent },
    { short: "Special.", label: "Specialist required", key: "Specialist Types", row: "specialist", present: PA.specialistPresent },
    { short: "Reauth", label: "Reauthorization required", key: "Reauthorization Required", row: "reauth_required", present: PA.yesPresent }
  ];

  // present => an active barrier (amber). absent => no barrier (green).
  // unknown => NA (grey). Mirrors app.js barrierState() so colours match the
  // barrier chips + comparison table exactly.
  function isNa(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    return s === "" || s === "na" || s === "n/a" || s === "unspecified";
  }
  function barrierState(raw, presentWhen) {
    if (isNa(raw)) return "unknown";
    return presentWhen(String(raw).trim()) ? "present" : "absent";
  }

  // Normalize a heterogeneous result object into { brand, res }. Accepts a
  // `result` AnalyzeEvent ({brand,result:{...}}) OR a stored ExtractResult
  // ({result:{...}, brand?}).
  function toItem(obj) {
    if (!obj || typeof obj !== "object") return null;
    var res = obj.result || obj; // tolerate a bare result row
    if (!res || typeof res !== "object") return null;
    var brand = obj.brand || res.Brand || res.brand || "—";
    return { brand: brand, res: res };
  }

  // =========================================================================
  // 1. BRAND-VS-BRAND HEATMAP
  // =========================================================================
  // host: a container element. items: array of result-ish objects (see toItem).
  // Renders a colour-coded grid (CSS grid; cells are <div>s, the score cell uses
  // the SCORE_META palette, barrier cells use present/absent/unknown classes).
  // Idempotent — rebuilds the host each call. Returns true if anything rendered.
  function renderHeatmap(host, items) {
    if (!host) return false;
    PA.clearChildren(host);

    var norm = (items || []).map(toItem).filter(Boolean);
    if (!norm.length) { host.hidden = true; return false; }
    host.hidden = false;

    // De-dupe by brand (keep last), preserving first-seen order.
    var order = [], byBrand = {};
    norm.forEach(function (it) {
      if (!(it.brand in byBrand)) order.push(it.brand);
      byBrand[it.brand] = it;
    });

    var grid = PA.el("div", "heatmap-grid");
    // CSS grid: a brand label column + 1 score col + N barrier cols.
    grid.style.gridTemplateColumns =
      "minmax(96px, max-content) repeat(" + (1 + BARRIER_COLS.length) + ", minmax(54px, 1fr))";

    // --- header row ---
    grid.appendChild(headCell("", "heatmap-corner"));
    grid.appendChild(headCell("Access", "heatmap-col-score"));
    BARRIER_COLS.forEach(function (c) {
      var h = headCell(c.short, "heatmap-col");
      h.title = c.label;
      grid.appendChild(h);
    });

    // --- body rows ---
    order.forEach(function (brand, rowIdx) {
      var item = byBrand[brand];
      var res = item.res;

      var bcell = PA.el("div", "heatmap-rowhead");
      bcell.appendChild(PA.el("span", "pill pill-brand", brand));
      grid.appendChild(bcell);

      // Score cell (SCORE_META palette).
      var raw = res["Access Score"];
      var score = PA.snapScore(raw);
      var sm = PA.SCORE_META[score] || PA.SCORE_META[0];
      var scoreCell = PA.el("div", "heatmap-cell heatmap-cell-score");
      scoreCell.style.background = sm.color;
      scoreCell.style.color = sm.fg;
      scoreCell.appendChild(PA.el("span", "heatmap-score-num", isNa(raw) ? "—" : String(score)));
      scoreCell.title = brand + " — Access " + (isNa(raw) ? "NA" : score) + " · " + sm.label;
      scoreCell.setAttribute("aria-label", scoreCell.title);
      animCell(scoreCell, rowIdx, 0);
      grid.appendChild(scoreCell);

      // Barrier cells.
      BARRIER_COLS.forEach(function (c, colIdx) {
        var v = res[c.key];
        var state = barrierState(v, c.present);
        var cell = PA.el("div", "heatmap-cell heatmap-" + state);
        var disp = PA.displayVal(v);
        cell.appendChild(PA.el("span", "heatmap-val", disp));
        var word = state === "present" ? "present" : state === "absent" ? "none" : "not specified";
        cell.title = brand + " — " + c.label + ": " + word + " (" + disp + ")";
        cell.setAttribute("aria-label", cell.title);
        animCell(cell, rowIdx, colIdx + 1);
        grid.appendChild(cell);
      });
    });

    host.appendChild(grid);

    // Legend (reuses barrier colour semantics + the score palette).
    host.appendChild(buildLegend());
    return true;
  }

  function headCell(text, cls) {
    var h = PA.el("div", "heatmap-head " + (cls || ""), text);
    return h;
  }

  // Staggered fade/scale-in via transform+opacity (reduced-motion safe).
  function animCell(cell, row, col) {
    if (PA.reducedMotion()) return;
    cell.style.opacity = "0";
    cell.style.transform = "scale(.9)";
    cell.style.transition = "opacity .34s var(--ease-out), transform .34s var(--ease-spring)";
    cell.style.transitionDelay = Math.min(row * 5 + col, 24) * 22 + "ms";
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        cell.style.opacity = "";
        cell.style.transform = "";
      });
    });
  }

  function buildLegend() {
    var leg = PA.el("div", "heatmap-legend");
    leg.appendChild(legItem("heatmap-present", "Barrier present"));
    leg.appendChild(legItem("heatmap-absent", "No barrier"));
    leg.appendChild(legItem("heatmap-unknown", "Not specified"));
    // Score swatch.
    var s = PA.el("span", "heatmap-legend-item");
    var sw = PA.el("span", "heatmap-legend-swatch heatmap-legend-score");
    s.appendChild(sw);
    s.appendChild(PA.el("span", "heatmap-legend-text", "Access score (0→100)"));
    leg.appendChild(s);
    return leg;
  }
  function legItem(cls, text) {
    var i = PA.el("span", "heatmap-legend-item");
    i.appendChild(PA.el("span", "heatmap-legend-swatch " + cls));
    i.appendChild(PA.el("span", "heatmap-legend-text", text));
    return i;
  }

  // --- single-mode heatmap: driven by app.js after each result ------------
  var singleHeatmapPanel = $("single-heatmap");
  var singleHeatmapHost = $("single-heatmap-host");
  function renderSingleHeatmap(results) {
    if (!singleHeatmapPanel || !singleHeatmapHost) return;
    var items = (results || []).map(function (r) { return r.data || r; });
    // Only worth showing as a grid when >1 brand was scored against the policy.
    if (items.length <= 1) { singleHeatmapPanel.hidden = true; return; }
    var ok = renderHeatmap(singleHeatmapHost, items);
    if (ok) {
      singleHeatmapPanel.hidden = false;
      PA.revealNow(singleHeatmapPanel);
    } else {
      singleHeatmapPanel.hidden = true;
    }
  }
  function resetSingleHeatmap() {
    if (!singleHeatmapPanel || !singleHeatmapHost) return;
    PA.clearChildren(singleHeatmapHost);
    singleHeatmapPanel.hidden = true;
  }

  // =========================================================================
  // 2. CROSS-PAYER BENCHMARKING  (library mode)
  // =========================================================================
  var PAGE_LIMIT = 200;            // server cap per page
  var MAX_PAGES = 5;               // hard ceiling on pages we'll pull (== 1000 rows)

  var benchPanel = $("lib-bench");
  var benchBrandPill = $("lib-bench-brand");
  var benchSub = $("lib-bench-sub");
  var benchEmpty = $("lib-bench-empty");
  var benchBody = $("lib-bench-body");
  var benchCallout = $("lib-bench-callout");
  var benchBars = $("lib-bench-bars");
  var benchCount = $("lib-bench-count");
  var benchFreq = $("lib-bench-freq");
  var benchRefreshBtn = $("lib-bench-refresh");

  var benchState = { brand: null, reqSeq: 0, loading: false };

  function qs(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v == null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return parts.length ? ("?" + parts.join("&")) : "";
  }

  // Public entry: set (or clear) the benchmarked brand. Called by library.js
  // when the brand filter changes. Empty brand hides the benchmark panel.
  function setBenchmarkBrand(brand) {
    if (!benchPanel) return;
    brand = (brand || "").trim();
    if (!brand) {
      benchState.brand = null;
      benchPanel.hidden = true;
      return;
    }
    benchState.brand = brand;
    benchPanel.hidden = false;
    PA.revealNow(benchPanel);
    if (benchBrandPill) benchBrandPill.textContent = brand;
    loadBenchmark(brand);
  }

  // Re-run the benchmark for the currently selected brand (Refresh / save).
  function refreshBenchmark() {
    if (benchState.brand) loadBenchmark(benchState.brand);
  }

  // Aggregate this brand's saved rows client-side from /api/library?brand=X,
  // paginating up to the cap. No new backend route is needed.
  function loadBenchmark(brand) {
    if (benchState.loading) { /* allow supersede via reqSeq */ }
    var seq = ++benchState.reqSeq;
    benchState.loading = true;
    if (benchRefreshBtn) benchRefreshBtn.classList.add("is-busy");
    if (benchSub) benchSub.textContent = "Aggregating saved analyses for " + brand + "…";

    var rows = [];
    function pull(offset, page) {
      var url = "/api/library" + qs({ brand: brand, limit: PAGE_LIMIT, offset: offset });
      return fetch(url, { headers: { "Accept": "application/json" } })
        .then(function (resp) {
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.json();
        })
        .then(function (data) {
          if (seq !== benchState.reqSeq) return null; // superseded
          var got = (data && data.rows) || [];
          rows = rows.concat(got);
          var total = (data && typeof data.total === "number") ? data.total : rows.length;
          if (got.length === PAGE_LIMIT && rows.length < total && page + 1 < MAX_PAGES) {
            return pull(offset + PAGE_LIMIT, page + 1);
          }
          return rows;
        });
    }

    pull(0, 0)
      .then(function (all) {
        if (all == null || seq !== benchState.reqSeq) return;
        renderBenchmark(brand, all);
      })
      .catch(function (err) {
        if (seq !== benchState.reqSeq) return;
        if (benchSub) benchSub.textContent = "Could not benchmark " + brand + " — " +
          (err && err.message ? err.message : "network error") + ".";
        if (benchBody) benchBody.hidden = true;
        if (benchEmpty) benchEmpty.hidden = true;
      })
      .finally(function () {
        if (seq === benchState.reqSeq) benchState.loading = false;
        if (benchRefreshBtn) benchRefreshBtn.classList.remove("is-busy");
      });
  }

  // A library row carries facet columns (filename, access_score, brand,
  // created_at, kind) — enough to aggregate by policy without fetching each
  // full ExtractResult. Barrier facets may also be present (best-effort).
  function renderBenchmark(brand, rows) {
    if (benchSub) {
      benchSub.textContent = rows.length
        ? ("Access Score for " + brand + " across " + rows.length + " saved analys" +
           (rows.length === 1 ? "is" : "es") + ".")
        : ("No saved analyses for " + brand + " yet.");
    }

    if (!rows.length) {
      if (benchEmpty) benchEmpty.hidden = false;
      if (benchBody) benchBody.hidden = true;
      return;
    }
    if (benchEmpty) benchEmpty.hidden = true;
    if (benchBody) benchBody.hidden = false;

    // Aggregate by policy (filename). Keep the most-recent row per policy so a
    // re-analyzed policy doesn't double-count.
    var byPolicy = {}, policyOrder = [];
    rows.forEach(function (r) {
      var name = r.filename || ("result " + String(r.id || "").slice(0, 6));
      var prev = byPolicy[name];
      if (!prev) { policyOrder.push(name); byPolicy[name] = r; return; }
      if (Number(r.created_at || 0) > Number(prev.created_at || 0)) byPolicy[name] = r;
    });

    var policies = policyOrder.map(function (name) {
      var r = byPolicy[name];
      var raw = r.access_score;
      return {
        name: name,
        row: r,
        hasScore: raw != null,
        score: raw == null ? null : PA.snapScore(raw)
      };
    });

    // Sort most → least restrictive (lowest score first); unknowns last.
    policies.sort(function (a, b) {
      if (a.hasScore && b.hasScore) return a.score - b.score;
      return a.hasScore ? -1 : (b.hasScore ? 1 : 0);
    });

    renderCallout(brand, policies);
    renderBars(policies);
    renderFreq(rows);
    if (benchCount) benchCount.textContent = String(policies.length);
  }

  function renderCallout(brand, policies) {
    if (!benchCallout) return;
    PA.clearChildren(benchCallout);
    var scored = policies.filter(function (p) { return p.hasScore; });
    if (!scored.length) {
      benchCallout.appendChild(PA.el("p", "subtle", "No numeric Access Scores saved for " + brand + " yet."));
      return;
    }
    // Already sorted ascending by score: first = most restrictive.
    var most = scored[0];
    var least = scored[scored.length - 1];
    var sum = scored.reduce(function (a, p) { return a + p.score; }, 0);
    var avg = PA.snapScore(sum / scored.length);

    benchCallout.appendChild(calloutCard("Most restrictive", most, "lowest access score — the toughest payer for this brand"));
    benchCallout.appendChild(calloutCard("Least restrictive", least, "highest access score — the broadest access for this brand"));

    var avgCard = PA.el("div", "bench-callout-card bench-callout-avg");
    avgCard.appendChild(PA.el("div", "bench-callout-k", "Average access"));
    var avgChip = scoreChip(avg);
    var avgVal = PA.el("div", "bench-callout-v");
    avgVal.appendChild(avgChip);
    avgVal.appendChild(PA.el("span", "bench-callout-meaning subtle", (PA.SCORE_META[avg] || {}).label || ""));
    avgCard.appendChild(avgVal);
    avgCard.appendChild(PA.el("div", "bench-callout-note subtle", "mean across " + scored.length + " polic" + (scored.length === 1 ? "y" : "ies")));
    benchCallout.appendChild(avgCard);
  }

  function calloutCard(kind, policy, note) {
    var card = PA.el("div", "bench-callout-card");
    card.appendChild(PA.el("div", "bench-callout-k", kind));
    var v = PA.el("div", "bench-callout-v");
    v.appendChild(scoreChip(policy.score));
    var nm = PA.el("span", "bench-callout-policy", policy.name);
    nm.title = policy.name;
    v.appendChild(nm);
    card.appendChild(v);
    card.appendChild(PA.el("div", "bench-callout-note subtle", note));
    return card;
  }

  function scoreChip(score) {
    var chip = PA.el("span", "score-chip", String(score));
    var sm = PA.SCORE_META[score] || PA.SCORE_META[0];
    chip.style.background = sm.color;
    chip.style.color = sm.fg;
    chip.title = sm.label;
    return chip;
  }

  // Horizontal bars: one per policy, width ∝ score (0..100), coloured by bucket.
  function renderBars(policies) {
    if (!benchBars) return;
    PA.clearChildren(benchBars);
    policies.forEach(function (p, i) {
      var row = PA.el("div", "bench-bar-row");

      var label = PA.el("span", "bench-bar-label", p.name);
      label.title = p.name;
      row.appendChild(label);

      var track = PA.el("div", "bench-bar-track");
      if (p.hasScore) {
        var sm = PA.SCORE_META[p.score] || PA.SCORE_META[0];
        var fill = PA.el("div", "bench-bar-fill");
        fill.style.background = sm.color;
        // grow via scaleX (GPU-composited; reduced-motion snaps).
        var pct = Math.max(0.04, p.score / 100);
        if (PA.reducedMotion()) {
          fill.style.transform = "scaleX(" + pct.toFixed(3) + ")";
        } else {
          fill.style.transform = "scaleX(0)";
          fill.style.transition = "transform .6s var(--ease-out)";
          fill.style.transitionDelay = Math.min(i, 16) * 45 + "ms";
          requestAnimationFrame(function () {
            requestAnimationFrame(function () { fill.style.transform = "scaleX(" + pct.toFixed(3) + ")"; });
          });
        }
        track.appendChild(fill);
        track.title = p.name + " — Access " + p.score + " · " + sm.label;
      } else {
        track.classList.add("is-na");
        track.title = p.name + " — no numeric score saved";
      }
      row.appendChild(track);

      var val = PA.el("span", "bench-bar-val");
      if (p.hasScore) {
        val.appendChild(scoreChip(p.score));
      } else {
        val.appendChild(PA.el("span", "subtle", "—"));
      }
      row.appendChild(val);

      benchBars.appendChild(row);
    });
  }

  // Barrier-frequency summary. Library rows MAY carry barrier facet columns; we
  // read whatever subset is present (best-effort) and show "present in N of M".
  // Columns with no data at all across rows are omitted.
  function renderFreq(rows) {
    if (!benchFreq) return;
    PA.clearChildren(benchFreq);

    var summary = BARRIER_COLS.map(function (c) {
      var present = 0, known = 0;
      rows.forEach(function (r) {
        var v = pickFacet(r, c.row, c.key);
        if (v === undefined) return;          // column absent on this row
        if (isNa(v)) { known++; return; }     // explicitly NA still counts as known
        known++;
        if (c.present(String(v).trim())) present++;
      });
      return { label: c.label, short: c.short, present: present, known: known };
    }).filter(function (s) { return s.known > 0; });

    if (!summary.length) {
      benchFreq.appendChild(PA.el("p", "subtle bench-freq-note",
        "Barrier detail isn't stored in the library index — open a policy from the table above to see its full barrier profile and the brand-vs-brand heatmap."));
      return;
    }

    summary.forEach(function (s) {
      var pct = s.known ? Math.round((s.present / s.known) * 100) : 0;
      var chip = PA.el("div", "bench-freq-chip");
      chip.title = s.label + ": present in " + s.present + " of " + s.known + " policies";
      chip.appendChild(PA.el("span", "bench-freq-name", s.short));
      var barWrap = PA.el("span", "bench-freq-bar");
      var fill = PA.el("span", "bench-freq-bar-fill");
      var w = Math.max(0.02, s.present / s.known);
      if (PA.reducedMotion()) {
        fill.style.transform = "scaleX(" + w.toFixed(3) + ")";
      } else {
        fill.style.transform = "scaleX(0)";
        fill.style.transition = "transform .55s var(--ease-out)";
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { fill.style.transform = "scaleX(" + w.toFixed(3) + ")"; });
        });
      }
      barWrap.appendChild(fill);
      chip.appendChild(barWrap);
      chip.appendChild(PA.el("span", "bench-freq-pct", pct + "%"));
      chip.appendChild(PA.el("span", "bench-freq-frac subtle", s.present + "/" + s.known));
      benchFreq.appendChild(chip);
    });
  }

  // Read a barrier facet from a library row, tolerant of a few plausible key
  // shapes: the snake_cased index alias (e.g. "branded_steps") first, then the
  // exact deliverable key (e.g. "Number of Steps through Brands"), then a nested
  // result object if the row ever embeds one. Returns undefined when the row
  // carries no such column at all.
  function pickFacet(row, rowKey, exactKey) {
    if (!row || typeof row !== "object") return undefined;
    if (rowKey && rowKey in row) return row[rowKey];
    if (exactKey && exactKey in row) return row[exactKey];
    if (row.result && typeof row.result === "object") {
      if (exactKey && exactKey in row.result) return row.result[exactKey];
      if (rowKey && rowKey in row.result) return row.result[rowKey];
    }
    return undefined;
  }

  // =========================================================================
  // public surface
  // =========================================================================
  PA.analytics = {
    renderHeatmap: renderHeatmap,
    renderSingleHeatmap: renderSingleHeatmap,
    resetSingleHeatmap: resetSingleHeatmap,
    setBenchmarkBrand: setBenchmarkBrand,
    refreshBenchmark: refreshBenchmark
  };

  // ---- wire refresh -------------------------------------------------------
  if (benchRefreshBtn) benchRefreshBtn.addEventListener("click", refreshBenchmark);
})();
