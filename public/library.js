/* =========================================================================
   Prior-Authorization Access Analyzer — library.js  (Layer 4, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /library.js, no inline code;
   reuses /theme.js for the no-FOUC head bootstrap).

   The persistent LIBRARY: every analysis (single or batch) is saved to a
   queryable, owner-scoped store so users can browse/search past results, share
   permalinks, and reuse cached results. This file ONLY adds behaviour and REUSES
   app.js's per-brand renderers (window.PA) + the #result-card-tpl template + the
   3-way mode switch (window.PA.modes, owned by batch.js). The Single live flow
   and the Batch job flow are left completely unchanged.

   Library API consumed here (provided by the Worker + D1/R2):
     POST /api/library
         body { kind, job_id?, file_sha256, runs, explain, results:[ExtractResult..] }
         -> { saved:[{id,brand,filename}], count }
     GET  /api/library?brand=&q=&minScore=&maxScore=&from=&to=&limit=&offset=
         -> { rows:[LibraryRow...], total }   (owner-scoped)
     GET  /api/library/:id
         -> the full ExtractResult JSON from R2 (404 if missing / not owner)
     GET  /api/library/lookup?sha=&brand=&runs=&explain=
         -> most-recent owner-scoped match's full ExtractResult (404 if none)
   ========================================================================= */
