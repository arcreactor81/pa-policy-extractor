/* =========================================================================
   Prior-Authorization Access Analyzer — app.js
   Vanilla JS, no dependencies. Talks only to /api/*.

   Wave 1: OCR a PDF once, analyze 1+ brands against it, and consume a
   newline-delimited JSON (NDJSON) event stream from POST /api/analyze,
   rendering stage-by-stage progress and per-brand result cards live.
   ========================================================================= */
(function () {
  "use strict";

  // ---- constants ----------------------------------------------------------
  var BRANDS = [
    "TREMFYA", "STELARA", "COSENTYX", "SKYRIZI", "ENBREL", "OTEZLA", "BIMZELX",
    "SILIQ", "ILUMYA", "CIMZIA", "AMJEVITA", "REMICADE", "OTULFI", "YESINTEK", "ACITRETIN"
  ];

  var SCORE_STOPS = [0, 25, 50, 75, 100];
  // Punchy bucket palette: 0 rose, 25 orange, 50 amber, 75 green, 100 emerald.
  // Mirrors the --stop-* CSS custom properties.
  // `fg` is the chip text color: dark ink #1a1530 clears WCAG AA (>=4.5:1) on
  // every bucket fill (rose 4.79, orange 7.77, amber 8.19, green 7.72, emerald
  // 6.93); plain white fails AA on all of them (2.15–3.67), so it is not used.
  var SCORE_META = {
    0:   { label: "Not covered",   color: "#f43f5e", fg: "#1a1530", meaning: "Not covered for plaque psoriasis." },
    25:  { label: "Restricted",    color: "#fb923c", fg: "#1a1530", meaning: "Covered, but with hurdles beyond the FDA label." },
    50:  { label: "Parity",        color: "#f59e0b", fg: "#1a1530", meaning: "Coverage at parity with the FDA label." },
    75:  { label: "Preferred",     color: "#22c55e", fg: "#1a1530", meaning: "Preferred / broader than the FDA label." },
    100: { label: "Open access",   color: "#10b981", fg: "#1a1530", meaning: "Fully open access — no PA / utilization management." }
  };

  // Confidence agreement thresholds: >=.8 high (green), .5-.8 mid (amber),
  // <.5 low (red). A separate "low-confidence flag" is raised below ~.6.
  var CONF_HIGH = 0.8;
  var CONF_MID = 0.5;
  var CONF_FLAG = 0.6;

  // Number of repeated extraction runs requested by the "Deep confidence" toggle.
  var DEEP_RUNS = 3;

  // W3 cross-check: short, human labels for the deliverable column keys carried
  // in a result's `consensus` map. Falls back to the raw key when unmapped, so a
  // new/renamed backend column still renders (just with its raw name).
  var FIELD_LABELS = {
    "Access Score": "Access score",
    "Age": "Age",
    "Number of Steps through Brands": "Branded steps",
    "Number of Steps through Generic": "Generic steps",
    "Step through-Phototherapy": "Phototherapy",
    "TB Test required": "TB test",
    "Quantity Limits": "Quantity limits",
    "Specialist Types": "Specialist types",
    "Initial Authorization Duration(in-months)": "Initial auth (months)",
    "Reauthorization Duration(in-months)": "Reauth (months)",
    "Reauthorization Required": "Reauth required",
    "Step Therapy Requirements Documented in Policy": "Step therapy requirements",
    "Reauthorization Requirements Documented in Policy": "Reauth requirements"
  };
  function fieldLabel(col) { return FIELD_LABELS[col] || col; }

  var MAX_BYTES = 20 * 1024 * 1024;
  var HISTORY_KEY = "pa_session_history_v1";
  var THEME_KEY = "pa_theme_v1";
  var NS = "http://www.w3.org/2000/svg";

  // Respect the user's motion preference; recomputed live.
  var motionQuery = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };
  function reducedMotion() { return !!motionQuery.matches; }

  // The 15 deliverable column keys (exact), in display order.
  // (Used for the downloadable per-brand result.)

  // ---- element refs -------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  var dropzone = $("dropzone");
  var fileInput = $("file-input");
  var fileMeta = $("file-meta");
  var fileNameEl = $("file-name");
  var fileSizeEl = $("file-size");
  var fileClear = $("file-clear");

  var brandSearch = $("brand-search");
  var brandList = $("brand-list");
  var brandChips = $("brand-chips");
  var brandCount = $("brand-count");
  var selectAllBtn = $("select-all");

  var analyzeBtn = $("analyze-btn");
  var analyzeLabel = $("analyze-label");

  var deepConfidenceToggle = $("deep-confidence");
  var sourceQuotesToggle = $("source-quotes");
  var consensusToggle = $("consensus-toggle");

  var progressEl = $("progress");
  var progressTarget = $("progress-target");
  var progressSpinner = $("progress-spinner");
  var elapsedEl = $("elapsed");
  var ocrStage = $("ocr-stage");
  var ocrIcon = $("ocr-icon");
  var ocrDetail = $("ocr-detail");
  var brandProgress = $("brand-progress");

  var errorBox = $("error-box");
  var errorMessage = $("error-message");

  var comparisonEl = $("comparison");
  var compareBody = $("compare-body");
  var resultsEl = $("results");
  var cardsHost = $("cards-host");

  var sessionPanel = $("session-panel");
  var distScope = $("dist-scope");

  var cardTpl = $("result-card-tpl");

  // ---- state --------------------------------------------------------------
  var selectedFile = null;
  var selectedFileRoute = null;   // Promise<string|null>: sha256 hex of selectedFile
                                  // (sticky-routing key). Computed once per file,
                                  // reused for repeat analyses of the same file.
  var selected = [];          // chosen brand names (order preserved)
  var availableBrands = BRANDS.slice();
  var busy = false;
  var elapsedTimer = null;   // setInterval fallback handle
  var elapsedRaf = null;     // requestAnimationFrame handle (preferred)
  var history = loadHistory();

  // Monotonic id for evidence disclosures (aria-controls wiring).
  var evidenceSeq = 0;

  // ---- additive hooks for the persistent Library (public/library.js) -------
  // These let library.js (a) persist a finished single analysis and (b) offer a
  // cached-result hint before re-running — WITHOUT touching the streaming flow.
  // Both are no-ops unless library.js registers a callback.
  var singleDoneCbs = [];          // fn({ results, fileSha256, runs, explain, filename })
  var singleStartCbs = [];         // fn()  — fired when a single analysis begins
  var singleContextCbs = [];       // fn({ file, fileSha256Promise, brands, runs, explain })
  function notifySingleDone(payload) {
    singleDoneCbs.forEach(function (cb) { try { cb(payload); } catch (e) { /* ignore */ } });
  }
  function notifySingleStart() {
    singleStartCbs.forEach(function (cb) { try { cb(); } catch (e) { /* ignore */ } });
  }
  function notifySingleContext() {
    if (!singleContextCbs.length) return;
    var ctx = getSingleContext();
    singleContextCbs.forEach(function (cb) { try { cb(ctx); } catch (e) { /* ignore */ } });
  }
  // Snapshot of the current single-mode selection (used for the cached lookup).
  function getSingleContext() {
    var deep = !!(deepConfidenceToggle && deepConfidenceToggle.checked);
    var quotes = !sourceQuotesToggle || sourceQuotesToggle.checked;
    var consensus = !!(consensusToggle && consensusToggle.checked);
    return {
      file: selectedFile,
      filename: selectedFile ? selectedFile.name : "",
      fileSha256Promise: selectedFile ? (selectedFileRoute || computeRouteHex(selectedFile)) : null,
      brands: selected.slice(),
      runs: deep ? DEEP_RUNS : 1,
      explain: quotes,
      consensus: consensus
    };
  }

  // Per-analysis runtime state (reset each run).
  var run = null;
  function newRun(brands) {
    return {
      brands: brands.slice(),
      rows: {},          // brand -> { li, steps:{reduce,extract,score} } progress row refs
      cards: {},         // brand -> card element + data
      results: [],       // ordered list of { brand, data } as they arrive
      ocrDone: false,
      ocrCached: false,  // set from the 'start' event; guards ocr_start cache-flash
      cardSeq: 0,        // for staggered card-enter timing
      deep: false,       // "Deep confidence" toggle (runs=3) — set in analyze()
      quotes: true,      // "Source quotes" toggle (explain) — set in analyze()
      consensus: false   // "Cross-check (validators)" toggle — set in analyze()
    };
  }

  // =========================================================================
  // helpers
  // =========================================================================
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(2) + " MB";
  }

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return "—";
    if (ms < 1000) return Math.round(ms) + " ms";
    return (ms / 1000).toFixed(1) + " s";
  }

  function fmtNum(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString();
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgEl(tag) { return document.createElementNS(NS, tag); }

  function show(node) { node.hidden = false; }
  function hide(node) { node.hidden = true; }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Snap an arbitrary score to the nearest defined bucket.
  function snapScore(raw) {
    var n = Number(raw);
    if (isNaN(n)) return 0;
    var best = SCORE_STOPS[0], bestD = Infinity;
    for (var i = 0; i < SCORE_STOPS.length; i++) {
      var d = Math.abs(SCORE_STOPS[i] - n);
      if (d < bestD) { bestD = d; best = SCORE_STOPS[i]; }
    }
    return best;
  }

  function valueClass(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    if (s === "" || s === "na" || s === "n/a" || s === "unspecified" || s === "none") return "is-na";
    if (s === "yes") return "is-yes";
    if (s === "no") return "is-no";
    if (!isNaN(Number(s))) return "is-num";
    return "";
  }

  function displayVal(v) {
    if (v == null || String(v).trim() === "") return "NA";
    return String(v);
  }

  function isNa(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    return s === "" || s === "na" || s === "n/a" || s === "unspecified";
  }

  // =========================================================================
  // animation toolkit  (transform/opacity only; rAF for counts/sweeps)
  // =========================================================================

  // Signature card entrance: scale(.96)+fade+slide -> settle, staggered.
  function animateCardEnter(node, index) {
    if (reducedMotion()) return;
    node.classList.add("card-enter");
    node.style.transitionDelay = Math.min(index, 6) * 70 + "ms";
    node.style.willChange = "transform, opacity";
    // Force a frame so the initial state is committed before transitioning.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        node.classList.add("card-enter-active");
      });
    });
    node.addEventListener("transitionend", function onEnd(e) {
      if (e.propertyName !== "transform") return;
      node.classList.remove("card-enter", "card-enter-active");
      node.style.transitionDelay = "";
      node.style.willChange = "";
      node.removeEventListener("transitionend", onEnd);
    });
  }

  // Count a numeric text node up from 0 -> value via requestAnimationFrame.
  function countUp(node, to, dur) {
    to = Number(to) || 0;
    if (reducedMotion()) { node.textContent = String(to); return; }
    dur = dur || 850;
    var start = null;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      // easeOutCubic
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(eased * to));
      if (t < 1) requestAnimationFrame(frame);
      else node.textContent = String(to);
    }
    requestAnimationFrame(frame);
  }

  // Coalesce bursts of an expensive rebuild to AT MOST ONE call per animation
  // frame: the returned wrapper schedules `fn` via requestAnimationFrame and
  // collapses every further call made before that frame fires. The trailing
  // schedule always runs, so the FINAL state after the last call in a burst is
  // always rendered. Falls back to direct calls where rAF is unavailable.
  function rafCoalesce(fn) {
    if (typeof requestAnimationFrame !== "function") return fn;
    var pending = false;
    return function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        fn();
      });
    };
  }

  // IntersectionObserver: reveal panels with fade-slide-up once on scroll.
  var revealObserver = ("IntersectionObserver" in window)
    ? new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            obs.unobserve(entry.target);
          }
        });
      }, { threshold: 0.08, rootMargin: "0px 0px -40px 0px" })
    : null;

  // Reveal a node now (used when a .reveal panel is un-hidden by JS).
  // Defer one frame so the fade-slide-up transition runs from its initial
  // (hidden) state rather than being batched with the un-hide.
  function revealNow(node) {
    if (!node) return;
    if (revealObserver) revealObserver.unobserve(node);
    if (node.classList.contains("is-in")) return;
    if (reducedMotion()) { node.classList.add("is-in"); return; }
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { node.classList.add("is-in"); });
    });
  }

  function initReveals() {
    var nodes = document.querySelectorAll(".reveal");
    Array.prototype.forEach.call(nodes, function (node, i) {
      // Hidden panels (comparison/session) are revealed by revealNow() when
      // JS un-hides them — don't pre-reveal or observe them here.
      if (node.hidden) return;
      if (node.classList.contains("stagger")) {
        node.style.setProperty("--d", (i * 90) + "ms");
      }
      var rect = node.getBoundingClientRect();
      var aboveFold = rect.top < (window.innerHeight || 800);
      if (aboveFold || !revealObserver || reducedMotion()) {
        // settle on next frame so the transition runs from the initial state
        requestAnimationFrame(function () { node.classList.add("is-in"); });
      } else {
        revealObserver.observe(node);
      }
    });
  }

  // =========================================================================
  // theme toggle  (manual override persisted in localStorage)
  // =========================================================================
  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }
  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }
  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr) return attr;
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }
  function initTheme() {
    applyTheme(storedTheme());
    var btn = $("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      btn.setAttribute("aria-label", "Switch to " + (next === "dark" ? "light" : "dark") + " theme");
    });
  }

  // =========================================================================
  // brand multi-select picker
  // =========================================================================
  function setBrands(list) {
    if (list && list.length) availableBrands = list.slice();
    // drop any previously-selected brands no longer offered
    selected = selected.filter(function (b) { return availableBrands.indexOf(b) !== -1; });
    renderBrandList();
    renderBrandChips();
    refreshAnalyzeEnabled();
  }

  function renderBrandList() {
    var q = (brandSearch.value || "").trim().toLowerCase();
    clearChildren(brandList);
    availableBrands.forEach(function (b) {
      if (q && b.toLowerCase().indexOf(q) === -1) return;
      var li = el("li", "brand-option");
      var id = "brand-opt-" + b;
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.value = b;
      cb.checked = selected.indexOf(b) !== -1;
      cb.className = "brand-checkbox";
      cb.addEventListener("change", function () { toggleBrand(b, cb.checked); });
      var lab = el("label", "brand-option-label", b);
      lab.setAttribute("for", id);
      li.appendChild(cb);
      li.appendChild(lab);
      brandList.appendChild(li);
    });
    if (!brandList.children.length) {
      brandList.appendChild(el("li", "brand-empty subtle", "No brands match “" + q + "”."));
    }
  }

  function toggleBrand(brand, on) {
    var idx = selected.indexOf(brand);
    if (on && idx === -1) selected.push(brand);
    else if (!on && idx !== -1) selected.splice(idx, 1);
    syncCheckbox(brand, on);
    renderBrandChips();
    refreshAnalyzeEnabled();
  }

  // Keep the (possibly off-screen / filtered) checkbox in sync without a full re-render.
  function syncCheckbox(brand, on) {
    var cb = document.getElementById("brand-opt-" + brand);
    if (cb) cb.checked = on;
  }

  function renderBrandChips() {
    clearChildren(brandChips);
    selected.forEach(function (b) {
      var chip = el("span", "brand-chip");
      chip.appendChild(el("span", "brand-chip-name", b));
      var x = el("button", "brand-chip-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Remove " + b);
      x.addEventListener("click", function () { toggleBrand(b, false); });
      chip.appendChild(x);
      brandChips.appendChild(chip);
    });
    brandCount.textContent = String(selected.length);
    var all = selected.length === availableBrands.length && availableBrands.length > 0;
    selectAllBtn.textContent = all ? "Clear all" : ("Select all " + availableBrands.length);
    selectAllBtn.setAttribute("aria-pressed", all ? "true" : "false");
  }

  function toggleSelectAll() {
    var all = selected.length === availableBrands.length && availableBrands.length > 0;
    selected = all ? [] : availableBrands.slice();
    renderBrandList();   // refresh visible checkbox states
    renderBrandChips();
    refreshAnalyzeEnabled();
  }

  // Optional refresh from the container; failure is non-fatal (we hardcode the list).
  function refreshBrands() {
    fetch("/api/brands", { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && Array.isArray(j.brands) && j.brands.length) setBrands(j.brands);
      })
      .catch(function () { /* keep hardcoded list */ });
  }

  // =========================================================================
  // sticky-routing key — sha256 hex of the uploaded PDF
  // =========================================================================
  // The dashboard POSTs to /api/analyze?route=<sha256hex>. The Worker routes the
  // request to the container instance named by that key, so the SAME PDF always
  // hits the SAME instance (OCR-once cache hit) while DISTINCT PDFs land on
  // distinct instances (parallel). Computed once per file and cached on
  // selectedFileRoute so repeat analyses of the same file reuse it.
  function computeRouteHex(file) {
    // crypto.subtle requires a secure context; absent => no ?route (Worker
    // falls back to round-robin). Never block analysis on a hashing failure.
    if (!file || !window.crypto || !crypto.subtle || !crypto.subtle.digest) {
      return Promise.resolve(null);
    }
    return file.arrayBuffer()
      .then(function (buf) { return crypto.subtle.digest("SHA-256", buf); })
      .then(function (digest) {
        var bytes = new Uint8Array(digest);
        var hex = "";
        for (var i = 0; i < bytes.length; i++) {
          hex += (bytes[i] + 0x100).toString(16).slice(1);
        }
        return hex;
      })
      .catch(function () { return null; });
  }

  // =========================================================================
  // file selection
  // =========================================================================
  function setFile(file) {
    if (!file) return;
    var nameOk = /\.pdf$/i.test(file.name);
    var typeOk = !file.type || file.type === "application/pdf";
    if (!nameOk || !typeOk) {
      flashError("That doesn't look like a PDF. Please choose a .pdf file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      flashError("That PDF is " + fmtBytes(file.size) + " — the limit is 20 MB.");
      return;
    }
    clearError();
    selectedFile = file;
    // Kick off sha256 hashing once, now, so the sticky-routing key is ready by
    // the time the user clicks Analyze (and is reused for repeat analyses).
    selectedFileRoute = computeRouteHex(file);
    fileNameEl.textContent = file.name;
    fileNameEl.title = file.name;
    fileSizeEl.textContent = fmtBytes(file.size);
    show(fileMeta);
    dropzone.classList.add("has-file");
    refreshAnalyzeEnabled();
  }

  function clearFile() {
    selectedFile = null;
    selectedFileRoute = null;
    fileInput.value = "";
    hide(fileMeta);
    dropzone.classList.remove("has-file");
    refreshAnalyzeEnabled();
  }

  function refreshAnalyzeEnabled() {
    var ready = !busy && !!selectedFile && selected.length >= 1;
    analyzeBtn.disabled = !ready;
    analyzeLabel.textContent = selected.length > 1
      ? ("Analyze " + selected.length + " brands")
      : "Analyze policy";
    // Let the Library offer a cached-result hint for the current selection.
    notifySingleContext();
  }

  // =========================================================================
  // errors
  // =========================================================================
  var errorTimer = null;
  function flashError(msg) {
    errorMessage.textContent = msg;
    show(errorBox);
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(clearError, 7000);
  }
  function showError(msg) {
    errorMessage.textContent = msg;
    show(errorBox);
  }
  function clearError() {
    hide(errorBox);
    if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  }

  // =========================================================================
  // progress UI
  // =========================================================================
  function startProgress(brands) {
    var label = selectedFile.name + " · " + (brands.length === 1
      ? brands[0]
      : (brands.length + " brands"));
    progressTarget.textContent = label;
    progressSpinner.classList.remove("done");
    show(progressEl);

    // OCR stage: pending until ocr_start.
    show(ocrStage);
    setStageIcon(ocrIcon, "pending");
    setOcrScanning(false);
    ocrDetail.textContent = "queued…";

    // Per-brand progress list.
    clearChildren(brandProgress);
    hide(brandProgress);

    elapsedEl.textContent = "0.0s";
    startElapsedClock();
  }

  // Drive the elapsed clock via requestAnimationFrame, repainting at most ~10fps
  // (only when the tenth-of-a-second display actually changes). Falls back to
  // setInterval where rAF is unavailable. Cancelled in stopProgress().
  function startElapsedClock() {
    stopElapsedClock();
    var t0 = Date.now();
    var last = "";
    if (typeof requestAnimationFrame === "function") {
      var tick = function () {
        var s = ((Date.now() - t0) / 1000).toFixed(1) + "s";
        if (s !== last) { last = s; elapsedEl.textContent = s; }
        elapsedRaf = requestAnimationFrame(tick);
      };
      elapsedRaf = requestAnimationFrame(tick);
    } else {
      elapsedTimer = setInterval(function () {
        elapsedEl.textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      }, 100);
    }
  }
  function stopElapsedClock() {
    if (elapsedRaf != null) { cancelAnimationFrame(elapsedRaf); elapsedRaf = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function stopProgress() {
    stopElapsedClock();
    progressSpinner.classList.add("done");
    setOcrScanning(false);
  }

  function hideProgress() { hide(progressEl); }

  // state: "pending" | "active" | "done" | "error"
  function setStageIcon(node, state) {
    node.className = "stage-icon stage-" + state;
  }

  // Toggle the scanning shimmer on the OCR stage row while reading is active.
  function setOcrScanning(on) {
    if (!ocrStage) return;
    ocrStage.classList.toggle("is-scanning", !!on && !reducedMotion());
  }

  // Build the per-brand progress rows once OCR is done. Idempotent: only
  // (re)builds if the rows haven't been created yet for this run.
  function buildBrandProgress(brands) {
    if (run.rows && Object.keys(run.rows).length) return;
    clearChildren(brandProgress);
    run.rows = {};
    // The "evidence" step only appears when the source-span pass is requested.
    var stepDefs = [["reduce", "Reduce"], ["extract", "Extract"], ["score", "Score"]];
    if (run.quotes) stepDefs.push(["evidence", "Evidence"]);
    brands.forEach(function (b) {
      var li = el("li", "bp-row");
      li.appendChild(el("span", "bp-brand pill pill-brand", b));
      var steps = el("span", "bp-steps");
      var stepRefs = {};
      stepDefs.forEach(function (s) {
        var chip = el("span", "bp-step bp-pending", s[1]);
        stepRefs[s[0]] = chip;
        steps.appendChild(chip);
      });
      li.appendChild(steps);
      var status = el("span", "bp-status subtle", "waiting…");
      li.appendChild(status);
      brandProgress.appendChild(li);
      // `extractLabel` keeps the base "Extract" text so run-counter updates can
      // reset cleanly; `order` lists the steps present for this run.
      run.rows[b] = { li: li, steps: stepRefs, status: status, order: stepDefs.map(function (s) { return s[0]; }) };
    });
    show(brandProgress);
  }

  // Ensure progress rows exist even if ocr_done was skipped/out of order.
  function ensureBrandRows() {
    if (!run.rows || !Object.keys(run.rows).length) buildBrandProgress(run.brands);
  }

  function advanceBrandStep(brand, step) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row) return;
    var chip = row.steps[step];
    if (chip) {
      chip.className = "bp-step bp-done";
      // Restore the base label (markExtractRun may have set "Extract i/N").
      if (step === "extract") chip.textContent = "Extract";
    }
    // Auto-activate the next step in the reduce -> extract -> score chain only.
    // "evidence" is a separate pass driven by spans_start/spans_done, so we never
    // pre-activate it here.
    var order = ["reduce", "extract", "score"];
    var idx = order.indexOf(step);
    var next = order[idx + 1];
    if (next && row.steps[next]) row.steps[next].className = "bp-step bp-active";
    row.status.textContent = step === "score"
      ? (row.steps.evidence ? "finding evidence…" : "scoring…")
      : (step + " done");
  }

  function startBrandRow(brand) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row) return;
    row.li.classList.add("active");
    if (row.steps.reduce) row.steps.reduce.className = "bp-step bp-active";
    row.status.textContent = "reducing…";
  }

  // Deep-confidence: annotate the Extract step pill with "run i/N" as each
  // repeated extraction completes, and reflect it in the row status.
  function markExtractRun(brand, i, of) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row || !row.steps.extract) return;
    var chip = row.steps.extract;
    // Keep the active pulse while runs are in flight.
    if (chip.className.indexOf("bp-done") === -1) chip.className = "bp-step bp-active";
    chip.textContent = "Extract " + i + "/" + of;
    row.status.textContent = "extracting… run " + i + "/" + of;
  }

  // Source-span ("Evidence") pass pill: pending -> active (spans_start) ->
  // done (spans_done). Idempotent; no-ops if the evidence step isn't present.
  function startEvidenceStep(brand) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row || !row.steps.evidence) return;
    row.steps.evidence.className = "bp-step bp-active";
    row.status.textContent = "finding evidence…";
  }
  function doneEvidenceStep(brand, spansMs) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row || !row.steps.evidence) return;
    row.steps.evidence.className = "bp-step bp-done";
    if (spansMs != null) row.status.textContent = "evidence " + fmtMs(spansMs);
  }

  function finishBrandRow(brand, ok, errMsg) {
    ensureBrandRows();
    var row = run.rows[brand];
    if (!row) return;
    row.li.classList.remove("active");
    if (ok) {
      row.li.classList.add("ok");
      row.status.textContent = "done ✓";
      row.status.className = "bp-status bp-ok";
    } else {
      row.li.classList.add("failed");
      (row.order || ["reduce", "extract", "score"]).forEach(function (s) {
        if (row.steps[s] && row.steps[s].className.indexOf("bp-done") === -1) {
          row.steps[s].className = "bp-step bp-failed";
        }
      });
      row.status.textContent = "failed";
      row.status.title = errMsg || "";
      row.status.className = "bp-status bp-err";
    }
  }

  // =========================================================================
  // analyze flow — NDJSON streaming consumer
  // =========================================================================
  function analyze() {
    if (busy || !selectedFile || selected.length < 1) return;
    var brands = selected.slice();

    clearError();
    hide(comparisonEl);
    hide(resultsEl);
    clearChildren(cardsHost);
    clearChildren(compareBody);
    // W2: clear any prior brand-vs-brand heatmap before a fresh run.
    if (window.PA && window.PA.analytics) window.PA.analytics.resetSingleHeatmap();
    // Reset any prior "Saved to library" affordance before a fresh run.
    notifySingleStart();

    busy = true;
    run = newRun(brands);
    analyzeBtn.classList.add("is-loading");
    refreshAnalyzeEnabled();
    startProgress(brands);

    var form = new FormData();
    form.append("file", selectedFile, selectedFile.name);
    form.append("brands", brands.join(","));

    // Additive request controls. Deep confidence triples LLM calls, so when off
    // we omit `runs` entirely (server default = 1). Source quotes default ON.
    var deep = !!(deepConfidenceToggle && deepConfidenceToggle.checked);
    var quotes = !sourceQuotesToggle || sourceQuotesToggle.checked;
    var consensus = !!(consensusToggle && consensusToggle.checked);
    if (deep) form.append("runs", String(DEEP_RUNS));
    form.append("explain", quotes ? "true" : "false");
    // W3 cross-check (toggle is checked by DEFAULT in index.html — every upload
    // gets 3-way verification unless the user unticks it). Sent as "1"/"0"; the
    // server treats an absent/0 field as consensus-off (API back-compat).
    form.append("consensus", consensus ? "1" : "0");
    run.deep = deep;
    run.quotes = quotes;
    run.consensus = consensus;

    // Sticky routing: POST to /api/analyze?route=<sha256hex-of-pdf> so the same
    // PDF always hits the same container instance (OCR-once cache hit). The hash
    // was started in setFile(); reuse the cached promise. If it's unavailable
    // (older browser / insecure context / failure) we omit ?route and the Worker
    // round-robins a fallback pool. Resolving null is non-fatal.
    var routePromise = selectedFileRoute || computeRouteHex(selectedFile);

    // No client-side timeout: OCR + LLM can take minutes on a cold container.
    routePromise
      .then(function (hex) {
        var url = hex ? ("/api/analyze?route=" + encodeURIComponent(hex)) : "/api/analyze";
        return fetch(url, { method: "POST", body: form });
      })
      .then(function (resp) {
        var ctype = resp.headers.get("content-type") || "";
        // A non-streaming JSON error (e.g. Worker 413/502 or { error }) — surface it.
        if (!resp.ok || ctype.indexOf("ndjson") === -1) {
          return resp.text().then(function (text) {
            var data = null;
            try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
            var msg = (data && data.error) ||
              ("Server returned HTTP " + resp.status + (text ? (": " + text.slice(0, 200)) : ""));
            throw new Error(msg);
          });
        }
        if (!resp.body || !resp.body.getReader) {
          throw new Error("Streaming is not supported by this browser.");
        }
        return consumeStream(resp.body.getReader());
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : "Network error — could not reach the analyzer.");
      })
      .finally(function () {
        busy = false;
        analyzeBtn.classList.remove("is-loading");
        stopProgress();
        finalizeRun();
        refreshAnalyzeEnabled();
      });
  }

  // Read the NDJSON body: buffer bytes, split on newlines, JSON.parse each
  // complete line, and flush a trailing line (no terminating newline) at EOF.
  function consumeStream(reader) {
    var decoder = new TextDecoder("utf-8");
    var buffer = "";

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          // flush the decoder's internal buffer so a final multibyte char
          // split across the last chunk boundary isn't dropped
          buffer += decoder.decode();
          // flush any trailing partial line that wasn't newline-terminated
          var tail = buffer.trim();
          if (tail) dispatchLine(tail);
          buffer = "";
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        var nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          var line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          var trimmed = line.trim();
          if (trimmed) dispatchLine(trimmed);
        }
        return pump();
      });
    }
    return pump();
  }

  function dispatchLine(line) {
    var evt;
    try { evt = JSON.parse(line); }
    catch (e) { return; } // ignore unparseable lines (keep-alive whitespace, etc.)
    if (!evt || typeof evt !== "object") return;
    handleEvent(evt);
  }

  // =========================================================================
  // event handlers
  // =========================================================================
  function handleEvent(evt) {
    switch (evt.event) {
      case "start":
        // Reconcile the brand list with what the server actually accepted.
        if (Array.isArray(evt.brands) && evt.brands.length) {
          run.brands = evt.brands.slice();
        }
        if (evt.ocr_cached) {
          run.ocrCached = true;
          setStageIcon(ocrIcon, "done");
          setOcrScanning(false);
          ocrDetail.textContent = "OCR reused from cache (this PDF was read before).";
        }
        break;

      case "ocr_start":
        // Cache hit: do NOT reset the stage to "reading the PDF…" — the 'start'
        // event already showed the cached state. Avoid the misleading flash.
        if (run.ocrCached) break;
        setStageIcon(ocrIcon, "active");
        setOcrScanning(true);
        ocrDetail.textContent = "reading the PDF…";
        break;

      case "heartbeat":
        // Keep-alive ping. stage is "ocr" | "brands" (types.ts allows both); any
        // other/absent stage is tolerated and ignored — never breaks the stream.
        if (evt.stage === "ocr") {
          if (run.ocrCached) break;
          setStageIcon(ocrIcon, "active");
          setOcrScanning(true);
          ocrDetail.textContent = "reading the PDF… (" + fmtMs(evt.elapsed_ms) + ")";
        } else if (evt.stage === "brands") {
          // Brand fan-out is alive (brands stream back out of order, in parallel).
          // Just keep the top spinner spinning as a subtle "analyzing…" cue; do
          // NOT touch any per-brand row (those are keyed/driven by their own
          // events) so simultaneous brand progress is never disturbed.
          progressSpinner.classList.remove("done");
        }
        break;

      case "ocr_done":
        run.ocrDone = true;
        setStageIcon(ocrIcon, "done");
        setOcrScanning(false);
        ocrDetail.textContent =
          fmtNum(evt.pages) + " page" + (evt.pages === 1 ? "" : "s") + " · " +
          fmtNum(evt.full_markdown_chars) + " chars" +
          (evt.cached ? " · cached" : "") +
          " · " + fmtMs(evt.docling_ms);
        buildBrandProgress(run.brands);
        break;

      case "brand_start":
        startBrandRow(evt.brand);
        break;

      case "reduce_done":
        advanceBrandStep(evt.brand, "reduce");
        break;

      case "extract_run_done":
        // Deep-confidence: one of the N repeated extraction runs finished.
        markExtractRun(evt.brand, evt.run, evt.of);
        break;

      case "extract_done":
        advanceBrandStep(evt.brand, "extract");
        break;

      case "score_done":
        advanceBrandStep(evt.brand, "score");
        break;

      case "spans_start":
        // Source-span pass began for this brand.
        startEvidenceStep(evt.brand);
        break;

      case "spans_done":
        doneEvidenceStep(evt.brand, evt.spans_ms);
        break;

      case "result":
        finishBrandRow(evt.brand, true);
        renderBrandResult(evt);
        run.results.push({ brand: evt.brand, data: evt });
        addHistory(evt);
        updateComparison();
        renderDistribution();
        // W2: brand-vs-brand heatmap for this policy's brands (no-op if the
        // analytics layer didn't load; only shows when >1 brand scored).
        if (window.PA && window.PA.analytics) window.PA.analytics.renderSingleHeatmap(run.results);
        break;

      case "error":
        if (evt.brand) {
          // per-brand failure: mark the row, continue
          finishBrandRow(evt.brand, false, evt.error);
          renderBrandError(evt.brand, evt.error);
        } else {
          // fatal/global failure
          showError(evt.error || "The analyzer reported a fatal error.");
        }
        break;

      case "done":
        // total_ms available on evt.total_ms; finalizeRun handles teardown.
        run.totalMs = evt.total_ms;
        // Persist this single analysis to the library (library.js owns the POST).
        // We hand over the per-brand result events + the run config; the sha256
        // is the same ?route= key already computed for sticky routing.
        if (run.results.length) {
          var payload = {
            results: run.results.map(function (r) { return r.data; }),
            runs: run.deep ? DEEP_RUNS : 1,
            explain: !!run.quotes,
            filename: selectedFile ? selectedFile.name : "",
            fileSha256Promise: selectedFileRoute || (selectedFile ? computeRouteHex(selectedFile) : Promise.resolve(null))
          };
          notifySingleDone(payload);
        }
        break;

      default:
        break;
    }
  }

  function finalizeRun() {
    if (!run) { hideProgress(); return; }
    // Keep the progress panel visible briefly only if nothing rendered;
    // otherwise hide it now that cards are present.
    var anyResult = run.results.length > 0;
    if (anyResult) { show(resultsEl); ensureSingleExportBar(); }
    hideProgress();
    renderHistory();
  }

  // W4 EXPORTS: a Print / CSV / JSON / FHIR action bar for the SINGLE result
  // (all brands scored against this one policy). Built once (on the first
  // finished run) and re-reads run.results on each click so every brand is
  // included. No-op if export.js failed to load. CSP-safe (no inline code).
  var singleExportBar = null;
  function ensureSingleExportBar() {
    if (!window.PA || !window.PA.exports || !resultsEl) return;
    if (singleExportBar && resultsEl.contains(singleExportBar)) return;
    singleExportBar = window.PA.exports.buildExportBar({
      scope: "single",
      getItems: function () { return run && run.results ? run.results.map(function (r) { return r.data; }) : []; },
      baseName: function () {
        var name = selectedFile ? selectedFile.name : "policy";
        return "pa_" + name;
      },
      printTitle: function () {
        return "Prior-Authorization Access Report" +
          (selectedFile ? " — " + selectedFile.name : "");
      }
    });
    // Place it just above the cards so it reads as a results-level toolbar.
    resultsEl.insertBefore(singleExportBar, cardsHost);
  }

  // =========================================================================
  // render: per-brand result card (cloned from <template>)
  // =========================================================================
  function renderBrandResult(evt) {
    var card = getOrCreateCard(evt.brand);
    populateBrandCard(card, evt, selectedFile ? selectedFile.name : "");
  }

  // Populate an EXISTING (template-cloned) brand-result card from a `result`
  // event. Pure w.r.t. the single-PDF run state — given a card element + a
  // fallback filename it fully renders score/barriers/cards/meta. Reused by the
  // single-PDF flow (renderBrandResult) AND the Batch mode (window.PA), so the
  // #result-card-tpl renderers stay the single source of truth.
  function populateBrandCard(card, evt, fallbackFile) {
    var brand = evt.brand;
    var data = evt;                       // result event carries result/meta/etc.
    var res = data.result || {};
    var score = snapScore(res["Access Score"]);
    var sm = SCORE_META[score];

    // Additive optional maps (present only when the features ran). Absent =>
    // every helper below is a no-op and the card is byte-for-byte the original.
    var confidence = data.confidence || null;   // { col: {value,agreement,distinct} }
    var spans = data.spans || null;             // { col: {found,quotes:[...]} }
    // W3 cross-check: { col: { primary, validators:[{model,value}], agree_count,
    // total, unanimous } } (legacy {primary,secondary,agree} also tolerated).
    // Present only when the "Cross-check (validators)" toggle ran AND at least
    // one validator succeeded; degrades to fewer/no validators otherwise.
    var consensus = data.consensus || null;

    card.classList.remove("is-error");
    card._data = {
      result: res,
      access_justification: data.access_justification,
      meta: data.meta,
      policy_text: data.policy_text
    };
    if (confidence) card._data.confidence = confidence;
    if (spans) card._data.spans = spans;
    if (consensus) card._data.consensus = consensus;
    // Stash the policy text so evidence quotes can highlight it on demand.
    card._policyText = data.policy_text || "";

    var q = function (sel) { return card.querySelector(sel); };

    q(".result-brand").textContent = res["Brand"] || brand;
    q(".result-file").textContent = res["Filename"] || fallbackFile || "";

    countUp(q(".score-value"), score);
    renderGauge(q(".gauge-svg"), score);

    var bl = q(".score-bucket-label");
    bl.textContent = sm.label;
    bl.style.color = sm.color;
    q(".score-bucket-meaning").textContent = sm.meaning;

    var just = data.access_justification || "No justification was returned by the model.";
    q(".justification-text").textContent = "“" + just + "”";

    // Overall confidence summary + per-Access-Score agreement (runs>1 only).
    renderResultConfidence(card, confidence, data.meta);
    renderScoreConfidence(card, confidence);
    // W3 cross-check: "models agree on X/12 fields" header summary (X = unanimous
    // fields, denominator = consensus-map size = the 12 compared extraction
    // columns; Access Score is excluded). renderScoreConsensus is a defensive
    // no-op (access scoring is primary-only). Both hide their slot when consensus
    // is absent.
    renderResultConsensus(card, consensus);
    renderScoreConsensus(card, consensus);
    // Access-Score evidence quote (explain on only).
    renderFieldEvidence(card, q(".score-evidence-slot"), spans, "Access Score");

    renderBarriers(q(".barrier-chips"), res);
    renderCards(card, res, confidence, spans, consensus);
    renderMeta(card, data);

    // (Re)attach JSON action handlers scoped to this card's data.
    wireCardActions(card);
    return card;
  }

  function renderBrandError(brand, msg) {
    var card = getOrCreateCard(brand);
    fillBrandErrorCard(card, brand, msg);
  }

  // Turn an existing card element into a per-brand error card. Shared by the
  // single-PDF flow and Batch mode (window.PA).
  function fillBrandErrorCard(card, brand, msg) {
    card.classList.add("is-error");
    card._data = null;
    clearChildren(card);
    var head = el("header", "brand-result-head");
    head.appendChild(el("span", "pill pill-brand", brand));
    card.appendChild(head);
    var box = el("div", "brand-error");
    box.appendChild(el("span", "brand-error-icon", "!"));
    var body = el("div", null);
    body.appendChild(el("p", "brand-error-title", "Could not analyze " + brand));
    body.appendChild(el("p", "brand-error-msg", msg || "Unknown error."));
    box.appendChild(body);
    card.appendChild(box);
  }

  // Clone a fresh #result-card-tpl card (NOT attached to the single-PDF run
  // state). Batch mode appends these into its own per-PDF sections.
  function cloneBrandCard(brand) {
    var frag = cardTpl.content.cloneNode(true);
    var card = frag.querySelector(".brand-result");
    card.setAttribute("data-brand", brand);
    return card;
  }

  // Each brand gets a stable card; created on first event for that brand.
  function getOrCreateCard(brand) {
    if (run.cards[brand]) return run.cards[brand];
    var frag = cardTpl.content.cloneNode(true);
    var card = frag.querySelector(".brand-result");
    card.setAttribute("data-brand", brand);
    cardsHost.appendChild(card);
    run.cards[brand] = card;
    show(resultsEl);
    // Signature streamed entrance: scale + fade + slide, staggered.
    animateCardEnter(card, run.cardSeq++);
    return card;
  }

  // =========================================================================
  // render: access score gauge (inline SVG) — scoped to a card's <svg>
  // =========================================================================
  function renderGauge(svg, score) {
    clearChildren(svg);

    var W = 520, padL = 30, padR = 30, trackY = 46, trackH = 16;
    var trackW = W - padL - padR;
    var n = SCORE_STOPS.length;
    var segW = trackW / (n - 1);

    var track = svgEl("rect");
    track.setAttribute("x", padL); track.setAttribute("y", trackY);
    track.setAttribute("width", trackW); track.setAttribute("height", trackH);
    track.setAttribute("rx", trackH / 2);
    track.setAttribute("fill", "var(--surface-3)");
    svg.appendChild(track);

    var activeIndex = SCORE_STOPS.indexOf(score);
    if (activeIndex === -1) activeIndex = 0;

    // Animated progress fill of the track up to the active stop (scaleX via rAF).
    var fillW = segW * activeIndex;
    if (fillW > 0) {
      var fill = svgEl("rect");
      fill.setAttribute("x", padL); fill.setAttribute("y", trackY);
      fill.setAttribute("height", trackH);
      fill.setAttribute("rx", trackH / 2);
      fill.setAttribute("fill", SCORE_META[score].color);
      svg.appendChild(fill);
      sweepFill(fill, fillW);
    }

    // Animated glow halo behind the active marker (opacity fade-in).
    var halo = svgEl("circle");
    var haloCx = padL + segW * activeIndex;
    halo.setAttribute("cx", haloCx);
    halo.setAttribute("cy", trackY + trackH / 2);
    halo.setAttribute("r", 22);
    halo.setAttribute("fill", SCORE_META[score].color);
    halo.setAttribute("opacity", "0");
    halo.style.filter = "blur(8px)";
    svg.appendChild(halo);
    fadeGlow(halo, 0.5);

    SCORE_STOPS.forEach(function (stop, i) {
      var cx = padL + segW * i;
      var meta = SCORE_META[stop];
      var active = stop === score;

      var c = svgEl("circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", trackY + trackH / 2);
      c.setAttribute("r", active ? 15 : 9);
      c.setAttribute("fill", active ? meta.color : "var(--surface)");
      c.setAttribute("stroke", meta.color);
      c.setAttribute("stroke-width", active ? 3 : 2.5);
      svg.appendChild(c);
      if (active) popMarker(c);

      if (active) {
        var pin = svgEl("path");
        pin.setAttribute("d", "M" + cx + " 14 l8 12 h-16 z");
        pin.setAttribute("fill", meta.color);
        svg.appendChild(pin);
        var lbl = svgEl("text");
        lbl.setAttribute("x", cx); lbl.setAttribute("y", 10);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("font-size", "11"); lbl.setAttribute("font-weight", "700");
        lbl.setAttribute("fill", meta.color);
        lbl.textContent = stop;
        svg.appendChild(lbl);
      }

      var num = svgEl("text");
      num.setAttribute("x", cx); num.setAttribute("y", trackY + trackH + 24);
      num.setAttribute("text-anchor", "middle");
      num.setAttribute("font-size", "12");
      num.setAttribute("font-weight", active ? "800" : "600");
      num.setAttribute("fill", active ? "var(--text)" : "var(--text-faint)");
      num.textContent = stop;
      svg.appendChild(num);

      var cap = svgEl("text");
      cap.setAttribute("x", cx); cap.setAttribute("y", trackY + trackH + 40);
      cap.setAttribute("text-anchor", "middle");
      cap.setAttribute("font-size", "9.5");
      cap.setAttribute("fill", active ? meta.color : "var(--text-faint)");
      cap.setAttribute("font-weight", active ? "700" : "500");
      cap.textContent = meta.label;
      svg.appendChild(cap);
    });
  }

  // rAF gauge animations (width-of-an-SVG-rect is fine: it's a tiny offscreen
  // composited element, not a layout-thrashing DOM node).
  function sweepFill(rect, targetW) {
    if (reducedMotion()) { rect.setAttribute("width", targetW); return; }
    var dur = 700, start = null;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      rect.setAttribute("width", (eased * targetW).toFixed(1));
      if (t < 1) requestAnimationFrame(frame);
      else rect.setAttribute("width", targetW);
    }
    requestAnimationFrame(frame);
  }

  function fadeGlow(node, targetOpacity) {
    if (reducedMotion()) { node.setAttribute("opacity", targetOpacity); return; }
    var dur = 650, start = null;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      node.setAttribute("opacity", (t * targetOpacity).toFixed(3));
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function popMarker(circle) {
    if (reducedMotion()) return;
    var r = parseFloat(circle.getAttribute("r")) || 15;
    var dur = 520, start = null;
    function frame(ts) {
      if (start == null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      // overshoot then settle
      var s = t < 1 ? (1 + 0.5 * Math.sin(t * Math.PI) * (1 - t)) : 1;
      circle.setAttribute("r", (r * (0.4 + 0.6 * Math.min(1, t * 1.4)) * s).toFixed(2));
      if (t < 1) requestAnimationFrame(frame);
      else circle.setAttribute("r", r);
    }
    requestAnimationFrame(frame);
  }

  // =========================================================================
  // render: barrier profile
  // =========================================================================
  // present => an active barrier (amber). absent => no barrier (green). unknown => NA.
  function barrierState(raw, presentWhen) {
    if (isNa(raw)) return "unknown";
    return presentWhen(String(raw).trim()) ? "present" : "absent";
  }

  function stepPresent(v) {
    var s = v.toLowerCase();
    if (s === "no" || s === "0") return false;
    var num = Number(v);
    return !isNaN(num) ? num > 0 : true;
  }
  function yesPresent(v) { return v.toLowerCase() === "yes"; }
  function qtyPresent(v) {
    var s = v.toLowerCase();
    return !(s === "no" || s === "none" || s === "0");
  }
  function specialistPresent(v) {
    var s = v.toLowerCase();
    return !(s === "no" || s === "none" || s === "any" || s === "not required" || s === "not specified");
  }

  function buildBarriers(res) {
    var brandedSteps = res["Number of Steps through Brands"];
    var genericSteps = res["Number of Steps through Generic"];
    return [
      { name: "Branded step therapy", value: displayVal(brandedSteps), state: barrierState(brandedSteps, stepPresent) },
      { name: "Generic step therapy", value: displayVal(genericSteps), state: barrierState(genericSteps, stepPresent) },
      { name: "Phototherapy required", value: displayVal(res["Step through-Phototherapy"]), state: barrierState(res["Step through-Phototherapy"], yesPresent) },
      { name: "TB test required", value: displayVal(res["TB Test required"]), state: barrierState(res["TB Test required"], yesPresent) },
      { name: "Quantity limits", value: displayVal(res["Quantity Limits"]), state: barrierState(res["Quantity Limits"], qtyPresent) },
      { name: "Specialist required", value: displayVal(res["Specialist Types"]), state: barrierState(res["Specialist Types"], specialistPresent) },
      { name: "Reauthorization required", value: displayVal(res["Reauthorization Required"]), state: barrierState(res["Reauthorization Required"], yesPresent) }
    ];
  }

  function renderBarriers(wrap, res) {
    clearChildren(wrap);
    buildBarriers(res).forEach(function (b, i) {
      var chip = el("div", "barrier " + b.state);
      if (!reducedMotion()) chip.style.setProperty("--bd", (i * 55) + "ms");
      chip.appendChild(el("span", "b-dot"));
      var txt = el("div", "b-text");
      txt.appendChild(el("span", "b-name", b.name));
      var val = el("span", "b-val", (b.state === "present" ? "Present · " : b.state === "absent" ? "None · " : "") + b.value);
      val.title = b.value;
      txt.appendChild(val);
      chip.appendChild(txt);
      var stateWord = b.state === "present" ? "barrier present" : b.state === "absent" ? "no barrier" : "not specified";
      chip.setAttribute("aria-label", b.name + ": " + stateWord + ", value " + b.value);
      wrap.appendChild(chip);
    });
  }

  // =========================================================================
  // render: parameter cards
  // =========================================================================
  // A parameter card. `col` is the exact deliverable column key (used to look up
  // confidence + spans + consensus); `ctx` carries { confidence, spans, consensus,
  // cardEl } so the card can attach an agreement badge, a cross-check (multi-model
  // agreement) badge + evidence disclosure. When ctx is empty the card is byte-
  // for-byte the original.
  function card(label, value, col, ctx) {
    var c = el("div", "card");
    c.appendChild(el("div", "card-label", label));
    c.appendChild(el("div", "card-value " + valueClass(value), displayVal(value)));

    var conf = ctx && ctx.confidence && col ? ctx.confidence[col] : null;
    if (conf) {
      c.classList.add("has-conf");
      var badge = buildConfBadge(conf);
      badge.classList.add("card-conf");
      c.appendChild(badge);
      c.appendChild(buildConfPopover(conf));
      if (isLowConf(conf.agreement)) c.classList.add("is-lowconf");
    }

    // W3 cross-check badge: distinct from the % confidence badge — a green
    // "n/n" chip when every model agrees on this field, amber "k/n" on any
    // disagreement (with each model's value disclosed on hover/focus). Lives
    // bottom-left so it never collides with the top-right confidence badge.
    var cons = ctx && ctx.consensus && col ? ctx.consensus[col] : null;
    var consAnchor = cons ? buildConsensusAnchor(cons, col, "card-consensus") : null;
    if (consAnchor) {
      c.classList.add("has-consensus");
      c.appendChild(consAnchor);
      var rec = normConsensus(cons);
      if (rec && !rec.unanimous) c.classList.add("is-disagree");
    }

    var span = ctx && ctx.spans && col ? ctx.spans[col] : null;
    if (span) {
      var slot = el("div", null);
      c.appendChild(slot);
      renderFieldEvidence(ctx.cardEl, slot, ctx.spans, col);
    }
    return c;
  }

  function renderCards(cardEl, res, confidence, spans, consensus) {
    var ctx = { confidence: confidence || null, spans: spans || null, consensus: consensus || null, cardEl: cardEl };

    var elig = cardEl.querySelector(".cards-eligibility");
    clearChildren(elig);
    elig.appendChild(card("Age", res["Age"], "Age", ctx));

    var step = cardEl.querySelector(".cards-step");
    clearChildren(step);
    step.appendChild(card("Branded steps", res["Number of Steps through Brands"], "Number of Steps through Brands", ctx));
    step.appendChild(card("Generic steps", res["Number of Steps through Generic"], "Number of Steps through Generic", ctx));
    step.appendChild(card("Phototherapy", res["Step through-Phototherapy"], "Step through-Phototherapy", ctx));
    setLong(cardEl, ".step-requirements", "Step Therapy Requirements Documented in Policy", res, ctx);

    var um = cardEl.querySelector(".cards-um");
    clearChildren(um);
    um.appendChild(card("TB test", res["TB Test required"], "TB Test required", ctx));
    um.appendChild(card("Quantity limits", res["Quantity Limits"], "Quantity Limits", ctx));
    um.appendChild(card("Specialist types", res["Specialist Types"], "Specialist Types", ctx));
    um.appendChild(card("Initial auth (months)", res["Initial Authorization Duration(in-months)"], "Initial Authorization Duration(in-months)", ctx));
    um.appendChild(card("Reauth (months)", res["Reauthorization Duration(in-months)"], "Reauthorization Duration(in-months)", ctx));
    um.appendChild(card("Reauth required", res["Reauthorization Required"], "Reauthorization Required", ctx));
    setLong(cardEl, ".reauth-requirements", "Reauthorization Requirements Documented in Policy", res, ctx);
  }

  // Populate a long-field: its text, an inline confidence badge, and an evidence
  // disclosure. `base` is the shared class prefix (".step-requirements" etc.).
  function setLong(cardEl, base, col, res, ctx) {
    var value = res[col];
    var node = cardEl.querySelector(base + "-text");
    node.textContent = displayVal(value);
    node.classList.toggle("is-na", isNa(value));

    var confSlot = cardEl.querySelector(base + "-conf");
    if (confSlot) {
      clearChildren(confSlot);
      var conf = ctx && ctx.confidence ? ctx.confidence[col] : null;
      if (conf) confSlot.appendChild(buildConfAnchor(conf, "longfield-conf"));
      // W3 cross-check badge for the long field (shares the -conf head slot).
      var cons = ctx && ctx.consensus ? ctx.consensus[col] : null;
      var consAnchor = cons ? buildConsensusAnchor(cons, col, "longfield-consensus") : null;
      if (consAnchor) confSlot.appendChild(consAnchor);
    }

    var evSlot = cardEl.querySelector(base + "-evidence");
    if (evSlot) renderFieldEvidence(cardEl, evSlot, ctx ? ctx.spans : null, col);
  }

  // =========================================================================
  // render: confidence badges + distinct-value popovers
  // =========================================================================
  function confTier(agreement) {
    if (agreement >= CONF_HIGH) return "high";
    if (agreement >= CONF_MID) return "mid";
    return "low";
  }
  function isLowConf(agreement) { return agreement < CONF_FLAG; }
  function confPct(agreement) { return Math.round((Number(agreement) || 0) * 100); }

  function buildConfBadge(conf) {
    var tier = confTier(conf.agreement);
    var badge = el("span", "conf-badge conf-" + tier);
    badge.appendChild(el("span", "conf-dot"));
    badge.appendChild(el("span", "conf-pct", confPct(conf.agreement) + "%"));
    badge.setAttribute("tabindex", "0");
    var n = (conf.distinct && conf.distinct.length) || 1;
    badge.setAttribute("aria-label",
      "Confidence " + confPct(conf.agreement) + "%, " + n + " distinct value" + (n === 1 ? "" : "s") + " across runs");
    return badge;
  }

  // Hover/focus disclosure listing the distinct values seen across runs.
  function buildConfPopover(conf) {
    var pop = el("div", "conf-pop");
    pop.appendChild(el("div", "conf-pop-title", "Values across runs"));
    var ul = document.createElement("ul");
    var distinct = (conf.distinct && conf.distinct.length) ? conf.distinct : [conf.value];
    distinct.forEach(function (v) {
      var li = document.createElement("li");
      li.appendChild(el("span", "cv-val", displayVal(v)));
      if (v === conf.value) li.appendChild(el("span", "cv-count", "majority"));
      ul.appendChild(li);
    });
    pop.appendChild(ul);
    return pop;
  }

  // Overall confidence summary on the result header (mean agreement across the
  // 13 deliverable columns). Hidden entirely when runs<=1 / no confidence map.
  function renderResultConfidence(card, confidence, meta) {
    var slot = card.querySelector(".result-conf");
    if (!slot) return;
    clearChildren(slot);
    slot.className = "result-conf";
    var runs = meta && meta.runs;
    if (!confidence || !(runs > 1)) { slot.hidden = true; return; }

    var vals = [];
    for (var k in confidence) {
      if (confidence.hasOwnProperty(k) && confidence[k] && typeof confidence[k].agreement === "number") {
        vals.push(confidence[k].agreement);
      }
    }
    if (!vals.length) { slot.hidden = true; return; }
    var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    var tier = confTier(mean);
    slot.classList.add("conf-" + tier);
    slot.appendChild(el("span", "rc-label", "Confidence"));
    slot.appendChild(el("span", "rc-num", confPct(mean) + "%"));
    slot.appendChild(el("span", "rc-runs", "· " + runs + " runs"));
    slot.title = "Mean per-field agreement across " + runs + " extraction runs";
    slot.hidden = false;
  }

  // A positioned anchor wrapping a badge + its distinct-values popover, for use
  // outside parameter cards (score header, long fields) where there is no
  // position:relative card to anchor the popover to.
  function buildConfAnchor(conf, extraClass) {
    var anchor = el("span", "conf-anchor" + (extraClass ? " " + extraClass : ""));
    anchor.appendChild(buildConfBadge(conf));
    anchor.appendChild(buildConfPopover(conf));
    return anchor;
  }

  // Agreement badge beside the Access-Score bucket label.
  function renderScoreConfidence(card, confidence) {
    var slot = card.querySelector(".score-conf-slot");
    if (!slot) return;
    clearChildren(slot);
    var conf = confidence ? confidence["Access Score"] : null;
    if (!conf) return;
    slot.appendChild(buildConfAnchor(conf, "score-conf"));
  }

  // =========================================================================
  // render: W3 cross-check (N-validator consensus) badges
  // =========================================================================
  // Per-field cross-check between the canonical extractor (DeepSeek, "primary")
  // and a LIST of validator models (Workers AI). Visually DISTINCT from the %
  // confidence badges: a compact "agree_count/total" chip (green = unanimous,
  // amber = at least one validator disagreed). On disagreement the popover
  // reveals every model's value (primary + each validator, labeled). Rendered
  // only when a `consensus` map is present.
  //
  // Shape (current backend, N validators):
  //   { primary, validators:[{model,value}], agree_count, total, unanimous }
  // We also tolerate the legacy single-secondary shape ({primary, secondary,
  // agree}) so a result saved/exported under the old backend still renders.

  // Coerce either shape into one internal record:
  //   { primary, rows:[{who,value}], agree:int, total:int, unanimous:bool }
  // `rows` is the ordered model list for the disclosure (primary first, then
  // each validator). Returns null for an empty/invalid field entry.
  function normConsensus(cons) {
    if (!cons || typeof cons !== "object") return null;
    var primary = cons.primary;
    var rows = [{ who: "DeepSeek · canonical", value: primary }];

    if (Array.isArray(cons.validators)) {
      // New N-validator shape.
      cons.validators.forEach(function (v) {
        if (!v) return;
        rows.push({ who: modelLabel(v.model), value: v.value });
      });
      var total = (typeof cons.total === "number") ? cons.total : rows.length;
      var agree = (typeof cons.agree_count === "number") ? cons.agree_count
        : (cons.unanimous ? total : 0);
      var unanimous = (typeof cons.unanimous === "boolean")
        ? cons.unanimous : (agree === total && total > 0);
      return { primary: primary, rows: rows, agree: agree, total: total, unanimous: unanimous };
    }

    // Legacy single-secondary shape ({primary, secondary, agree}).
    if ("secondary" in cons || "agree" in cons) {
      rows.push({ who: "2nd model", value: cons.secondary });
      var agreeL = !!cons.agree;
      return { primary: primary, rows: rows, agree: agreeL ? 2 : 1, total: 2, unanimous: agreeL };
    }
    return null;
  }

  // Short, readable label for a Workers AI model id like
  // "@cf/meta/llama-3.3-70b-instruct-fp8-fast" -> "llama-3.3-70b". Falls back to
  // the raw id (or "validator") so an unexpected value still renders.
  function modelLabel(model) {
    var raw = (model == null ? "" : String(model)).trim();
    if (!raw) return "validator";
    var tail = raw.replace(/^@?cf\//i, "");           // drop "@cf/" provider prefix
    var slash = tail.lastIndexOf("/");
    if (slash >= 0) tail = tail.slice(slash + 1);      // keep the model name segment
    // Trim common Workers AI quantization/speed suffixes for readability.
    tail = tail.replace(/-(fp8|fp16|int8|int4|awq)(-fast)?$/i, "")
               .replace(/-instruct$/i, "");
    return tail || raw;
  }

  // A standalone "agree_count/total" chip: green when unanimous, amber when any
  // validator disagreed. `tabindex` makes the disclosure keyboard-reachable; the
  // aria-label spells out the agreement and the canonical value.
  function buildConsensusBadge(rec) {
    var ok = rec.unanimous;
    var badge = el("span", "consensus-badge " + (ok ? "consensus-agree" : "consensus-disagree"));
    badge.appendChild(el("span", "consensus-glyph", ok ? "✓" : "≈"));
    badge.appendChild(el("span", "consensus-count", rec.agree + "/" + rec.total));
    badge.setAttribute("tabindex", "0");
    badge.setAttribute("role", "img");
    var p = displayVal(rec.primary);
    badge.setAttribute("aria-label", ok
      ? ("All " + rec.total + " models agree (“" + p + "”)")
      : (rec.agree + " of " + rec.total + " models agree; canonical value “" + p + "”. See per-model values."));
    return badge;
  }

  // Hover/focus disclosure listing every model's value for one field (primary
  // first, then each validator, labeled). Reuses the .consensus-pop structure.
  function buildConsensusPopover(rec, col) {
    var pop = el("div", "consensus-pop");
    pop.appendChild(el("div", "consensus-pop-title",
      rec.unanimous ? "All models agree" : "Models disagree (" + rec.agree + "/" + rec.total + ")"));
    var ul = document.createElement("ul");
    var canon = rec.primary;
    rec.rows.forEach(function (row, i) {
      var li = document.createElement("li");
      // Flag validators whose value differs from the canonical (primary) one.
      if (i > 0 && String(row.value) !== String(canon)) li.className = "cs-diff";
      li.appendChild(el("span", "cs-who", row.who));
      li.appendChild(el("span", "cs-val", displayVal(row.value)));
      ul.appendChild(li);
    });
    pop.appendChild(ul);
    if (col) pop.appendChild(el("div", "consensus-pop-field subtle", fieldLabel(col)));
    return pop;
  }

  // Positioned anchor wrapping badge + popover (so the popover anchors to the
  // badge wherever it sits — parameter card, score header, etc.). Accepts the
  // RAW per-field consensus entry; normalizes it here so every call site (card,
  // long field, score header) shares one path. Returns null for an empty entry.
  function buildConsensusAnchor(cons, col, extraClass) {
    var rec = normConsensus(cons);
    if (!rec) return null;
    var anchor = el("span", "consensus-anchor" + (extraClass ? " " + extraClass : ""));
    anchor.appendChild(buildConsensusBadge(rec));
    anchor.appendChild(buildConsensusPopover(rec, col));
    return anchor;
  }

  // "models agree on X/12 fields" header summary. X = number of UNANIMOUS fields
  // (every model produced the same normalized value); the denominator is the
  // real consensus-map size — the extraction columns actually compared (the 12;
  // Access Score is excluded from consensus, so it is typically 12, never 13).
  // A renamed/added backend column is reflected automatically. Hidden entirely
  // when no consensus map.
  function renderResultConsensus(card, consensus) {
    var slot = card.querySelector(".result-consensus");
    if (!slot) return;
    clearChildren(slot);
    slot.className = "result-consensus";
    if (!consensus) { slot.hidden = true; return; }

    var total = 0, unanimous = 0;
    for (var k in consensus) {
      if (!consensus.hasOwnProperty(k) || !consensus[k]) continue;
      var rec = normConsensus(consensus[k]);
      if (!rec) continue;
      total++;
      if (rec.unanimous) unanimous++;
    }
    if (!total) { slot.hidden = true; return; }

    var allAgree = unanimous === total;
    slot.classList.add(allAgree ? "consensus-all" : "consensus-some");
    slot.appendChild(el("span", "rcs-glyph", allAgree ? "✓" : "≈"));
    slot.appendChild(el("span", "rcs-label", "Models agree on"));
    slot.appendChild(el("span", "rcs-num", unanimous + "/" + total));
    slot.appendChild(el("span", "rcs-tail", "fields"));
    slot.title = "All models produced the same value on " + unanimous +
      " of " + total + " extracted fields. Fields with any disagreement are flagged.";
    slot.hidden = false;
  }

  // Cross-check badge beside the Access-Score bucket label. NOTE: access scoring
  // stays primary-only, so the backend never emits a consensus entry for
  // "Access Score" — this is a defensive no-op that renders one only if a future
  // backend ever did (buildConsensusAnchor returns null for an empty entry).
  function renderScoreConsensus(card, consensus) {
    var slot = card.querySelector(".score-conf-slot");
    if (!slot) return;
    var cons = consensus ? consensus["Access Score"] : null;
    if (!cons) return;
    var anchor = buildConsensusAnchor(cons, "Access Score", "score-consensus");
    if (anchor) slot.appendChild(anchor);
  }

  // =========================================================================
  // render: source-span (evidence) disclosure
  // =========================================================================
  // Renders an "evidence" toggle into `slot` for column `col`. found=false ->
  // a muted "not stated in policy"; otherwise an expandable verbatim quote that,
  // when clicked, highlights itself inside the card's policy-text viewer.
  function renderFieldEvidence(card, slot, spans, col) {
    if (!slot) return;
    clearChildren(slot);
    var span = spans ? spans[col] : null;
    if (!span) return;

    var quotes = (span.quotes || []).filter(function (q) { return q && String(q).trim(); });
    var found = !!span.found && quotes.length > 0;

    var wrap = el("div", "evidence" + (found ? "" : " is-empty"));
    var btn = el("button", "evidence-toggle");
    btn.type = "button";
    var qi = svgEl("svg");
    qi.setAttribute("class", "ev-quote-icon");
    qi.setAttribute("viewBox", "0 0 24 24");
    qi.setAttribute("aria-hidden", "true");
    var qp = svgEl("path");
    qp.setAttribute("fill", "currentColor");
    qp.setAttribute("d", "M7 7h4v4H8c0 2 1 3 3 3v3c-3 0-6-2-6-6V7zm9 0h4v4h-3c0 2 1 3 3 3v3c-3 0-6-2-6-6V7z");
    qi.appendChild(qp);
    btn.appendChild(qi);
    btn.appendChild(el("span", "ev-label", found ? "Evidence" : "Evidence — not stated"));
    var caret = el("span", "ev-caret");
    btn.appendChild(caret);
    wrap.appendChild(btn);

    var body = el("div", "evidence-body");
    if (found) {
      quotes.forEach(function (qtext) {
        var qel = el("blockquote", "evidence-quote", qtext);
        qel.setAttribute("tabindex", "0");
        qel.title = "Click to highlight in the source text below";
        var go = function () { highlightInPolicy(card, qtext); };
        qel.addEventListener("click", go);
        qel.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
        });
        body.appendChild(qel);
      });
    } else {
      body.appendChild(el("p", "evidence-none", "Not stated in policy."));
    }
    wrap.appendChild(body);

    var btnId = "ev-btn-" + (++evidenceSeq);
    var bodyId = "ev-body-" + evidenceSeq;
    btn.id = btnId; body.id = bodyId;
    btn.setAttribute("aria-controls", bodyId);
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function () { toggleEvidence(wrap, body, btn); });

    slot.appendChild(wrap);
  }

  // Expand/collapse an evidence body, animating max-height/opacity (then settle
  // to auto so it reflows if the source text changes). reduced-motion snaps.
  function toggleEvidence(wrap, body, btn) {
    var open = wrap.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (reducedMotion()) {
      body.style.maxHeight = open ? "none" : "0";
      body.style.opacity = open ? "1" : "0";
      return;
    }
    if (open) {
      body.style.maxHeight = body.scrollHeight + "px";
      body.style.opacity = "1";
      var onEnd = function (e) {
        if (e.propertyName !== "max-height") return;
        body.style.maxHeight = "none";
        body.removeEventListener("transitionend", onEnd);
      };
      body.addEventListener("transitionend", onEnd);
    } else {
      // from auto/none back to a pixel height so the transition has a start value
      body.style.maxHeight = body.scrollHeight + "px";
      // force reflow then collapse
      void body.offsetHeight;
      body.style.maxHeight = "0";
      body.style.opacity = "0";
    }
  }

  // Highlight a verbatim quote inside this card's policy-text <pre> viewer,
  // opening the collapsible viewer and scrolling the match into view.
  function highlightInPolicy(card, quote) {
    var details = card.querySelector(".policy-text");
    var pre = card.querySelector(".policy-text-pre");
    if (!pre) return;
    var full = card._policyText || pre.textContent || "";
    var idx = findQuoteIndex(full, quote);
    // Reset the viewer to plain text, then re-render with the match wrapped.
    if (idx === -1) {
      pre.textContent = full;
      if (details) details.open = true;
      return;
    }
    var qlen = matchedQuoteLength(full, quote, idx);
    clearChildren(pre);
    pre.appendChild(document.createTextNode(full.slice(0, idx)));
    var mark = el("mark", "span-hit", full.slice(idx, idx + qlen));
    pre.appendChild(mark);
    pre.appendChild(document.createTextNode(full.slice(idx + qlen)));
    if (details) details.open = true;
    // Scroll the highlight into view inside the scrollable <pre>.
    requestAnimationFrame(function () {
      if (mark.scrollIntoView) mark.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    });
  }

  // Locate a quote in the policy text, tolerant of whitespace differences. Tries
  // an exact match first, then a whitespace-collapsed match. Returns -1 if absent.
  function findQuoteIndex(haystack, needle) {
    if (!needle) return -1;
    var i = haystack.indexOf(needle);
    if (i !== -1) return i;
    // Trim and retry on a shorter core (LLM quotes sometimes add trailing punct).
    var trimmed = needle.trim();
    if (trimmed && trimmed !== needle) {
      i = haystack.indexOf(trimmed);
      if (i !== -1) return i;
    }
    // Whitespace-tolerant: collapse runs of whitespace in both and map back.
    return fuzzyWhitespaceIndex(haystack, trimmed || needle);
  }

  // The length of the substring in `haystack` (from `idx`) that corresponds to
  // the quote — exact length when an exact match, else recomputed for the fuzzy
  // case via the same whitespace-collapsing walk.
  function matchedQuoteLength(haystack, needle, idx) {
    var trimmed = needle.trim();
    if (haystack.substr(idx, needle.length) === needle) return needle.length;
    if (trimmed && haystack.substr(idx, trimmed.length) === trimmed) return trimmed.length;
    return fuzzyWhitespaceLength(haystack, trimmed || needle, idx);
  }

  // Find the start index of `needle` in `haystack` ignoring whitespace-run
  // differences. Returns the index in the ORIGINAL haystack, or -1.
  function fuzzyWhitespaceIndex(haystack, needle) {
    var nNorm = needle.replace(/\s+/g, " ").trim();
    if (!nNorm) return -1;
    var hLen = haystack.length, nLen = nNorm.length;
    for (var start = 0; start < hLen; start++) {
      if (/\s/.test(haystack[start])) continue;
      var hi = start, ni = 0, ok = true;
      while (ni < nLen) {
        if (ni > 0 && nNorm[ni] === " ") {
          if (!/\s/.test(haystack[hi])) { ok = false; break; }
          while (hi < hLen && /\s/.test(haystack[hi])) hi++;
          ni++;
          continue;
        }
        if (hi >= hLen || haystack[hi].toLowerCase() !== nNorm[ni].toLowerCase()) { ok = false; break; }
        hi++; ni++;
      }
      if (ok) return start;
    }
    return -1;
  }

  // Length in the original haystack of the fuzzy match starting at idx.
  function fuzzyWhitespaceLength(haystack, needle, idx) {
    var nNorm = needle.replace(/\s+/g, " ").trim();
    var hLen = haystack.length, nLen = nNorm.length;
    var hi = idx, ni = 0;
    while (ni < nLen) {
      if (ni > 0 && nNorm[ni] === " ") {
        while (hi < hLen && /\s/.test(haystack[hi])) hi++;
        ni++;
        continue;
      }
      if (hi >= hLen) break;
      hi++; ni++;
    }
    return Math.max(1, hi - idx);
  }

  // =========================================================================
  // render: meta strip
  // =========================================================================
  function renderMeta(cardEl, data) {
    var meta = data.meta || {};
    var src = meta.source || "unknown";
    var srcLabel = src === "reduced" ? "Source: reduced text" :
                   src === "markdown-fallback" ? "Source: markdown fallback" :
                   src === "reduced-error" ? "Source: reduced (with error)" : "Source: " + src;
    if (typeof meta.reduction_pct === "number") srcLabel += " · " + meta.reduction_pct + "% reduction";
    cardEl.querySelector(".meta-source").textContent = srcLabel;
    cardEl.querySelector(".meta-model").textContent = "Model: " + (meta.model || "—");

    var stats = cardEl.querySelector(".meta-stats");
    clearChildren(stats);
    var t = meta.timings_ms || {};
    var rows = [
      ["Docling OCR", fmtMs(t.docling_ms)],
      ["Reduce", fmtMs(t.reduce_ms)],
      ["Extract", fmtMs(t.extract_ms)],
      ["Score", fmtMs(t.score_ms)],
      ["Full chars", fmtNum(meta.full_markdown_chars)],
      ["Reduced chars", fmtNum(meta.reduced_chars)]
    ];
    // Additive meta: show the run count when deep confidence ran (>1) and the
    // source-span pass duration when it ran. Omitted otherwise (identical to old).
    if (meta.runs > 1) rows.push(["Runs", fmtNum(meta.runs)]);
    if (typeof t.spans_ms === "number") rows.push(["Evidence", fmtMs(t.spans_ms)]);
    rows.forEach(function (r) {
      var s = el("div", "stat");
      s.appendChild(el("div", "stat-k", r[0]));
      s.appendChild(el("div", "stat-v", r[1]));
      stats.appendChild(s);
    });

    cardEl.querySelector(".policy-text-pre").textContent = data.policy_text || "(no focused text returned)";
  }

  // =========================================================================
  // per-card JSON copy / download
  // =========================================================================
  function wireCardActions(cardEl) {
    var copyBtn = cardEl.querySelector(".copy-json");
    var dlBtn = cardEl.querySelector(".download-json");
    var status = cardEl.querySelector(".copy-status");

    copyBtn.onclick = function () {
      var data = cardEl._data;
      if (!data) return;
      var text = JSON.stringify(data, null, 2);
      function done() { status.textContent = "Copied!"; setTimeout(function () { status.textContent = ""; }, 1800); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, status, done); });
      } else { fallbackCopy(text, status, done); }
    };

    dlBtn.onclick = function () {
      var data = cardEl._data;
      if (!data) return;
      var res = data.result || {};
      var base = (res["Brand"] || "policy") + "_" + (res["Filename"] || "result");
      var name = base.replace(/[^a-z0-9._-]+/gi, "_").replace(/\.pdf$/i, "") + ".json";
      // CSP-safe download: a data:application/json URI on an <a download> works
      // under default-src 'self' (the per-brand JSON is small). This avoids any
      // dependence on blob:/createObjectURL navigation rules.
      var json = JSON.stringify(data, null, 2);
      var url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
      var a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    };
  }

  function fallbackCopy(text, status, done) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { status.textContent = "Copy failed"; }
    document.body.removeChild(ta);
  }

  // =========================================================================
  // multi-brand comparison table
  // =========================================================================
  function compareValue(res, key, presentWhen) {
    var raw = res[key];
    var state = barrierState(raw, presentWhen);
    return { value: displayVal(raw), state: state };
  }

  function updateComparison() {
    if (!run || run.results.length <= 1) { hide(comparisonEl); return; }
    show(comparisonEl);
    revealNow(comparisonEl);
    clearChildren(compareBody);

    run.results.forEach(function (item, i) {
      var res = item.data.result || {};
      var score = snapScore(res["Access Score"]);
      var tr = document.createElement("tr");
      if (!reducedMotion()) tr.style.setProperty("--rd", (i * 60) + "ms");

      var tdBrand = el("td", null);
      tdBrand.appendChild(el("span", "pill pill-brand", res["Brand"] || item.brand));
      tr.appendChild(tdBrand);

      var tdScore = el("td", null);
      var chip = el("span", "score-chip", String(score));
      var chipMeta = SCORE_META[score] || SCORE_META[0];
      chip.style.background = chipMeta.color;
      chip.style.color = chipMeta.fg;
      tdScore.appendChild(chip);
      tr.appendChild(tdScore);

      tr.appendChild(compareCell(compareValue(res, "Number of Steps through Brands", stepPresent)));
      tr.appendChild(compareCell(compareValue(res, "Number of Steps through Generic", stepPresent)));
      tr.appendChild(compareCell(compareValue(res, "Step through-Phototherapy", yesPresent)));
      tr.appendChild(compareCell(compareValue(res, "TB Test required", yesPresent)));
      tr.appendChild(compareCell(compareValue(res, "Specialist Types", specialistPresent)));
      tr.appendChild(compareCell(compareValue(res, "Reauthorization Required", yesPresent)));

      compareBody.appendChild(tr);
    });
  }

  function compareCell(cv) {
    var td = el("td", null);
    var span = el("span", "cmp-val cmp-" + cv.state, cv.value);
    span.title = cv.value;
    td.appendChild(span);
    return td;
  }

  // =========================================================================
  // session history + distribution chart
  // =========================================================================
  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-200))); } catch (e) { /* ignore quota */ }
  }

  function keyBarriers(res) {
    return buildBarriers(res)
      .filter(function (b) { return b.state === "present"; })
      .map(function (b) { return b.name.replace(/ required| therapy/i, ""); });
  }

  function addHistory(data) {
    var res = data.result || {};
    var entry = {
      brand: res["Brand"] || data.brand,
      file: res["Filename"] || (selectedFile ? selectedFile.name : ""),
      score: snapScore(res["Access Score"]),
      barriers: keyBarriers(res),
      ts: Date.now()
    };
    history.push(entry);
    saveHistory();
    renderHistory();
  }

  function clearHistory() {
    history = [];
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    if (!history.length) { hide(sessionPanel); return; }
    show(sessionPanel);
    revealNow(sessionPanel);

    $("history-count").textContent = history.length;
    var body = $("history-body");
    clearChildren(body);
    history.slice().reverse().forEach(function (h) {
      var tr = document.createElement("tr");

      var tdBrand = el("td", null);
      tdBrand.appendChild(el("span", "pill pill-brand", h.brand));
      tr.appendChild(tdBrand);

      var tdFile = el("td", null, h.file || "—");
      tdFile.title = h.file || "";
      tr.appendChild(tdFile);

      var tdScore = el("td", null);
      var chip = el("span", "score-chip", String(h.score));
      var chipMeta = SCORE_META[h.score] || SCORE_META[0];
      chip.style.background = chipMeta.color;
      chip.style.color = chipMeta.fg;
      tdScore.appendChild(chip);
      tr.appendChild(tdScore);

      var barrierText = h.barriers && h.barriers.length ? h.barriers.join(", ") : "None";
      var tdBar = el("td", null);
      var bm = el("span", "barrier-mini", barrierText);
      bm.title = barrierText;
      tdBar.appendChild(bm);
      tr.appendChild(tdBar);

      var d = new Date(h.ts);
      tr.appendChild(el("td", null, d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));

      body.appendChild(tr);
    });

    renderDistribution();
  }

  // Distribution reflects THIS analysis when one is present, else the session.
  function renderDistribution() {
    var svg = $("dist-chart");
    clearChildren(svg);

    // clearChildren() removed the <title> that provides this chart's accessible
    // name (svg[aria-labelledby="dist-title"]); re-insert it as the first child.
    var distTitle = svgEl("title");
    distTitle.setAttribute("id", "dist-title");
    distTitle.textContent = "Distribution of access scores";
    svg.appendChild(distTitle);

    var useRun = run && run.results.length > 0;
    var scores;
    if (useRun) {
      scores = run.results.map(function (r) { return snapScore((r.data.result || {})["Access Score"]); });
      distScope.textContent = "· this analysis (" + scores.length + ")";
    } else {
      scores = history.map(function (h) { return h.score; });
      distScope.textContent = history.length ? "· session (" + history.length + ")" : "";
    }

    var counts = {};
    SCORE_STOPS.forEach(function (s) { counts[s] = 0; });
    scores.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
    var max = Math.max.apply(null, SCORE_STOPS.map(function (s) { return counts[s]; }).concat([1]));

    var W = 320, H = 180, padL = 28, padB = 38, padT = 14, padR = 10;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = SCORE_STOPS.length;
    var slot = plotW / n;
    var barW = slot * 0.6;

    var axis = svgEl("line");
    axis.setAttribute("x1", padL); axis.setAttribute("y1", padT + plotH);
    axis.setAttribute("x2", padL + plotW); axis.setAttribute("y2", padT + plotH);
    axis.setAttribute("stroke", "var(--border-strong)"); axis.setAttribute("stroke-width", "1");
    svg.appendChild(axis);

    SCORE_STOPS.forEach(function (stop, i) {
      var c = counts[stop];
      var h = c > 0 ? (c / max) * plotH : 0;
      var x = padL + slot * i + (slot - barW) / 2;
      var y = padT + plotH - h;

      var rect = svgEl("rect");
      rect.setAttribute("class", "bar");
      rect.setAttribute("x", x); rect.setAttribute("y", c > 0 ? y : padT + plotH - 2);
      rect.setAttribute("width", barW); rect.setAttribute("height", c > 0 ? h : 2);
      rect.setAttribute("rx", 4);
      rect.setAttribute("fill", SCORE_META[stop].color);
      rect.setAttribute("opacity", c > 0 ? "0.92" : "0.25");
      var title = svgEl("title");
      title.textContent = SCORE_META[stop].label + ": " + c;
      rect.appendChild(title);
      svg.appendChild(rect);
      // Grow from 0 height via transform scaleY (GPU compositable, no layout).
      if (c > 0 && !reducedMotion()) {
        rect.style.transformBox = "fill-box";
        rect.style.transformOrigin = "bottom";
        rect.style.transform = "scaleY(0)";
        rect.style.transition = "transform .55s var(--ease-spring)";
        rect.style.transitionDelay = (i * 70) + "ms";
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { rect.style.transform = "scaleY(1)"; });
        });
      }

      if (c > 0) {
        var cnt = svgEl("text");
        cnt.setAttribute("x", x + barW / 2); cnt.setAttribute("y", y - 4);
        cnt.setAttribute("text-anchor", "middle"); cnt.setAttribute("font-size", "11");
        cnt.setAttribute("font-weight", "700"); cnt.setAttribute("fill", "var(--text)");
        cnt.textContent = c;
        svg.appendChild(cnt);
      }

      var lbl = svgEl("text");
      lbl.setAttribute("x", x + barW / 2); lbl.setAttribute("y", padT + plotH + 14);
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-size", "10");
      lbl.setAttribute("font-weight", "700"); lbl.setAttribute("fill", "var(--text-muted)");
      lbl.textContent = stop;
      svg.appendChild(lbl);

      var sub = svgEl("text");
      sub.setAttribute("x", x + barW / 2); sub.setAttribute("y", padT + plotH + 26);
      sub.setAttribute("text-anchor", "middle"); sub.setAttribute("font-size", "8");
      sub.setAttribute("fill", "var(--text-faint)");
      sub.textContent = SCORE_META[stop].label;
      svg.appendChild(sub);
    });
  }

  // =========================================================================
  // wire up events
  // =========================================================================
  function bind() {
    // dropzone
    dropzone.addEventListener("click", function (e) {
      if (e.target === fileClear) return;
      fileInput.click();
    });
    dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); dropzone.classList.add("dragover"); });
    });
    ["dragleave", "dragend"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("dragover"); });
    });
    dropzone.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("dragover");
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files[0]) setFile(dt.files[0]);
    });
    fileClear.addEventListener("click", function (e) { e.stopPropagation(); clearFile(); });

    // brand picker
    brandSearch.addEventListener("input", renderBrandList);
    brandSearch.addEventListener("keydown", function (e) {
      if (e.key === "Enter") e.preventDefault();
    });
    selectAllBtn.addEventListener("click", toggleSelectAll);

    analyzeBtn.addEventListener("click", analyze);
    $("clear-history").addEventListener("click", clearHistory);

    // Toggles affect the library cache key (runs / explain / consensus) —
    // re-check the hint.
    if (deepConfidenceToggle) deepConfidenceToggle.addEventListener("change", notifySingleContext);
    if (sourceQuotesToggle) sourceQuotesToggle.addEventListener("change", notifySingleContext);
    if (consensusToggle) consensusToggle.addEventListener("change", notifySingleContext);

    // prevent the browser from opening a PDF dropped outside the dropzone
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) {
      if (!dropzone.contains(e.target)) e.preventDefault();
    });
  }

  // =========================================================================
  // public surface for the additive Batch mode (public/batch.js)
  // =========================================================================
  // Batch mode is a separate, opt-in flow that REUSES the per-brand renderers
  // and the #result-card-tpl template defined here, so there is exactly one
  // implementation of a result card. Nothing below alters the single-PDF live
  // flow, which remains the default. The export is namespaced under window.PA
  // and is the ONLY thing this IIFE leaks.
  window.PA = {
    BRANDS: BRANDS.slice(),
    SCORE_STOPS: SCORE_STOPS.slice(),
    SCORE_META: SCORE_META,
    DEEP_RUNS: DEEP_RUNS,
    MAX_BYTES: MAX_BYTES,
    // formatting + classification helpers
    fmtBytes: fmtBytes,
    fmtMs: fmtMs,
    fmtNum: fmtNum,
    snapScore: snapScore,
    displayVal: displayVal,
    reducedMotion: reducedMotion,
    rafCoalesce: rafCoalesce,
    // dom helpers
    el: el,
    svgEl: svgEl,
    clearChildren: clearChildren,
    show: show,
    hide: hide,
    revealNow: revealNow,
    animateCardEnter: animateCardEnter,
    // sticky-routing key (sha256 hex of a File/Blob) — same as single flow
    computeRouteHex: computeRouteHex,
    // result-card factory + renderers (clone -> populate)
    cloneBrandCard: cloneBrandCard,
    populateBrandCard: populateBrandCard,
    fillBrandErrorCard: fillBrandErrorCard,
    // analytics building blocks (shared with the session dashboard)
    buildBarriers: buildBarriers,
    keyBarriers: keyBarriers,
    compareValue: compareValue,
    compareCell: compareCell,
    stepPresent: stepPresent,
    yesPresent: yesPresent,
    specialistPresent: specialistPresent,
    // ---- persistent-library hooks (consumed by public/library.js) ----
    // Register a callback fired when a SINGLE analysis finishes, so library.js
    // can POST /api/library. Payload: { results:[ExtractResult...], runs,
    // explain, filename, fileSha256Promise }.
    onSingleDone: function (cb) { if (typeof cb === "function") singleDoneCbs.push(cb); },
    // Register a callback fired when a SINGLE analysis BEGINS (reset stale UI).
    onSingleStart: function (cb) { if (typeof cb === "function") singleStartCbs.push(cb); },
    // Register a callback fired whenever the single-mode selection changes, so
    // library.js can offer a cached-result hint. Payload: getSingleContext().
    onSingleContextChange: function (cb) {
      if (typeof cb === "function") { singleContextCbs.push(cb); cb(getSingleContext()); }
    },
    getSingleContext: getSingleContext
  };

  // ---- init ---------------------------------------------------------------
  initTheme();
  setBrands(BRANDS);
  refreshBrands();
  renderHistory();
  bind();
  initReveals();
})();