(function () {
  "use strict";

  // The shared surface app.js exports. If absent (app.js failed to load), bail
  // quietly — single/batch keep working, the library stays dormant.
  var PA = window.PA;
  if (!PA) return;

  var $ = function (id) { return document.getElementById(id); };

  // ---- constants ----------------------------------------------------------
  var PAGE_SIZE = 25;             // rows per page (server cap is 200)
  var MAX_LIMIT = 200;
  var CACHE_DEBOUNCE = 350;       // ms before firing a cached-result lookup

  // ---- element refs -------------------------------------------------------
  // Filter bar.
  var fBrand = $("lib-brand");
  var fQ = $("lib-q");
  var fMinScore = $("lib-min-score");
  var fMaxScore = $("lib-max-score");
  var fFrom = $("lib-from");
  var fTo = $("lib-to");
  var searchBtn = $("lib-search-btn");
  var resetBtn = $("lib-reset-btn");
  var presetWrap = document.querySelector(".lib-presets");
  var presetThisBrand = $("lib-preset-this-brand");

  // Browser.
  var browserPanel = $("lib-browser");
  var benchPanel = $("lib-bench");
  var totalBadge = $("lib-total");
  var refreshBtn = $("lib-refresh");
  var emptyBox = $("lib-empty");
  var tableWrap = $("lib-table-wrap");
  var tableBody = $("lib-table-body");
  var pager = $("lib-pager");
  var prevBtn = $("lib-prev");
  var nextBtn = $("lib-next");
  var pageInfo = $("lib-page-info");

  // Detail (full-result read-only view).
  var detailPanel = $("lib-detail");
  var detailHost = $("lib-detail-host");
  var detailHeatmapHost = $("lib-detail-heatmap");
  var detailBackBtn = $("lib-detail-back");
  var detailTitle = $("lib-detail-title");
  var detailCopyBtn = $("lib-detail-copy");
  var detailStatus = $("lib-detail-status");
  var detailBar = detailBackBtn ? detailBackBtn.parentNode : null;

  // Library error box.
  var errBox = $("lib-error");
  var errMsg = $("lib-error-message");

  // Single-mode integration: save bar + cached hint.
  var saveBar = $("lib-save-bar");
  var saveText = $("lib-save-text");
  var saveCopyBtn = $("lib-save-copy");
  var saveStatus = $("lib-save-status");

  var cacheHint = $("lib-cache-hint");
  var cacheSub = $("lib-cache-sub");
  var cacheViewBtn = $("lib-cache-view");
  var cacheDismissBtn = $("lib-cache-dismiss");

  // ---- state --------------------------------------------------------------
  var offset = 0;                 // current page offset
  var lastTotal = 0;              // total matches from the last query
  var loadedOnce = false;        // has the browser ever loaded?
  var loading = false;           // a list request is in flight
  var lastSaveId = null;         // first id from the most recent single save
  var detailOpenId = null;       // id currently shown in the detail view
  var cacheState = { id: null, sub: "", dismissedKey: null };
  var cacheTimer = null;
  var cacheReqSeq = 0;            // guards out-of-order cached lookups
  var detailExportItem = null;   // the result-ish object currently shown in detail
  var detailExportBar = null;    // the W4 export bar in the detail toolbar

  // =========================================================================
  // small helpers
  // =========================================================================
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }

  function flashLibError(msg) {
    if (!errMsg) return;
    errMsg.textContent = msg;
    show(errBox);
  }
  function clearLibError() { hide(errBox); }

  // A content-independent fallback key for file_sha256 when the real sha256 is
  // unavailable (insecure context => crypto.subtle absent => sha resolves null).
  // Prefers crypto.randomUUID(); falls back to random hex; last resort a
  // timestamp+random string. Never throws.
  function randomKey() {
    try {
      if (window.crypto && typeof crypto.randomUUID === "function") {
        return "nosha-" + crypto.randomUUID();
      }
      if (window.crypto && crypto.getRandomValues) {
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        var hex = "";
        for (var i = 0; i < arr.length; i++) hex += (arr[i] + 0x100).toString(16).slice(1);
        return "nosha-" + hex;
      }
    } catch (e) { /* fall through */ }
    return "nosha-" + Date.now().toString(16) + "-" + Math.random().toString(16).slice(2);
  }

  // Build a query string from defined, non-empty params.
  function qs(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v == null || v === "") return;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
    });
    return parts.length ? ("?" + parts.join("&")) : "";
  }

  // Epoch ms -> a friendly date+time.
  function fmtDate(ms) {
    var n = Number(ms);
    if (!n || isNaN(n)) return "—";
    var d = new Date(n);
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // A date input value (YYYY-MM-DD) -> epoch ms at local midnight; null if empty.
  // `endOfDay` shifts to 23:59:59.999 so a "to" filter is inclusive of that day.
  function dateToMs(value, endOfDay) {
    if (!value) return null;
    var parts = value.split("-");
    if (parts.length !== 3) return null;
    var y = Number(parts[0]), mo = Number(parts[1]) - 1, da = Number(parts[2]);
    var d = endOfDay ? new Date(y, mo, da, 23, 59, 59, 999) : new Date(y, mo, da, 0, 0, 0, 0);
    var t = d.getTime();
    return isNaN(t) ? null : t;
  }

  // =========================================================================
  // brand dropdown
  // =========================================================================
  function populateBrandDropdown() {
    if (!fBrand) return;
    var brands = (PA.BRANDS || []).slice();
    // Keep the "All brands" first option; append one <option> per brand.
    brands.forEach(function (b) {
      var opt = document.createElement("option");
      opt.value = b;
      opt.textContent = b;
      fBrand.appendChild(opt);
    });
  }

  // =========================================================================
  // POST /api/library — persist a finished single analysis
  // =========================================================================
  function saveSingle(payload) {
    // payload: { results:[ExtractResult...], runs, explain, filename, fileSha256Promise }
    if (!payload || !payload.results || !payload.results.length) return;
    var shaPromise = payload.fileSha256Promise || Promise.resolve(null);

    Promise.resolve(shaPromise).then(function (sha) {
      var body = {
        kind: "single",
        // On an insecure context crypto.subtle is unavailable, so the sha
        // promise resolves null and the server would 400 ('missing file_sha256'),
        // silently failing the save. Fall back to a content-independent random
        // key so the row still saves. The exact response-cache lookup will just
        // 404 for these rows (no stable sha to match), which is fine.
        file_sha256: sha || randomKey(),
        runs: payload.runs || 1,
        explain: !!payload.explain,
        // Strip the streaming wrapper fields (event/brand/pdf_index) — the
        // server extracts facets from result[...]; sending the raw ExtractResult
        // body is enough. We pass the objects as-is (extra fields are ignored).
        results: payload.results
      };
      return fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }).then(function (resp) {
      return resp.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!resp.ok || !data) {
          throw new Error((data && data.error) || ("HTTP " + resp.status));
        }
        return data;
      });
    }).then(function (data) {
      onSaved(data);
    }).catch(function (err) {
      // Saving is best-effort: never disrupt the result view. Surface subtly.
      if (saveBar && saveText) {
        saveText.textContent = "Could not save to library";
        saveBar.classList.add("is-error");
        show(saveBar);
      }
      // eslint-disable-next-line no-console
      if (window.console && console.warn) console.warn("library save failed:", err && err.message);
    });
  }

  // Hide the "saved" strip when a new single analysis begins (and the cache
  // hint, which is no longer relevant once a run is under way).
  function resetSaveBar() {
    lastSaveId = null;
    if (saveBar) {
      saveBar.classList.remove("is-error");
      hide(saveBar);
    }
    if (saveStatus) saveStatus.textContent = "";
    if (saveCopyBtn) hide(saveCopyBtn);
    hideCacheHint();
  }

  function onSaved(data) {
    if (!saveBar) return;
    var saved = (data && data.saved) || [];
    var count = (data && data.count) || saved.length;
    lastSaveId = saved.length ? saved[0].id : null;

    saveBar.classList.remove("is-error");
    saveText.textContent = count === 1
      ? "Saved to your library"
      : ("Saved " + count + " results to your library");
    show(saveBar);

    if (lastSaveId && saveCopyBtn) {
      show(saveCopyBtn);
      saveCopyBtn.onclick = function () {
        copyPermalink(lastSaveId, saveStatus);
      };
    } else {
      hide(saveCopyBtn);
    }
    // If the browser is currently open, refresh it so the new rows appear.
    if (PA.modes && PA.modes.get() === "library") loadList();
    // Keep any visible cross-payer benchmark current after a new save.
    if (PA.analytics && PA.analytics.refreshBenchmark) PA.analytics.refreshBenchmark();
  }

  // =========================================================================
  // GET /api/library — the faceted browser
  // =========================================================================
  function readFilters() {
    return {
      brand: fBrand ? fBrand.value : "",
      q: fQ ? fQ.value.trim() : "",
      minScore: fMinScore ? fMinScore.value : "",
      maxScore: fMaxScore ? fMaxScore.value : "",
      from: fFrom ? dateToMs(fFrom.value, false) : null,
      to: fTo ? dateToMs(fTo.value, true) : null
    };
  }

  function loadList() {
    if (loading) return;
    loading = true;
    clearLibError();
    var f = readFilters();
    var limit = PAGE_SIZE;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    var url = "/api/library" + qs({
      brand: f.brand,
      q: f.q,
      minScore: f.minScore,
      maxScore: f.maxScore,
      from: f.from,
      to: f.to,
      limit: limit,
      offset: offset
    });

    if (refreshBtn) refreshBtn.classList.add("is-busy");

    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        loadedOnce = true;
        var rows = (data && data.rows) || [];
        lastTotal = (data && typeof data.total === "number") ? data.total : rows.length;
        renderList(rows);
      })
      .catch(function (err) {
        flashLibError("Could not load the library — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () {
        loading = false;
        if (refreshBtn) refreshBtn.classList.remove("is-busy");
      });
  }

  function renderList(rows) {
    if (totalBadge) totalBadge.textContent = String(lastTotal);
    markActivePresets();
    PA.clearChildren(tableBody);

    if (!rows.length) {
      hide(tableWrap);
      hide(pager);
      show(emptyBox);
      // Distinguish "no saved analyses at all" from "no matches for filters".
      var anyFilter = hasActiveFilter();
      var p = emptyBox.querySelector("p");
      if (p) {
        p.textContent = anyFilter
          ? "No saved analyses match these filters. Try widening the brand, score range or dates."
          : "No saved analyses yet. Run a Single or Batch analysis — results are saved automatically and will appear here.";
      }
      return;
    }

    hide(emptyBox);
    show(tableWrap);
    rows.forEach(function (row, i) {
      tableBody.appendChild(buildRow(row, i));
    });
    renderPager();
  }

  function hasActiveFilter() {
    var f = readFilters();
    return !!(f.brand || f.q || f.minScore !== "" || f.maxScore !== "" || f.from || f.to);
  }

  // =========================================================================
  // faceted-search quick presets  (W2)
  // =========================================================================
  // Each preset drives the SAME /api/library query the manual filter bar uses —
  // it just sets the controls and re-runs loadList(). "this-brand" reuses the
  // brand already chosen in the brand <select>.
  function applyPreset(name) {
    switch (name) {
      case "restrictive":
        // score <= 25 restrictive
        if (fMinScore) fMinScore.value = "";
        if (fMaxScore) fMaxScore.value = "25";
        break;
      case "open":
        // open access: score >= 75
        if (fMinScore) fMinScore.value = "75";
        if (fMaxScore) fMaxScore.value = "";
        break;
      case "this-brand":
        // No-op beyond keeping the current brand; benchmarking already keys off
        // it. If somehow no brand is selected, do nothing.
        if (!fBrand || !fBrand.value) return;
        break;
      case "last7":
        if (fFrom) fFrom.value = isoDaysAgo(7);
        if (fTo) fTo.value = "";
        break;
      case "all":
        if (fBrand) fBrand.value = "";
        if (fQ) fQ.value = "";
        if (fMinScore) fMinScore.value = "";
        if (fMaxScore) fMaxScore.value = "";
        if (fFrom) fFrom.value = "";
        if (fTo) fTo.value = "";
        break;
      default:
        return;
    }
    offset = 0;
    loadList();
    // The "all" preset clears the brand; keep the benchmark in sync either way.
    syncBenchmark();
  }

  // YYYY-MM-DD for `n` days ago (local), for the date <input>.
  function isoDaysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    var mo = String(d.getMonth() + 1);
    var da = String(d.getDate());
    return d.getFullYear() + "-" + (mo.length < 2 ? "0" + mo : mo) + "-" + (da.length < 2 ? "0" + da : da);
  }

  // Reflect which preset matches the current filter state (visual is-active),
  // and show/label the "this brand" chip from the chosen brand.
  function markActivePresets() {
    var f = readFilters();
    if (presetThisBrand) {
      if (f.brand) {
        presetThisBrand.hidden = false;
        presetThisBrand.textContent = f.brand + " only";
      } else {
        presetThisBrand.hidden = true;
      }
    }
    if (!presetWrap) return;
    var chips = presetWrap.querySelectorAll(".lib-preset-chip");
    Array.prototype.forEach.call(chips, function (chip) {
      var p = chip.getAttribute("data-preset");
      var on = false;
      if (p === "restrictive") on = (f.maxScore === "25" && f.minScore === "");
      else if (p === "open") on = (f.minScore === "75" && f.maxScore === "");
      else if (p === "this-brand") on = !!f.brand;
      else if (p === "all") on = !hasActiveFilter();
      else if (p === "last7") on = (fFrom && fFrom.value === isoDaysAgo(7));
      chip.classList.toggle("is-active", !!on);
      chip.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  // Keep the cross-payer benchmark in sync with the brand filter. A single brand
  // chosen => show + (re)load the benchmark; cleared => hide it.
  function syncBenchmark() {
    if (!PA.analytics) return;
    var brand = fBrand ? fBrand.value : "";
    PA.analytics.setBenchmarkBrand(brand);
  }

  function buildRow(row, i) {
    var tr = document.createElement("tr");
    tr.className = "lib-row";
    tr.setAttribute("tabindex", "0");
    tr.setAttribute("role", "button");
    tr.setAttribute("data-id", row.id);
    tr.setAttribute("aria-label", "Open " + (row.filename || "result") + " — " + (row.brand || ""));
    if (!PA.reducedMotion()) tr.style.setProperty("--rd", (Math.min(i, 14) * 35) + "ms");

    // File.
    var tdFile = PA.el("td", null);
    var fileChip = PA.el("span", "lib-file-cell", row.filename || ("result #" + (row.id || "").slice(0, 6)));
    fileChip.title = row.filename || "";
    tdFile.appendChild(fileChip);
    tr.appendChild(tdFile);

    // Brand.
    var tdBrand = PA.el("td", null);
    tdBrand.appendChild(PA.el("span", "pill pill-brand", row.brand || "—"));
    tr.appendChild(tdBrand);

    // Access score chip.
    var tdScore = PA.el("td", null);
    if (row.access_score == null) {
      tdScore.appendChild(PA.el("span", "subtle", "—"));
    } else {
      var score = PA.snapScore(row.access_score);
      var chip = PA.el("span", "score-chip", String(score));
      var sm = PA.SCORE_META[score] || PA.SCORE_META[0];
      chip.style.background = sm.color;
      chip.style.color = sm.fg;
      chip.title = sm.label;
      tdScore.appendChild(chip);
    }
    tr.appendChild(tdScore);

    // Kind (single / batch).
    var tdKind = PA.el("td", null);
    var kindPill = PA.el("span", "pill pill-ghost lib-kind", row.kind || "single");
    tdKind.appendChild(kindPill);
    tr.appendChild(tdKind);

    // Saved date.
    var tdDate = PA.el("td", null, fmtDate(row.created_at));
    tr.appendChild(tdDate);

    var open = function () { openDetail(row.id, row); };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    return tr;
  }

  function renderPager() {
    if (!pager) return;
    var pageCount = Math.max(1, Math.ceil(lastTotal / PAGE_SIZE));
    var page = Math.floor(offset / PAGE_SIZE) + 1;
    if (lastTotal <= PAGE_SIZE) { hide(pager); return; }
    show(pager);
    if (pageInfo) {
      var first = offset + 1;
      var last = Math.min(offset + PAGE_SIZE, lastTotal);
      pageInfo.textContent = "Page " + page + " of " + pageCount + " · " + first + "–" + last + " of " + lastTotal;
    }
    if (prevBtn) prevBtn.disabled = offset <= 0;
    if (nextBtn) nextBtn.disabled = (offset + PAGE_SIZE) >= lastTotal;
  }

  // =========================================================================
  // GET /api/library/:id — full result detail (read-only)
  // =========================================================================
  function openDetail(id, rowHint) {
    if (!id) return;
    clearLibError();
    setHashLib(id);
    renderDetail(id, rowHint);
  }

  // Fetch + render a single saved result into the detail panel. `rowHint` (the
  // index row, if we have it) seeds the title before the full JSON arrives.
  function renderDetail(id, rowHint) {
    // Ensure we are in library mode so the panel is visible.
    if (PA.modes && PA.modes.get() !== "library") PA.modes.set("library", { silent: true });

    detailOpenId = id;
    PA.clearChildren(detailHost);
    if (detailTitle) {
      detailTitle.textContent = rowHint
        ? ((rowHint.filename || "result") + (rowHint.brand ? (" · " + rowHint.brand) : ""))
        : "Loading…";
    }
    if (detailStatus) detailStatus.textContent = "";
    hide(browserPanel);
    hide(benchPanel);          // don't show the cross-payer benchmark over a detail
    show(detailPanel);
    PA.revealNow(detailPanel);

    if (detailCopyBtn) {
      show(detailCopyBtn);
      detailCopyBtn.onclick = function () { copyPermalink(id, detailStatus); };
    }

    // Loading placeholder card. The spinner ring lives on a .spinner-core
    // child (the .spinner element itself is just the positioning box + glow).
    var loadingCard = PA.el("div", "lib-detail-loading panel");
    var loadingSpinner = PA.el("span", "spinner", "");
    loadingSpinner.appendChild(PA.el("span", "spinner-core", ""));
    loadingCard.appendChild(loadingSpinner);
    loadingCard.appendChild(PA.el("p", "subtle", "Loading saved result…"));
    detailHost.appendChild(loadingCard);

    fetch("/api/library/" + encodeURIComponent(id), { headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (resp.status === 404) throw new Error("This result is not available (it may have been removed, or belongs to a different account).");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (result) {
        if (detailOpenId !== id) return; // a newer detail was opened meanwhile
        renderResultObject(result, id);
      })
      .catch(function (err) {
        if (detailOpenId !== id) return;
        PA.clearChildren(detailHost);
        var box = PA.el("div", "panel lib-detail-error");
        box.appendChild(PA.el("p", "error-title", "Could not open this result"));
        box.appendChild(PA.el("p", "error-message", err && err.message ? err.message : "Network error."));
        detailHost.appendChild(box);
      });
  }

  // Render a full ExtractResult object via the shared #result-card-tpl renderers.
  function renderResultObject(result, id) {
    PA.clearChildren(detailHost);
    clearDetailHeatmap();
    if (!result || typeof result !== "object" || !result.result) {
      var box = PA.el("div", "panel lib-detail-error");
      box.appendChild(PA.el("p", "error-title", "Malformed result"));
      box.appendChild(PA.el("p", "error-message", "The saved result could not be displayed."));
      detailHost.appendChild(box);
      return;
    }
    var res = result.result || {};
    var brand = res.Brand || result.brand || "";
    var filename = res.Filename || "";

    // populateBrandCard reads evt.brand as a fallback; normalize it on a shallow
    // copy so we never mutate the fetched object.
    var evt = {
      brand: brand,
      result: result.result,
      access_justification: result.access_justification,
      meta: result.meta,
      policy_text: result.policy_text,
      confidence: result.confidence,
      spans: result.spans,
      consensus: result.consensus
    };

    var card = PA.cloneBrandCard(brand);
    detailHost.appendChild(card);
    PA.populateBrandCard(card, evt, filename);
    PA.animateCardEnter(card, 0);

    // W4 EXPORTS: Print / CSV / JSON / FHIR for this saved result. Re-reads the
    // currently-shown result on each click. The normalized `evt` carries the
    // full result + optional confidence/spans/consensus.
    detailExportItem = evt;
    ensureDetailExportBar();

    // W2: brand-vs-brand heatmap for this saved result's brand. A library detail
    // is a single brand, so the grid is one row — still a useful at-a-glance
    // score+barrier strip. No-op if the analytics layer didn't load.
    if (PA.analytics && detailHeatmapHost) {
      PA.analytics.renderHeatmap(detailHeatmapHost, [evt]);
    }

    if (detailTitle) {
      detailTitle.textContent = (filename || "result") + (brand ? (" · " + brand) : "");
    }
  }

  function clearDetailHeatmap() {
    if (detailHeatmapHost) { PA.clearChildren(detailHeatmapHost); detailHeatmapHost.hidden = true; }
  }

  // Build (once) and reveal the W4 export bar in the detail toolbar. It always
  // reflects the result currently shown (detailExportItem). No-op if export.js
  // failed to load. CSP-safe.
  function ensureDetailExportBar() {
    if (!PA.exports || !detailBar) return;
    if (detailExportBar && detailBar.contains(detailExportBar)) {
      detailExportBar.hidden = false;
      return;
    }
    detailExportBar = PA.exports.buildExportBar({
      scope: "library",
      compact: true,
      getItems: function () { return detailExportItem ? [detailExportItem] : []; },
      baseName: function () {
        var res = (detailExportItem && detailExportItem.result) || {};
        var f = res.Filename || "result";
        var b = res.Brand || detailExportItem && detailExportItem.brand || "";
        return "pa_" + f + (b ? "_" + b : "");
      },
      printTitle: function () {
        var res = (detailExportItem && detailExportItem.result) || {};
        return "Prior-Authorization Access Report" + (res.Filename ? " — " + res.Filename : "");
      }
    });
    // Insert before the copy button so the toolbar reads back-arrow, title,
    // export actions, copy-link.
    if (detailCopyBtn && detailCopyBtn.parentNode === detailBar) {
      detailBar.insertBefore(detailExportBar, detailCopyBtn);
    } else {
      detailBar.appendChild(detailExportBar);
    }
  }

  function hideDetailExportBar() {
    detailExportItem = null;
    if (detailExportBar) detailExportBar.hidden = true;
  }

  function closeDetail() {
    detailOpenId = null;
    hide(detailPanel);
    PA.clearChildren(detailHost);
    clearDetailHeatmap();
    hideDetailExportBar();
    show(browserPanel);
    PA.revealNow(browserPanel);
    syncBenchmark();   // restore the benchmark for the selected brand (if any)
    // Drop the #lib/<id> hash but stay in library mode.
    if (libIdFromHash()) {
      try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; }
    }
    if (!loadedOnce) loadList();
  }

  // =========================================================================
  // permalinks — #lib/<id>
  // =========================================================================
  var HASH_RE = /^#lib\/([0-9a-zA-Z._-]{1,128})$/;
  function setHashLib(id) {
    try {
      var h = "#lib/" + id;
      if (location.hash !== h) history.pushState(null, "", h);
    } catch (e) { location.hash = "#lib/" + id; }
  }
  function libIdFromHash() {
    var m = HASH_RE.exec(location.hash || "");
    return m ? m[1] : null;
  }

  function copyPermalink(id, statusEl) {
    var link = location.origin + location.pathname + "#lib/" + id;
    function done() {
      if (statusEl) {
        statusEl.textContent = "Link copied!";
        setTimeout(function () { statusEl.textContent = ""; }, 1800);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(function () { fallbackCopy(link, statusEl, done); });
    } else { fallbackCopy(link, statusEl, done); }
  }
  function fallbackCopy(text, statusEl, done) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); }
    catch (e) { if (statusEl) statusEl.textContent = "Copy failed"; }
    document.body.removeChild(ta);
  }

  // =========================================================================
  // cached-result hint (GET /api/library/lookup) — single mode
  // =========================================================================
  // Before re-running a single analysis, check whether the EXACT (sha, brand,
  // runs, explain) result is already saved; if so, offer to view it instead.
  // Only fires for a single selected brand (the lookup is per-brand).
  function onSingleContext(ctx) {
    if (!cacheHint) return;
    // Need a file (sha) and exactly one brand for an unambiguous cached lookup.
    if (!ctx || !ctx.file || !ctx.fileSha256Promise || ctx.brands.length !== 1) {
      hideCacheHint();
      return;
    }
    if (cacheTimer) clearTimeout(cacheTimer);
    var brand = ctx.brands[0];
    var runs = ctx.runs || 1;
    var explain = ctx.explain ? 1 : 0;
    cacheTimer = setTimeout(function () {
      lookupCached(ctx.fileSha256Promise, brand, runs, explain);
    }, CACHE_DEBOUNCE);
  }

  function lookupCached(shaPromise, brand, runs, explain) {
    var seq = ++cacheReqSeq;
    Promise.resolve(shaPromise).then(function (sha) {
      if (!sha) { hideCacheHint(); return null; }
      var key = sha + "|" + brand + "|" + runs + "|" + explain;
      // Respect a prior dismissal for this exact key.
      if (cacheState.dismissedKey === key) { hideCacheHint(); return null; }
      var url = "/api/library/lookup" + qs({ sha: sha, brand: brand, runs: runs, explain: explain });
      return fetch(url, { headers: { "Accept": "application/json" } }).then(function (resp) {
        if (seq !== cacheReqSeq) return null;        // superseded
        if (resp.status === 404) { hideCacheHint(); return null; }
        if (!resp.ok) { hideCacheHint(); return null; }
        return resp.json().then(function (result) {
          return { result: result, key: key, brand: brand };
        });
      });
    }).then(function (hit) {
      if (!hit || seq !== cacheReqSeq) return;
      showCacheHint(hit);
    }).catch(function () { /* lookup is best-effort */ });
  }

  function showCacheHint(hit) {
    var res = (hit.result && hit.result.result) || {};
    var score = res["Access Score"];
    cacheState.id = null; // detail by lookup is rendered inline (no library id known here)
    cacheState.result = hit.result;
    cacheState.key = hit.key;
    cacheState.brand = hit.brand;
    if (cacheSub) {
      var bits = [hit.brand];
      if (score != null) {
        var sm = PA.SCORE_META[PA.snapScore(score)];
        if (sm) bits.push("Access " + PA.snapScore(score) + " · " + sm.label);
      }
      cacheSub.textContent = bits.join(" · ");
    }
    show(cacheHint);
    if (!PA.reducedMotion()) {
      cacheHint.classList.remove("is-in");
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { cacheHint.classList.add("is-in"); });
      });
    } else {
      cacheHint.classList.add("is-in");
    }
  }

  function hideCacheHint() {
    if (!cacheHint) return;
    cacheHint.classList.remove("is-in");
    hide(cacheHint);
  }

  // "View cached result": render the looked-up ExtractResult in the library
  // detail view (switches to Library mode). It is the same renderer used for a
  // stored row, so the experience is identical to opening a permalink.
  function viewCachedResult() {
    if (!cacheState.result) return;
    if (PA.modes) PA.modes.set("library", {});
    detailOpenId = "__cache__" + Date.now();
    hide(browserPanel);
    hide(benchPanel);
    show(detailPanel);
    PA.revealNow(detailPanel);
    if (detailTitle) {
      var res = cacheState.result.result || {};
      detailTitle.textContent = (res.Filename || "cached result") + (cacheState.brand ? (" · " + cacheState.brand) : "");
    }
    // A cached preview has no library id, so there is no permalink to copy.
    if (detailCopyBtn) hide(detailCopyBtn);
    if (detailStatus) detailStatus.textContent = "";
    renderResultObject(cacheState.result, null);
    hideCacheHint();
  }

  function dismissCacheHint() {
    // Remember this exact key so we don't re-offer it until the selection changes.
    cacheState.dismissedKey = cacheState.key || null;
    hideCacheHint();
  }

  // =========================================================================
  // mode activation — load the browser the first time Library is opened
  // =========================================================================
  function onModeChange(next) {
    if (next === "library") {
      // Entering library mode. If a permalink is in the URL, the detail view is
      // already (or about to be) shown; otherwise show the browser.
      if (!libIdFromHash()) {
        hide(detailPanel);
        clearDetailHeatmap();
        show(browserPanel);
        PA.revealNow(browserPanel);
        if (!loadedOnce) loadList();
        else { renderPager(); markActivePresets(); }
      }
      // Reflect any pre-selected brand in the cross-payer benchmark.
      syncBenchmark();
    }
  }

  // =========================================================================
  // wire up
  // =========================================================================
  function bind() {
    populateBrandDropdown();

    // Filter actions.
    if (searchBtn) searchBtn.addEventListener("click", function () { offset = 0; loadList(); });
    if (resetBtn) resetBtn.addEventListener("click", function () {
      if (fBrand) fBrand.value = "";
      if (fQ) fQ.value = "";
      if (fMinScore) fMinScore.value = "";
      if (fMaxScore) fMaxScore.value = "";
      if (fFrom) fFrom.value = "";
      if (fTo) fTo.value = "";
      offset = 0;
      loadList();
      syncBenchmark();   // clears the benchmark (no brand selected)
    });
    if (refreshBtn) refreshBtn.addEventListener("click", function () { loadList(); });

    // Submit filters on Enter in the filename box; live brand/score changes too.
    if (fQ) fQ.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); offset = 0; loadList(); }
    });
    [fBrand, fMinScore, fMaxScore, fFrom, fTo].forEach(function (n) {
      if (n) n.addEventListener("change", function () { offset = 0; loadList(); });
    });
    // The brand <select> ALSO drives cross-payer benchmarking (W2): a single
    // brand chosen aggregates that brand's score across every saved policy.
    if (fBrand) fBrand.addEventListener("change", syncBenchmark);

    // Quick-preset chips (W2 faceted search) — drive the same query.
    if (presetWrap) {
      var chips = presetWrap.querySelectorAll(".lib-preset-chip");
      Array.prototype.forEach.call(chips, function (chip) {
        chip.addEventListener("click", function () { applyPreset(chip.getAttribute("data-preset")); });
      });
    }

    // Pagination.
    if (prevBtn) prevBtn.addEventListener("click", function () {
      if (offset <= 0) return;
      offset = Math.max(0, offset - PAGE_SIZE);
      loadList();
      scrollToBrowser();
    });
    if (nextBtn) nextBtn.addEventListener("click", function () {
      if ((offset + PAGE_SIZE) >= lastTotal) return;
      offset += PAGE_SIZE;
      loadList();
      scrollToBrowser();
    });

    // Detail view.
    if (detailBackBtn) detailBackBtn.addEventListener("click", closeDetail);

    // Cached-result hint.
    if (cacheViewBtn) cacheViewBtn.addEventListener("click", viewCachedResult);
    if (cacheDismissBtn) cacheDismissBtn.addEventListener("click", dismissCacheHint);

    // Mode + single-flow hooks.
    if (PA.modes && PA.modes.onModeChange) PA.modes.onModeChange(onModeChange);
    if (PA.onSingleDone) PA.onSingleDone(saveSingle);
    if (PA.onSingleStart) PA.onSingleStart(resetSaveBar);
    if (PA.onSingleContextChange) PA.onSingleContextChange(onSingleContext);

    // Permalink routing.
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
  }

  function scrollToBrowser() {
    if (browserPanel && browserPanel.scrollIntoView) {
      browserPanel.scrollIntoView({ block: "start", behavior: PA.reducedMotion() ? "auto" : "smooth" });
    }
  }

  // React to a #lib/<id> hash (paste a link, back/forward, programmatic).
  function onHashChange() {
    var id = libIdFromHash();
    if (id) {
      if (id !== detailOpenId) renderDetail(id, null);
    } else if (PA.modes && PA.modes.get() === "library" && detailPanel && !detailPanel.hidden) {
      // Hash cleared while a detail was open (back button) — return to browser.
      detailOpenId = null;
      hide(detailPanel);
      PA.clearChildren(detailHost);
      clearDetailHeatmap();
      hideDetailExportBar();
      show(browserPanel);
      PA.revealNow(browserPanel);
      syncBenchmark();
      if (!loadedOnce) loadList();
    }
  }

  // On load: if the URL is a #lib/<id> permalink, switch to library mode and
  // render that result read-only. (#job-<id> stays owned by batch.js.)
  function initFromHash() {
    var id = libIdFromHash();
    if (!id) return;
    if (PA.modes) PA.modes.set("library", { silent: true });
    renderDetail(id, null);
  }

  // ---- init ---------------------------------------------------------------
  bind();
  initFromHash();
})();
