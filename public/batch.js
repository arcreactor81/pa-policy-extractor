/* =========================================================================
   Prior-Authorization Access Analyzer — batch.js  (Layer 3, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /batch.js, no inline code).

   Batch mode: queue several PDFs as a persistent, reconnectable server-side
   job (JobCoordinator Durable Object + R2), streamed over a reconnectable
   WebSocket. The SINGLE-PDF live flow in app.js stays the default and is left
   completely unchanged; this file only adds behaviour and REUSES app.js's
   per-brand renderers (window.PA) + the #result-card-tpl template, so a result
   card has exactly one implementation.

   Job API consumed here (provided by the Worker + JobCoordinator DO):
     POST /api/jobs/stage      JSON config + manifest -> staged upload session
     PUT  /api/jobs/stage/:id/files/:index
                                 raw PDF body -> final deterministic R2 key
     POST /api/jobs/stage/:id/start
                                 verify uploads + start -> 202 { "jobId": "<uuid>" }
     GET  /api/jobs/:id          -> JSON job state (poll fallback)
     GET  /api/jobs/:id/stream?lastSeq=N   -> WebSocket upgrade (DO replays
                                 events with seq_num > N, then streams live)
     GET  /api/results?jobId=..  -> finished aggregated results JSON (404 if absent)

   Each streamed event is the container's AnalyzeEvent object PLUS
   { pdf_index, filename, seq_num }, and a terminal { event:"job_done", ... }.
   ========================================================================= */
(function () {
  "use strict";

  // The shared surface app.js exports. If it is somehow absent (app.js failed
  // to load), bail quietly — single mode keeps working, batch stays dormant.
  var PA = window.PA;
  var BatchState = window.PABatchState;
  if (!PA || !BatchState) return;

  // ---- constants ----------------------------------------------------------
  var MAX_BYTES = PA.MAX_BYTES || 20 * 1024 * 1024;
  // Default cap; the server is authoritative. Surfaced in the UI + soft-checked
  // client-side. Mirrors MAX_PDFS_PER_JOB.
  var MAX_PDFS_PER_JOB = 25;
  var DEEP_RUNS = PA.DEEP_RUNS || 3;

  // Each individual PDF upload gets two retries after its initial attempt.
  var UPLOAD_RETRIES = 2;
  var UPLOAD_RETRY_BASE = 650;

  // localStorage keys.
  var JOBS_KEY = "pa_jobs_v1";                   // recent jobIds (small history)

  // Reconnect backoff (ms): exponential with a cap + jitter.
  var RECONNECT_BASE = 1000;
  var RECONNECT_MAX = 15000;

  var $ = function (id) { return document.getElementById(id); };

  // ---- element refs -------------------------------------------------------
  var modeSingleBtn = $("mode-single");
  var modeBatchBtn = $("mode-batch");

  var batchDropzone = $("batch-dropzone");
  var batchFileInput = $("batch-file-input");
  var batchFileList = $("batch-file-list");
  var batchFileCount = $("batch-file-count");
  var batchMaxPdfsEl = $("batch-max-pdfs");

  var batchSubmitBtn = $("batch-submit-btn");
  var batchSubmitLabel = $("batch-submit-label");

  // shared controls (owned by app.js DOM, read here)
  var deepConfidenceToggle = $("deep-confidence");
  var sourceQuotesToggle = $("source-quotes");
  var consensusToggle = $("consensus-toggle");

  var jobPanel = $("batch-job");
  var connDot = $("batch-conn-dot");
  var statusText = $("batch-status-text");
  var connText = $("batch-conn-text");
  var copyLinkBtn = $("batch-copy-link");
  var downloadAllBtn = $("batch-download-all");
  var copyStatus = $("batch-copy-status");
  var batchJobActions = downloadAllBtn ? downloadAllBtn.parentNode : null;

  var progFill = $("batch-prog-fill");
  var progBar = progFill ? progFill.parentNode : null;
  var doneCountEl = $("batch-done-count");
  var totalCountEl = $("batch-total-count");
  var failedCountEl = $("batch-failed-count");
  var brandsCountEl = $("batch-brands-count");
  var batchElapsedEl = $("batch-elapsed");

  var batchErrorBox = $("batch-error");
  var batchErrorMessage = $("batch-error-message");

  var batchComparison = $("batch-comparison");
  var batchCompareBody = $("batch-compare-body");
  var batchDist = $("batch-dist");
  var batchDistScope = $("batch-dist-scope");

  var batchResults = $("batch-results");
  var batchResultsHost = $("batch-results-host");
  var pdfSectionTpl = $("batch-pdf-section-tpl");

  // The brand picker + toggles live in app.js. We read the user's selection by
  // scraping the rendered chips (the source of truth the user sees).
  var brandChipsHost = $("brand-chips");

  // ---- state --------------------------------------------------------------
  var mode = "single";          // "single" | "batch"
  var batchFiles = [];          // File[] queued for submission
  var submitting = false;

  // W5 cohorts: listeners notified when a batch job finishes (best-effort hook
  // so public/cohorts.js can offer "Save as cohort" on a finished job without
  // reaching into batch internals). Each callback gets a small, read-only
  // descriptor { jobId, total, completed, failed, brandsPerPdf }.
  var jobDoneCbs = [];

  // Active job runtime state (null when no job loaded).
  var job = null;
  function newJobState(jobId) {
    return {
      id: jobId,
      ws: null,
      // ALWAYS start a fresh in-memory session at seq 0 so the WS replays the
      // full event log and rebuilds every per-PDF section + brand card. A new
      // job state always corresponds to an empty DOM (fresh page load via
      // #job-<id>, a hashchange to a different job, or a brand-new submission),
      // so we must NOT seed from the stored lastSeq — doing so makes the DO skip
      // the start/ocr_done/result events of PDFs that finished before a reload,
      // leaving their sections + brand cards (and the aggregates) unbuilt. The
      // stored lastSeq is only meaningful for socket RECONNECTS within this same
      // live session, and those reuse the in-memory job.lastSeq (advanced as
      // events arrive), never this initial value.
      lastSeq: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      closedByUs: false,
      done: false,
      t0: Date.now(),
      elapsedTimer: null,
      totalPdfs: 0,
      completedPdfs: 0,
      failedPdfs: 0,
      brandsPerPdf: null,
      // pdf_index -> { section, name, cardsHost, cards:{brand->card}, status, done, failed }
      pdfs: {},
      eventState: BatchState.createBatchState(),
      // ordered list of { pdfIndex, filename, brand, data } result rows for aggregation
      results: [],
      cardSeq: 0
    };
  }

  // =========================================================================
  // localStorage helpers
  // =========================================================================
  // (The per-job lastSeq is intentionally NOT persisted: each in-memory session
  // starts at seq 0 and replays the full event log to rebuild the DOM, and live
  // socket reconnects resume from the in-memory job.lastSeq. Persisting a high
  // lastSeq across reloads would make the DO skip already-completed PDFs.)
  function rememberJob(jobId) {
    try {
      var raw = localStorage.getItem(JOBS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) arr = [];
      arr = arr.filter(function (j) { return j && j.id !== jobId; });
      arr.push({ id: jobId, ts: Date.now() });
      localStorage.setItem(JOBS_KEY, JSON.stringify(arr.slice(-30)));
    } catch (e) { /* ignore */ }
  }

  // =========================================================================
  // mode switch  (Single / Batch / Library / Ask — 4-way)
  // =========================================================================
  // Library mode is owned by public/library.js and Ask mode by public/ask.js,
  // but both are driven through this shared controller so there is one source
  // of truth for body.mode-* classes, the sliding indicator, tab a11y,
  // sub-copy + pane swaps. Library/Ask register callbacks via PA.onModeChange
  // to react when activated.
  var MODE_INDEX = { single: 0, batch: 1, library: 2, ask: 3 };
  var modeBtns = { single: modeSingleBtn, batch: modeBatchBtn, library: $("mode-library"), ask: $("mode-ask") };
  var modeChangeCbs = [];

  function setMode(next, opts) {
    if (next !== "single" && next !== "batch" && next !== "library" && next !== "ask") return;
    mode = next;
    var batch = next === "batch";
    var library = next === "library";
    var ask = next === "ask";
    document.body.classList.toggle("mode-batch", batch);
    document.body.classList.toggle("mode-single", next === "single");
    document.body.classList.toggle("mode-library", library);
    document.body.classList.toggle("mode-ask", ask);

    // Tabs: active state + aria-selected + sliding-indicator index.
    Object.keys(modeBtns).forEach(function (m) {
      var btn = modeBtns[m];
      if (!btn) return;
      var on = m === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    var ind = document.querySelector(".mode-switch-ind");
    if (ind) ind.style.setProperty("--mode-idx", String(MODE_INDEX[next] || 0));

    // Swap the panel sub-copy.
    toggleHidden($("input-sub-single"), next !== "single");
    toggleHidden($("input-sub-batch"), next !== "batch");
    toggleHidden($("input-sub-library"), next !== "library");
    toggleHidden($("input-sub-ask"), next !== "ask");

    // Swap dropzone panes (single/batch only; library has no picker pane).
    var panes = document.querySelectorAll("[data-mode-pane]");
    Array.prototype.forEach.call(panes, function (p) {
      toggleHidden(p, p.getAttribute("data-mode-pane") !== next);
    });

    // Swap submit buttons + hints (single/batch). Library has no submit button.
    Array.prototype.forEach.call(document.querySelectorAll(".mode-only-single"), function (n) {
      toggleHidden(n, next !== "single");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".mode-only-batch"), function (n) {
      toggleHidden(n, next !== "batch");
    });

    if (batch) refreshBatchSubmitEnabled();

    // Notify registered listeners (library.js) of the active mode.
    modeChangeCbs.forEach(function (cb) { try { cb(next, opts || {}); } catch (e) { /* ignore */ } });

    // Move focus to the now-visible primary control for a11y when user-initiated.
    if (!opts || !opts.silent) {
      try {
        var target = batch ? batchDropzone : library ? $("lib-q") : ask ? $("ask-q") : $("dropzone");
        if (target) target.focus();
      } catch (e) { /* ignore */ }
    }
  }

  function toggleHidden(node, hidden) {
    if (node) node.hidden = !!hidden;
  }

  // =========================================================================
  // batch file selection
  // =========================================================================
  function addFiles(fileList) {
    var added = 0, rejected = [];
    Array.prototype.forEach.call(fileList || [], function (file) {
      var nameOk = /\.pdf$/i.test(file.name);
      var typeOk = !file.type || file.type === "application/pdf";
      if (!nameOk || !typeOk) { rejected.push(file.name + " (not a PDF)"); return; }
      if (file.size > MAX_BYTES) { rejected.push(file.name + " (" + PA.fmtBytes(file.size) + " > 20 MB)"); return; }
      // De-dupe by name+size.
      var dup = batchFiles.some(function (f) { return f.name === file.name && f.size === file.size; });
      if (dup) return;
      if (batchFiles.length >= MAX_PDFS_PER_JOB) { rejected.push(file.name + " (over " + MAX_PDFS_PER_JOB + "-PDF cap)"); return; }
      batchFiles.push(file);
      added++;
    });
    if (rejected.length) flashBatchError("Skipped: " + rejected.slice(0, 4).join(", ") + (rejected.length > 4 ? " …" : ""));
    if (added) clearBatchError();
    renderBatchFiles();
    refreshBatchSubmitEnabled();
  }

  function removeFile(idx) {
    batchFiles.splice(idx, 1);
    renderBatchFiles();
    refreshBatchSubmitEnabled();
  }

  function renderBatchFiles() {
    PA.clearChildren(batchFileList);
    batchFileCount.textContent = String(batchFiles.length);
    if (!batchFiles.length) { batchFileList.hidden = true; return; }
    batchFileList.hidden = false;
    batchFiles.forEach(function (file, i) {
      var li = PA.el("li", "batch-file");
      var icon = PA.el("span", "batch-file-ico");
      icon.textContent = "PDF";
      li.appendChild(icon);
      var name = PA.el("span", "batch-file-name", file.name);
      name.title = file.name;
      li.appendChild(name);
      li.appendChild(PA.el("span", "batch-file-size subtle", PA.fmtBytes(file.size)));
      var x = PA.el("button", "file-clear batch-file-x", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Remove " + file.name);
      x.addEventListener("click", function (e) { e.stopPropagation(); removeFile(i); });
      li.appendChild(x);
      batchFileList.appendChild(li);
    });
  }

  // Read the user's selected brands from the rendered chips (app.js owns the
  // picker; the chips are the visible source of truth shared by both modes).
  function selectedBrands() {
    var out = [];
    if (!brandChipsHost) return out;
    var names = brandChipsHost.querySelectorAll(".brand-chip-name");
    Array.prototype.forEach.call(names, function (n) {
      var b = (n.textContent || "").trim();
      if (b) out.push(b);
    });
    return out;
  }

  function refreshBatchSubmitEnabled() {
    if (mode !== "batch") return;
    var brands = selectedBrands();
    var ready = !submitting && batchFiles.length >= 1 && brands.length >= 1;
    batchSubmitBtn.disabled = !ready;
    batchSubmitLabel.textContent = batchFiles.length > 1
      ? ("Run batch job — " + batchFiles.length + " PDFs")
      : "Run batch job";
  }

  // =========================================================================
  // batch errors
  // =========================================================================
  var batchErrorTimer = null;
  function flashBatchError(msg) {
    batchErrorMessage.textContent = msg;
    batchErrorBox.hidden = false;
    if (batchErrorTimer) clearTimeout(batchErrorTimer);
    batchErrorTimer = setTimeout(clearBatchError, 8000);
  }
  function showBatchError(msg) {
    batchErrorMessage.textContent = msg;
    batchErrorBox.hidden = false;
  }
  function clearBatchError() {
    batchErrorBox.hidden = true;
    if (batchErrorTimer) { clearTimeout(batchErrorTimer); batchErrorTimer = null; }
  }

  // =========================================================================
  // staged batch submission
  // =========================================================================
  function pause(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function retryableUploadStatus(status) {
    return status === 408 || status === 429 || status >= 500;
  }

  function uploadRetryDelay(resp, retryNumber) {
    if (resp && resp.status === 429) {
      var seconds = Number(resp.headers.get("retry-after"));
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(10000, Math.round(seconds * 1000));
      }
    }
    return Math.min(5000, UPLOAD_RETRY_BASE * Math.pow(2, retryNumber));
  }

  function responseError(resp, fallback) {
    return resp.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (data && data.error) return String(data.error);
      if (text) return text.slice(0, 200);
      return fallback || ("Server returned HTTP " + resp.status);
    });
  }

  function expectJsonResponse(resp, requiredKey) {
    return resp.text().then(function (text) {
      var data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!resp.ok || !data || (requiredKey && !data[requiredKey])) {
        var msg = (data && data.error) ||
          ("Server returned HTTP " + resp.status + (text ? (": " + text.slice(0, 200)) : ""));
        throw new Error(msg);
      }
      return data;
    });
  }

  function uploadStageFile(upload, file, index, total) {
    var retry = 0;

    function attempt() {
      var suffix = retry > 0
        ? (" (retry " + retry + "/" + UPLOAD_RETRIES + ")")
        : "";
      batchSubmitLabel.textContent =
        "Uploading " + (index + 1) + "/" + total + suffix;

      // File/Blob request bodies have a known byte length, so the browser emits
      // Content-Length itself. JavaScript must not try to set that forbidden
      // request header manually.
      return fetch(upload.url, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: file
      }).then(function (resp) {
        if (resp.ok) return null;

        if (retryableUploadStatus(resp.status) && retry < UPLOAD_RETRIES) {
          var delay = uploadRetryDelay(resp, retry);
          retry++;
          return pause(delay).then(attempt);
        }

        return responseError(resp, "HTTP " + resp.status).then(function (msg) {
          throw new Error("Upload failed for '" + file.name + "': " + msg);
        });
      }, function (err) {
        if (retry < UPLOAD_RETRIES) {
          var delay = uploadRetryDelay(null, retry);
          retry++;
          return pause(delay).then(attempt);
        }
        var detail = err && err.message ? err.message : "network error";
        throw new Error("Upload failed for '" + file.name + "': " + detail);
      });
    }

    return attempt();
  }

  function submitBatch() {
    if (submitting || mode !== "batch") return;
    var brands = selectedBrands();
    if (!batchFiles.length || !brands.length) return;

    // Freeze the exact file order for the whole staged protocol. The UI remains
    // disabled during submission, but this also protects against programmatic
    // mutations while requests are in flight.
    var files = batchFiles.slice();
    var deep = !!(deepConfidenceToggle && deepConfidenceToggle.checked);
    var quotes = !sourceQuotesToggle || sourceQuotesToggle.checked;
    var consensus = !!(consensusToggle && consensusToggle.checked);

    var config = {
      brands: brands.join(","),
      explain: quotes,
      consensus: consensus
    };
    // Omitting runs preserves the legacy batch default. Deep Confidence sends
    // the explicit configured run count.
    if (deep) config.runs = DEEP_RUNS;

    var manifest = files.map(function (file, index) {
      return {
        index: index,
        filename: file.name,
        size: file.size
      };
    });

    clearBatchError();
    submitting = true;
    batchSubmitBtn.classList.add("is-loading");
    refreshBatchSubmitEnabled();
    batchSubmitLabel.textContent = "Preparing upload...";

    fetch("/api/jobs/stage", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ config: config, manifest: manifest })
    })
      .then(function (resp) {
        return expectJsonResponse(resp, "uploadId");
      })
      .then(function (stage) {
        if (!Array.isArray(stage.uploads) || stage.uploads.length !== files.length) {
          throw new Error("Server returned an invalid upload manifest.");
        }

        var uploadsByIndex = {};
        stage.uploads.forEach(function (upload) {
          if (
            upload &&
            typeof upload.index === "number" &&
            typeof upload.url === "string"
          ) {
            uploadsByIndex[upload.index] = upload;
          }
        });

        var sequence = Promise.resolve();
        files.forEach(function (file, index) {
          sequence = sequence.then(function () {
            var upload = uploadsByIndex[index];
            if (!upload) {
              throw new Error("Server omitted the upload URL for '" + file.name + "'.");
            }
            return uploadStageFile(upload, file, index, files.length);
          });
        });

        return sequence.then(function () {
          batchSubmitLabel.textContent = "Starting job...";
          return fetch(
            "/api/jobs/stage/" + encodeURIComponent(stage.uploadId) + "/start",
            {
              method: "POST",
              headers: { "Accept": "application/json" }
            }
          ).then(function (resp) {
            return expectJsonResponse(resp, "jobId");
          });
        });
      })
      .then(function (started) {
        var jobId = started.jobId;
        // Nothing becomes a remembered/shareable job until the server has
        // verified every staged object and committed the idempotent DO start.
        rememberJob(jobId);
        setHashJob(jobId);
        startJob(jobId, { fresh: true });
      })
      .catch(function (err) {
        showBatchError(err && err.message ? err.message : "Could not submit the batch job.");
      })
      .finally(function () {
        submitting = false;
        batchSubmitBtn.classList.remove("is-loading");
        refreshBatchSubmitEnabled();
      });
  }

  // =========================================================================
  // hash routing (#job-<id>) — shareable / reloadable library behaviour
  // =========================================================================
  var HASH_RE = /^#job-([0-9a-zA-Z._-]{1,128})$/;
  function setHashJob(jobId) {
    // Replace (not push) so reloads land on the same job without a history pile.
    try {
      var h = "#job-" + jobId;
      if (location.hash !== h) history.replaceState(null, "", h);
    } catch (e) { location.hash = "#job-" + jobId; }
  }
  function jobIdFromHash() {
    var m = HASH_RE.exec(location.hash || "");
    return m ? m[1] : null;
  }

  // =========================================================================
  // job lifecycle
  // =========================================================================
  function startJob(jobId, opts) {
    // Tear down any prior job cleanly.
    teardownJob();

    // Switch to batch mode (without stealing focus on auto-load).
    setMode("batch", { silent: true });

    job = newJobState(jobId);
    rememberJob(jobId);

    // Reset/prepare the batch panels.
    PA.clearChildren(batchResultsHost);
    PA.clearChildren(batchCompareBody);
    batchComparison.hidden = true;
    batchDist.hidden = true;
    batchResults.hidden = true;

    jobPanel.hidden = false;
    PA.revealNow(jobPanel);
    copyLinkBtn.hidden = false;
    downloadAllBtn.hidden = true;
    // W5: hide a stale "Save as cohort" affordance from a previous job; cohorts.js
    // re-shows it (with the new jobId) when THIS job finishes.
    var saveCohortBtn = $("batch-save-cohort");
    if (saveCohortBtn) { saveCohortBtn.hidden = true; saveCohortBtn.disabled = false; }
    setConn("connecting");
    setStatusText(opts && opts.fresh ? "Job queued — starting…" : "Reconnecting to job…");
    updateProgressUI();
    startElapsedClock();

    // If the job is already finished, GET the results snapshot; otherwise the WS
    // stream replays + streams live. We attempt the stream first (it replays
    // everything from seq 0 on a fresh load anyway), and fall back to the
    // finished-results endpoint if the socket can't be established.
    connectStream();
  }

  function teardownJob() {
    if (!job) return;
    job.closedByUs = true;
    if (job.reconnectTimer) { clearTimeout(job.reconnectTimer); job.reconnectTimer = null; }
    stopElapsedClock();
    closeSocket();
    // Hide the export bar between jobs; it re-shows once the next job has results.
    if (batchExportBar) batchExportBar.hidden = true;
    job = null;
  }

  function closeSocket() {
    if (job && job.ws) {
      try { job.ws.onopen = job.ws.onmessage = job.ws.onerror = job.ws.onclose = null; } catch (e) { /* ignore */ }
      try { job.ws.close(); } catch (e) { /* ignore */ }
      job.ws = null;
    }
  }

  // =========================================================================
  // WebSocket: connect, replay (lastSeq), stream live, auto-reconnect
  // =========================================================================
  function wsUrl(jobId, lastSeq) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/api/jobs/" +
      encodeURIComponent(jobId) + "/stream?lastSeq=" + (lastSeq || 0);
  }

  function connectStream() {
    if (!job || job.done) return;
    closeSocket();
    job.closedByUs = false;
    setConn("connecting");

    var ws;
    try {
      ws = new WebSocket(wsUrl(job.id, job.lastSeq));
    } catch (e) {
      // Could not even construct (very old browser) — fall back to polling once.
      pollOnce();
      return;
    }
    job.ws = ws;

    ws.onopen = function () {
      if (!job) return;
      job.reconnectAttempt = 0;
      setConn("live");
      setStatusText(job.completedPdfs >= job.totalPdfs && job.totalPdfs > 0
        ? "Job complete" : "Streaming live…");
    };

    ws.onmessage = function (ev) {
      if (!job) return;
      // Server may batch multiple NDJSON lines per frame; split defensively.
      var raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw) return;
      raw.split("\n").forEach(function (line) {
        var t = line.trim();
        if (!t) return;
        var evt;
        try { evt = JSON.parse(t); } catch (e) { return; }
        if (evt && typeof evt === "object") handleJobEvent(evt);
      });
    };

    ws.onerror = function () {
      // onclose will follow and drive reconnect; just reflect the state.
      if (job && !job.done) setConn("retrying");
    };

    ws.onclose = function () {
      if (!job) return;
      job.ws = null;
      if (job.done || job.closedByUs) { setConn("done"); return; }
      // WebSockets drop on deploy / network blips: auto-reconnect with backoff.
      setConn("retrying");
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (!job || job.done || job.closedByUs) return;
    if (job.reconnectTimer) return;
    var attempt = job.reconnectAttempt++;
    var delay = Math.min(RECONNECT_MAX, RECONNECT_BASE * Math.pow(1.7, attempt));
    delay = Math.round(delay * (0.7 + Math.random() * 0.6)); // jitter
    setStatusText("Connection lost — reconnecting in " + (delay / 1000).toFixed(1) + "s…");
    job.reconnectTimer = setTimeout(function () {
      if (!job) return;
      job.reconnectTimer = null;
      connectStream();
    }, delay);
  }

  // Tab became visible again -> if the socket isn't open, reconnect immediately
  // (don't wait out the backoff).
  function onVisibility() {
    if (document.visibilityState !== "visible") return;
    if (!job || job.done || job.closedByUs) return;
    var open = job.ws && job.ws.readyState === WebSocket.OPEN;
    var connecting = job.ws && job.ws.readyState === WebSocket.CONNECTING;
    if (!open && !connecting) {
      if (job.reconnectTimer) { clearTimeout(job.reconnectTimer); job.reconnectTimer = null; }
      job.reconnectAttempt = 0;
      connectStream();
    }
  }

  // =========================================================================
  // event handling — the SAME AnalyzeEvent objects app.js renders, plus
  // { pdf_index, filename, seq_num } and a terminal { event:"job_done" }.
  // =========================================================================
  function handleJobEvent(evt) {
    // Track the highest seq we have processed IN THIS SESSION so a live socket
    // reconnect replays only what we missed (kept in memory only — see the
    // localStorage-helpers note on why this is never persisted across reloads).
    if (typeof evt.seq_num === "number" && evt.seq_num > job.lastSeq) {
      job.lastSeq = evt.seq_num;
    }

    // Job-level meta events.
    if (evt.event === "job_init" || evt.event === "job_state") {
      applyJobMeta(evt);
      return;
    }
    if (evt.event === "job_done") {
      onJobDone(evt);
      return;
    }

    var pi = (typeof evt.pdf_index === "number") ? evt.pdf_index : null;

    // A "start" event carries the per-PDF metadata; ensure a section exists.
    if (pi != null) {
      var pdf = ensurePdfSection(pi, evt.filename);
      switch (evt.event) {
        case "pdf_reset":
          resetPdfAttempt(pi, pdf, evt);
          break;
        case "start":
          if (Array.isArray(evt.brands) && evt.brands.length) {
            pdf.brands = evt.brands.slice();
            // Surface the "brands each" stat from the per-PDF start manifest.
            if (job.brandsPerPdf == null) {
              job.brandsPerPdf = evt.brands.length;
              updateProgressUI();
            }
          }
          setPdfStatus(pi, "analyzing", "OCR + scoring…");
          break;
        case "ocr_start":
          setPdfStatus(pi, "analyzing", "reading the PDF…");
          break;
        case "ocr_done":
          setPdfStatus(pi, "analyzing", PA.fmtNum(evt.pages) + " pages read");
          break;
        case "brand_start":
          // Ensure a placeholder card exists so progress is visible immediately.
          ensureBrandCard(pdf, evt.brand);
          setPdfStatus(pi, "analyzing", "scoring " + evt.brand + "…");
          break;
        case "result":
          renderBatchResult(pdf, evt);
          break;
        case "error":
          if (evt.brand) {
            // Per-brand failure: render an error card; the PDF itself continues.
            renderBatchBrandError(pdf, evt.brand, evt.error, evt);
          } else {
            // Fatal failure for this PDF — mark the whole PDF failed + done.
            applyEventState(evt);
            setPdfStatus(pi, "failed", evt.error || "failed");
            markPdfDone(pi, true);
          }
          break;
        // Terminal per-PDF events. The container emits `done` at the end of a
        // PDF's stream; the DO may additionally emit a `pdf_done` wrapper. Either
        // marks this PDF complete (idempotent).
        case "done":
        case "pdf_done":
          markPdfDone(pi, !!evt.failed);
          break;
        default:
          break;
      }
      return;
    }

    // pdf_index-less events we may still care about (rare); ignore safely.
  }

  // Apply a job_init/job_state snapshot (totals, config) to the UI. Accepts
  // BOTH the flat broadcast shape (evt.total_pdfs / evt.pdfs) AND the DO's
  // GET /api/jobs/:id JobStateResponse shape (evt.totals.* / evt.perPdf[]),
  // which the poll fallback (pollOnce -> applyJobMeta) receives.
  function applyJobMeta(evt) {
    var totals = (evt && evt.totals && typeof evt.totals === "object") ? evt.totals : evt;
    if (typeof totals.total_pdfs === "number") job.totalPdfs = totals.total_pdfs;
    if (typeof totals.completed_pdfs === "number") job.completedPdfs = totals.completed_pdfs;
    if (typeof totals.failed_pdfs === "number") job.failedPdfs = totals.failed_pdfs;
    if (evt.config && Array.isArray(evt.config.brands)) {
      job.brandsPerPdf = evt.config.brands.length;
    } else if (evt.config && typeof evt.config.brands === "string") {
      // DO/Worker send config.brands as a CSV string, not an array.
      job.brandsPerPdf = String(evt.config.brands).split(",").filter(Boolean).length;
    } else if (Array.isArray(evt.brands)) {
      job.brandsPerPdf = evt.brands.length;
    }
    // Pre-create per-PDF sections from a manifest if provided. The flat shape
    // uses evt.pdfs[{pdf_index,filename,status}]; the JobStateResponse shape
    // uses evt.perPdf[{index,filename,status}] (status is a JobStatus — a
    // terminal "complete"/"failed" pre-marks the section done).
    var manifest = Array.isArray(evt.perPdf) ? evt.perPdf
      : (Array.isArray(evt.pdfs) ? evt.pdfs : null);
    if (manifest) {
      manifest.forEach(function (p, i) {
        var idx = (p && typeof p.pdf_index === "number") ? p.pdf_index
          : (p && typeof p.index === "number") ? p.index : i;
        var pdf = ensurePdfSection(idx, p && p.filename);
        if (p && typeof p.attempt === "number") pdf.attempt = p.attempt;
        if (p && (p.status === "done" || p.status === "complete")) markPdfDone(idx, false);
        if (p && p.status === "failed") markPdfDone(idx, true);
      });
    }
    setStatusText(job.done ? "Job complete" : "Running…");
    updateProgressUI();
  }

  function onJobDone(evt) {
    job.done = true;
    if (typeof evt.completed_pdfs === "number") job.completedPdfs = evt.completed_pdfs;
    if (typeof evt.failed_pdfs === "number") job.failedPdfs = evt.failed_pdfs;
    // Mark any still-spinning PDFs as done (defensive).
    Object.keys(job.pdfs).forEach(function (k) {
      var p = job.pdfs[k];
      if (!p.done) markPdfDone(Number(k), p.failed);
    });
    setStatusText("Job complete — " + job.completedPdfs + "/" + job.totalPdfs + " PDFs"
      + (job.failedPdfs ? (" (" + job.failedPdfs + " failed)") : ""));
    setConn("done");
    updateProgressUI();
    stopElapsedClock();
    downloadAllBtn.hidden = false;
    job.closedByUs = true;
    closeSocket();
    notifyJobDone();
  }

  // Notify W5 cohort listeners that a job has reached a terminal state. Fired
  // from BOTH terminal paths (live job_done + finished-snapshot render). Safe to
  // call more than once — cohorts.js dedupes by jobId.
  function notifyJobDone() {
    if (!job || !job.done) return;
    var desc = {
      jobId: job.id,
      total: job.totalPdfs || 0,
      completed: job.completedPdfs || 0,
      failed: job.failedPdfs || 0,
      brandsPerPdf: job.brandsPerPdf
    };
    jobDoneCbs.forEach(function (cb) { try { cb(desc); } catch (e) { /* ignore */ } });
  }

  // =========================================================================
  // per-PDF sections + brand cards (REUSE #result-card-tpl via window.PA)
  // =========================================================================
  function ensurePdfSection(pi, filename) {
    if (job.pdfs[pi]) {
      if (filename && job.pdfs[pi].name !== filename) {
        job.pdfs[pi].name = filename;
        var nameEl = job.pdfs[pi].section.querySelector(".batch-pdf-name");
        if (nameEl) { nameEl.textContent = filename; nameEl.title = filename; }
      }
      return job.pdfs[pi];
    }
    var frag = pdfSectionTpl.content.cloneNode(true);
    var section = frag.querySelector(".batch-pdf");
    section.setAttribute("data-pdf-index", String(pi));
    var nm = section.querySelector(".batch-pdf-name");
    nm.textContent = filename || ("PDF #" + (pi + 1));
    nm.title = filename || "";
    var statusEl = section.querySelector(".batch-pdf-status");
    statusEl.textContent = "queued";

    // Insert in pdf_index order so reconnect replays land in a stable layout.
    insertSectionOrdered(section, pi);

    var rec = {
      section: section,
      cardsHost: section.querySelector(".batch-pdf-cards"),
      heatmapHost: section.querySelector(".batch-pdf-heatmap"),
      statusEl: statusEl,
      name: filename || "",
      brands: null,
      cards: {},
      cardSeq: 0,
      attempt: 1,
      done: false,
      failed: false
    };
    job.pdfs[pi] = rec;

    batchResults.hidden = false;
    PA.revealNow(batchResults);
    PA.revealNow(section);
    return rec;
  }

  function insertSectionOrdered(section, pi) {
    var existing = batchResultsHost.children;
    var before = null;
    for (var i = 0; i < existing.length; i++) {
      var idx = parseInt(existing[i].getAttribute("data-pdf-index"), 10);
      if (!isNaN(idx) && idx > pi) { before = existing[i]; break; }
    }
    if (before) batchResultsHost.insertBefore(section, before);
    else batchResultsHost.appendChild(section);
  }

  function setPdfStatus(pi, kind, text) {
    var pdf = job.pdfs[pi];
    if (!pdf) return;
    pdf.section.classList.toggle("is-analyzing", kind === "analyzing");
    pdf.section.classList.toggle("is-failed", kind === "failed");
    pdf.statusEl.className = "batch-pdf-status pill " +
      (kind === "done" ? "pill-brand" : kind === "failed" ? "pill-ghost is-err" : "pill-ghost");
    pdf.statusEl.textContent = text || kind;
  }

  function applyEventState(evt) {
    job.eventState = BatchState.applyBatchEvent(job.eventState, evt);
    job.results = job.eventState.results.slice();
  }

  function markPdfDone(pi, failed) {
    var pdf = job.pdfs[pi];
    if (!pdf || pdf.done) return;
    applyEventState({
      event: "pdf_done",
      pdf_index: pi,
      filename: pdf.name,
      failed: !!failed
    });
    pdf.done = true;
    pdf.failed = !!failed;
    pdf.section.classList.remove("is-analyzing");
    setPdfStatus(pi, failed ? "failed" : "done", failed ? "failed" : "done ✓");
    job.completedPdfs = countDonePdfs();
    job.failedPdfs = countFailedPdfs();
    updateProgressUI();
  }

  function countDonePdfs() {
    var n = 0;
    Object.keys(job.pdfs).forEach(function (k) { if (job.pdfs[k].done) n++; });
    return Math.max(n, job.completedPdfs);
  }
  function countFailedPdfs() {
    var n = 0;
    Object.keys(job.pdfs).forEach(function (k) { if (job.pdfs[k].failed) n++; });
    return n;
  }

  // Ensure a (possibly empty) brand card exists in a PDF section.
  function ensureBrandCard(pdf, brand) {
    if (pdf.cards[brand]) return pdf.cards[brand];
    var card = PA.cloneBrandCard(brand);
    pdf.cardsHost.appendChild(card);
    pdf.cards[brand] = card;
    PA.animateCardEnter(card, pdf.cardSeq++);
    return card;
  }

  function renderBatchResult(pdf, evt) {
    applyEventState(evt);
    var card = ensureBrandCard(pdf, evt.brand);
    PA.populateBrandCard(card, evt, pdf.name);
    var pi = evt.pdf_index;
    updateAggregates();
    renderPdfHeatmap(pi, pdf);
  }

  // W2: brand-vs-brand heatmap for ONE PDF's brands (this batch group). Reuses
  // the shared analytics renderer; no-op if the analytics layer didn't load or
  // only one brand has come back for this PDF so far.
  function renderPdfHeatmap(pi, pdf) {
    if (!window.PA || !window.PA.analytics || !pdf || !pdf.heatmapHost) return;
    var items = job.results
      .filter(function (r) { return r.pdfIndex === pi; })
      .map(function (r) { return r.data; });
    if (items.length <= 1) { pdf.heatmapHost.hidden = true; return; }
    window.PA.analytics.renderHeatmap(pdf.heatmapHost, items);
  }

  function renderBatchBrandError(pdf, brand, msg, evt) {
    var pi = evt && typeof evt.pdf_index === "number"
      ? evt.pdf_index
      : Number(pdf.section.getAttribute("data-pdf-index"));
    applyEventState(evt || {
      event: "error",
      pdf_index: pi,
      filename: pdf.name,
      brand: brand,
      error: msg
    });
    var card = ensureBrandCard(pdf, brand);
    PA.fillBrandErrorCard(card, brand, msg);
    updateAggregates();
    renderPdfHeatmap(pi, pdf);
  }

  function resetPdfAttempt(pi, pdf, evt) {
    applyEventState(evt);

    pdf.done = false;
    pdf.failed = false;
    pdf.attempt = typeof evt.attempt === "number" ? evt.attempt : pdf.attempt + 1;
    pdf.cards = {};
    pdf.cardSeq = 0;
    PA.clearChildren(pdf.cardsHost);
    if (pdf.heatmapHost) {
      PA.clearChildren(pdf.heatmapHost);
      pdf.heatmapHost.hidden = true;
    }
    pdf.section.classList.remove("is-failed");
    pdf.section.classList.remove("is-analyzing");
    setPdfStatus(pi, "queued", "queued for retry");

    // Reset is the one path where progress must move backward. Assign the
    // reducer counts directly instead of using countDonePdfs' monotonic ratchet.
    job.completedPdfs = job.eventState.completedPdfs;
    job.failedPdfs = job.eventState.failedPdfs;

    if (!job.results.length && batchExportBar) batchExportBar.hidden = true;
    updateAggregates();
    updateProgressUI();
  }

  // =========================================================================
  // batch progress summary
  // =========================================================================
  function updateProgressUI() {
    var total = job.totalPdfs || Object.keys(job.pdfs).length || 0;
    var done = Math.min(job.completedPdfs, total || job.completedPdfs);
    doneCountEl.textContent = String(done);
    totalCountEl.textContent = String(total || "—");
    failedCountEl.textContent = String(job.failedPdfs || 0);
    brandsCountEl.textContent = job.brandsPerPdf != null ? String(job.brandsPerPdf) : "—";

    var pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    if (progFill) {
      progFill.style.transform = "scaleX(" + pct.toFixed(4) + ")";
    }
    if (progBar) progBar.setAttribute("aria-valuenow", String(Math.round(pct * 100)));
  }

  // Elapsed clock (rAF where available; falls back to setInterval).
  function startElapsedClock() {
    stopElapsedClock();
    var t0 = job.t0 || Date.now();
    var last = "";
    if (typeof requestAnimationFrame === "function") {
      var tick = function () {
        if (!job) return;
        var s = ((Date.now() - t0) / 1000).toFixed(1) + "s";
        if (s !== last) { last = s; batchElapsedEl.textContent = s; }
        job.elapsedTimer = requestAnimationFrame(tick);
        job._raf = true;
      };
      job.elapsedTimer = requestAnimationFrame(tick);
      job._raf = true;
    } else {
      job.elapsedTimer = setInterval(function () {
        if (!job) return;
        batchElapsedEl.textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
      }, 100);
      job._raf = false;
    }
  }
  function stopElapsedClock() {
    if (!job || job.elapsedTimer == null) return;
    if (job._raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(job.elapsedTimer);
    else clearInterval(job.elapsedTimer);
    job.elapsedTimer = null;
  }

  // =========================================================================
  // connection + status pills
  // =========================================================================
  function setConn(state) {
    if (connDot) connDot.setAttribute("data-state", state);
    var labels = {
      idle: "idle", connecting: "connecting", live: "live",
      retrying: "reconnecting", done: "complete"
    };
    if (connText) connText.textContent = labels[state] || state;
  }
  function setStatusText(t) { if (statusText) statusText.textContent = t; }

  // =========================================================================
  // aggregated batch comparison + distribution (across the whole batch)
  // =========================================================================
  // Each rebuild is O(results), so calling it synchronously per result event
  // makes a replay burst (N results after a reload/reconnect) O(N^2). Coalesce
  // via PA.rafCoalesce: a burst collapses to one rebuild per animation frame,
  // and the trailing frame always renders the final state.
  var updateAggregates = PA.rafCoalesce
    ? PA.rafCoalesce(rebuildAggregates)
    : rebuildAggregates;
  function rebuildAggregates() {
    if (!job) return;  // job torn down between the schedule and the frame
    renderBatchComparison();
    renderBatchDistribution();
    ensureBatchExportBar();
  }

  function renderBatchComparison() {
    if (!job.results.length) { batchComparison.hidden = true; return; }
    batchComparison.hidden = false;
    PA.revealNow(batchComparison);
    PA.clearChildren(batchCompareBody);

    // Stable order: by pdf_index, then by result arrival within the PDF.
    var rows = job.results.slice().sort(function (a, b) {
      if (a.pdfIndex !== b.pdfIndex) return a.pdfIndex - b.pdfIndex;
      return 0;
    });

    rows.forEach(function (item, i) {
      var res = (item.data && item.data.result) || {};
      var score = PA.snapScore(res["Access Score"]);
      var tr = document.createElement("tr");
      if (!PA.reducedMotion()) tr.style.setProperty("--rd", (Math.min(i, 12) * 45) + "ms");

      var tdFile = PA.el("td", null);
      var fileChip = PA.el("span", "batch-file-mini", item.filename || res["Filename"] || ("PDF #" + (item.pdfIndex + 1)));
      fileChip.title = item.filename || "";
      tdFile.appendChild(fileChip);
      tr.appendChild(tdFile);

      var tdBrand = PA.el("td", null);
      tdBrand.appendChild(PA.el("span", "pill pill-brand", res["Brand"] || item.brand));
      tr.appendChild(tdBrand);

      var tdScore = PA.el("td", null);
      var chip = PA.el("span", "score-chip", String(score));
      var sm = PA.SCORE_META[score] || PA.SCORE_META[0];
      chip.style.background = sm.color;
      chip.style.color = sm.fg;
      tdScore.appendChild(chip);
      tr.appendChild(tdScore);

      tr.appendChild(PA.compareCell(PA.compareValue(res, "Number of Steps through Brands", PA.stepPresent)));
      tr.appendChild(PA.compareCell(PA.compareValue(res, "Number of Steps through Generic", PA.stepPresent)));
      tr.appendChild(PA.compareCell(PA.compareValue(res, "Step through-Phototherapy", PA.yesPresent)));
      tr.appendChild(PA.compareCell(PA.compareValue(res, "TB Test required", PA.yesPresent)));
      tr.appendChild(PA.compareCell(PA.compareValue(res, "Specialist Types", PA.specialistPresent)));
      tr.appendChild(PA.compareCell(PA.compareValue(res, "Reauthorization Required", PA.yesPresent)));

      batchCompareBody.appendChild(tr);
    });
  }

  // Distribution chart across the whole batch (mirrors app.js renderDistribution,
  // scoped to #batch-dist-chart, aggregating every brand×PDF result).
  function renderBatchDistribution() {
    var svg = $("batch-dist-chart");
    if (!svg) return;
    if (!job.results.length) { batchDist.hidden = true; return; }
    batchDist.hidden = false;
    PA.revealNow(batchDist);
    PA.clearChildren(svg);

    var title = PA.svgEl("title");
    title.setAttribute("id", "batch-dist-title");
    title.textContent = "Distribution of access scores across the batch";
    svg.appendChild(title);

    var scores = job.results.map(function (r) {
      return PA.snapScore(((r.data && r.data.result) || {})["Access Score"]);
    });
    batchDistScope.textContent = "· " + scores.length + " result" + (scores.length === 1 ? "" : "s");

    var STOPS = PA.SCORE_STOPS;
    var counts = {};
    STOPS.forEach(function (s) { counts[s] = 0; });
    scores.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
    var max = Math.max.apply(null, STOPS.map(function (s) { return counts[s]; }).concat([1]));

    var W = 320, H = 180, padL = 28, padB = 38, padT = 14, padR = 10;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var n = STOPS.length;
    var slot = plotW / n;
    var barW = slot * 0.6;

    var axis = PA.svgEl("line");
    axis.setAttribute("x1", padL); axis.setAttribute("y1", padT + plotH);
    axis.setAttribute("x2", padL + plotW); axis.setAttribute("y2", padT + plotH);
    axis.setAttribute("stroke", "var(--border-strong)"); axis.setAttribute("stroke-width", "1");
    svg.appendChild(axis);

    STOPS.forEach(function (stop, i) {
      var c = counts[stop];
      var h = c > 0 ? (c / max) * plotH : 0;
      var x = padL + slot * i + (slot - barW) / 2;
      var y = padT + plotH - h;
      var sm = PA.SCORE_META[stop];

      var rect = PA.svgEl("rect");
      rect.setAttribute("class", "bar");
      rect.setAttribute("x", x); rect.setAttribute("y", c > 0 ? y : padT + plotH - 2);
      rect.setAttribute("width", barW); rect.setAttribute("height", c > 0 ? h : 2);
      rect.setAttribute("rx", 4);
      rect.setAttribute("fill", sm.color);
      rect.setAttribute("stroke", "rgba(0,0,0,.18)");
      rect.setAttribute("stroke-width", "1");
      rect.setAttribute("opacity", c > 0 ? "0.92" : "0.25");
      var t = PA.svgEl("title");
      t.textContent = sm.label + ": " + c;
      rect.appendChild(t);
      svg.appendChild(rect);
      if (c > 0 && !PA.reducedMotion()) {
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
        var cnt = PA.svgEl("text");
        cnt.setAttribute("x", x + barW / 2); cnt.setAttribute("y", y - 4);
        cnt.setAttribute("text-anchor", "middle"); cnt.setAttribute("font-size", "11");
        cnt.setAttribute("font-family", "JetBrains Mono, monospace");
        cnt.setAttribute("font-weight", "400"); cnt.setAttribute("fill", "var(--text)");
        cnt.textContent = c;
        svg.appendChild(cnt);
      }

      var lbl = PA.svgEl("text");
      lbl.setAttribute("x", x + barW / 2); lbl.setAttribute("y", padT + plotH + 14);
      lbl.setAttribute("text-anchor", "middle"); lbl.setAttribute("font-size", "10");
      lbl.setAttribute("font-family", "JetBrains Mono, monospace");
      lbl.setAttribute("font-weight", "400"); lbl.setAttribute("fill", "var(--text-muted)");
      lbl.textContent = stop;
      svg.appendChild(lbl);

      var sub = PA.svgEl("text");
      sub.setAttribute("x", x + barW / 2); sub.setAttribute("y", padT + plotH + 26);
      sub.setAttribute("text-anchor", "middle"); sub.setAttribute("font-size", "8");
      sub.setAttribute("font-family", "JetBrains Mono, monospace");
      sub.setAttribute("fill", "var(--text-faint)");
      sub.textContent = sm.label;
      svg.appendChild(sub);
    });
  }

  // =========================================================================
  // finished-results snapshot (GET /api/results?jobId=..)
  // =========================================================================
  function loadJobState(jobId) {
    return fetch("/api/jobs/" + encodeURIComponent(jobId), {
      headers: { "Accept": "application/json" }
    }).then(function (resp) {
      if (!resp.ok) return null;
      return resp.json();
    }).catch(function () {
      return null;
    });
  }

  // Used as a fallback render path for an already-finished job (e.g. opened via
  // a shared link long after completion, when the WS would just replay anyway).
  function loadFinishedResults(jobId) {
    return fetch("/api/results?jobId=" + encodeURIComponent(jobId), {
      headers: { "Accept": "application/json" }
    }).then(function (resp) {
      if (resp.status === 404) return null;       // not finished / absent
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      return resp.json();
    }).then(function (data) {
      if (!data) return false;
      renderFinishedSnapshot(jobId, data);
      return true;
    }).catch(function () { return false; });
  }

  // Render a finished aggregated results document. Tolerant of a couple of
  // plausible shapes: { pdfs:[{pdf_index,filename,results:[resultEvent...]}] }
  // or a flat { results:[resultEvent-with-pdf_index...] }.
  function renderFinishedSnapshot(jobId, data) {
    if (!job || job.id !== jobId) { teardownJob(); job = newJobState(jobId); }
    job.done = true;

    var rows = [];
    if (Array.isArray(data.pdfs)) {
      data.pdfs.forEach(function (p, i) {
        // JobResults.pdfs[] entries name the field `index` (not pdf_index).
        var pi = (p && typeof p.pdf_index === "number") ? p.pdf_index
          : (p && typeof p.index === "number") ? p.index : i;
        var fname = p && p.filename;
        ensurePdfSection(pi, fname);
        var prs = (p && (p.results || p.brands)) || [];
        prs.forEach(function (r) {
          var evt = normalizeResultEvent(r, pi, fname);
          if (evt) rows.push(evt);
        });
        // Per-brand errors recorded in the results doc ({brand, message}):
        // render the same error card the live stream shows, so a saved
        // snapshot also says WHY a brand is missing from its results.
        var perrs = (p && Array.isArray(p.errors)) ? p.errors : [];
        perrs.forEach(function (er) {
          if (er && er.brand) {
            renderBatchBrandError(
              job.pdfs[pi],
              er.brand,
              er.message || "failed",
              {
                event: "error",
                pdf_index: pi,
                filename: fname,
                brand: er.brand,
                error: er.message || "failed"
              }
            );
          }
        });
        markPdfDone(pi, p && p.status === "failed");
      });
    } else if (Array.isArray(data.results)) {
      data.results.forEach(function (r) {
        var pi = (typeof r.pdf_index === "number") ? r.pdf_index : 0;
        ensurePdfSection(pi, r.filename);
        var evt = normalizeResultEvent(r, pi, r.filename);
        if (evt) rows.push(evt);
      });
      Object.keys(job.pdfs).forEach(function (k) { markPdfDone(Number(k), false); });
    }

    if (typeof data.total_pdfs === "number") job.totalPdfs = data.total_pdfs;
    else job.totalPdfs = Object.keys(job.pdfs).length;
    job.completedPdfs = countDonePdfs();
    job.failedPdfs = countFailedPdfs();
    if (data.config && Array.isArray(data.config.brands)) {
      job.brandsPerPdf = data.config.brands.length;
    } else if (data.config && typeof data.config.brands === "string") {
      // JobResults.config.brands is a CSV string, mirroring the DO/Worker shape.
      job.brandsPerPdf = String(data.config.brands).split(",").filter(Boolean).length;
    }

    rows.forEach(function (evt) {
      var pdf = job.pdfs[evt.pdf_index];
      if (pdf) renderBatchResult(pdf, evt);
    });

    jobPanel.hidden = false;
    PA.revealNow(jobPanel);
    copyLinkBtn.hidden = false;
    downloadAllBtn.hidden = false;
    setConn("done");
    setStatusText("Job complete — " + job.completedPdfs + "/" + job.totalPdfs + " PDFs (from saved results)");
    updateProgressUI();
    updateAggregates();
    notifyJobDone();
  }

  // Coerce a stored result row into a `result` AnalyzeEvent the renderer accepts.
  function normalizeResultEvent(r, pi, filename) {
    if (!r || typeof r !== "object") return null;
    if (r.result) {
      var evt = Object.assign({}, r);
      evt.event = "result";
      if (evt.pdf_index == null) evt.pdf_index = pi;
      if (evt.filename == null) evt.filename = filename;
      if (evt.brand == null && evt.result && evt.result.Brand) evt.brand = evt.result.Brand;
      return evt;
    }
    return null;
  }

  // =========================================================================
  // share link + download-all
  // =========================================================================
  function copyShareLink() {
    if (!job) return;
    var link = location.origin + location.pathname + "#job-" + job.id;
    function done() {
      copyStatus.textContent = "Link copied!";
      setTimeout(function () { copyStatus.textContent = ""; }, 1800);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done).catch(function () { fallbackCopy(link, done); });
    } else { fallbackCopy(link, done); }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { copyStatus.textContent = "Copy failed"; }
    document.body.removeChild(ta);
  }

  function downloadAll() {
    if (!job || !job.results.length) return;
    var doc = {
      jobId: job.id,
      total_pdfs: job.totalPdfs,
      completed_pdfs: job.completedPdfs,
      failed_pdfs: job.failedPdfs,
      results: job.results.map(function (r) {
        return {
          pdf_index: r.pdfIndex,
          filename: r.filename,
          brand: r.brand,
          result: r.data.result,
          access_justification: r.data.access_justification,
          meta: r.data.meta,
          confidence: r.data.confidence,
          spans: r.data.spans,
          // W3: the per-result cross-check consensus block — present when the
          // batch was submitted with the cross-check toggle on (the Worker
          // forwards it to the container per PDF); JSON.stringify drops the
          // key when it is absent.
          consensus: r.data.consensus
        };
      })
    };
    var json = JSON.stringify(doc, null, 2);
    var name = "batch_" + job.id.slice(0, 12) + ".json";
    // For large batches a data: URI can get unwieldy; prefer a Blob URL, which
    // is permitted for downloads under default-src 'self'.
    try {
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      var durl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
      var a2 = document.createElement("a");
      a2.href = durl; a2.download = name;
      document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
    }
  }

  // W4 EXPORTS: a Print / CSV / JSON / FHIR action bar for the WHOLE job (every
  // PDF × brand scored). Built once and inserted into the job header actions;
  // re-reads job.results on each click so it always reflects the full set. The
  // existing "Download all JSON" button stays (it is the raw job document). The
  // bar is shown as soon as the job has at least one result. No-op if export.js
  // failed to load. CSP-safe.
  var batchExportBar = null;
  function ensureBatchExportBar() {
    if (!window.PA || !window.PA.exports || !batchJobActions) return;
    if (!job || !job.results.length) return;
    if (batchExportBar && batchJobActions.contains(batchExportBar)) {
      batchExportBar.hidden = false;
      return;
    }
    batchExportBar = window.PA.exports.buildExportBar({
      scope: "batch",
      compact: true,
      getItems: function () {
        if (!job || !job.results) return [];
        // Each job.results row is { pdfIndex, filename, brand, data:ExtractResult };
        // export.js normalizes this wrapper shape directly.
        return job.results.slice();
      },
      baseName: function () { return "pa_batch_" + (job ? job.id.slice(0, 12) : "job"); },
      printTitle: function () {
        return "Prior-Authorization Batch Report" + (job ? " — job " + job.id.slice(0, 8) : "");
      }
    });
    // Insert before the copy-status span so it sits with the other actions.
    if (copyStatus && copyStatus.parentNode === batchJobActions) {
      batchJobActions.insertBefore(batchExportBar, copyStatus);
    } else {
      batchJobActions.appendChild(batchExportBar);
    }
  }

  // =========================================================================
  // polling fallback (no WebSocket support / construct failure)
  // =========================================================================
  function pollOnce() {
    if (!job) return;
    setConn("retrying");
    fetch("/api/jobs/" + encodeURIComponent(job.id), { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) {
        if (state) applyJobMeta(Object.assign({ event: "job_state" }, state));
        if (state && (state.status === "complete" || state.status === "done")) {
          loadFinishedResults(job.id);
        } else if (job && !job.done) {
          job.reconnectTimer = setTimeout(pollOnce, 4000);
        }
      })
      .catch(function () {
        if (job && !job.done) job.reconnectTimer = setTimeout(pollOnce, 5000);
      });
  }

  // =========================================================================
  // wire up
  // =========================================================================
  function bindBatch() {
    if (batchMaxPdfsEl) batchMaxPdfsEl.textContent = String(MAX_PDFS_PER_JOB);

    // Mode switch (4-way: Single / Batch / Library / Ask).
    modeSingleBtn.addEventListener("click", function () { setMode("single"); });
    modeBatchBtn.addEventListener("click", function () { setMode("batch"); });
    if (modeBtns.library) modeBtns.library.addEventListener("click", function () { setMode("library"); });
    if (modeBtns.ask) modeBtns.ask.addEventListener("click", function () { setMode("ask"); });

    // Batch dropzone.
    batchDropzone.addEventListener("click", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("batch-file-x")) return;
      batchFileInput.click();
    });
    batchDropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); batchFileInput.click(); }
    });
    batchFileInput.addEventListener("change", function () {
      if (batchFileInput.files && batchFileInput.files.length) addFiles(batchFileInput.files);
      batchFileInput.value = "";  // allow re-selecting the same files
    });
    ["dragenter", "dragover"].forEach(function (ev) {
      batchDropzone.addEventListener(ev, function (e) { e.preventDefault(); e.stopPropagation(); batchDropzone.classList.add("dragover"); });
    });
    ["dragleave", "dragend"].forEach(function (ev) {
      batchDropzone.addEventListener(ev, function (e) { e.preventDefault(); batchDropzone.classList.remove("dragover"); });
    });
    batchDropzone.addEventListener("drop", function (e) {
      e.preventDefault(); e.stopPropagation();
      batchDropzone.classList.remove("dragover");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    batchSubmitBtn.addEventListener("click", submitBatch);

    // The brand picker is shared; keep the batch submit button's enabled state in
    // sync with brand selection changes (clicks on chips/options/select-all).
    if (brandChipsHost) {
      var mo = new MutationObserver(function () { refreshBatchSubmitEnabled(); });
      mo.observe(brandChipsHost, { childList: true, subtree: true });
    }

    copyLinkBtn.addEventListener("click", copyShareLink);
    downloadAllBtn.addEventListener("click", downloadAll);

    // Reconnect on tab focus / network resume.
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onVisibility);

    // React to hash changes (user pastes a #job-<id> link, or navigates back).
    window.addEventListener("hashchange", function () {
      var id = jobIdFromHash();
      if (id && (!job || job.id !== id)) startJob(id, { fresh: false });
    });
  }

  // On load: if the URL points at a job (#job-<id>), reconnect to it / render the
  // finished snapshot — the persistent, shareable library behaviour.
  function initFromHash() {
    // #ask deep-links the Ask tab (symmetry with #job-/#lib/ — answers are
    // session-only, but the MODE itself is shareable/reload-stable).
    if (location.hash === "#ask") {
      setMode("ask", { silent: true });
      return;
    }
    var id = jobIdFromHash();
    if (!id) return;
    setMode("batch", { silent: true });

    // A results object is written during finalization, before the durable job
    // becomes terminal. Confirm terminal completion from the coordinator first;
    // running or failed jobs must replay their authoritative event stream.
    job = newJobState(id);
    jobPanel.hidden = false;
    setConn("connecting");
    setStatusText("Loading saved job…");
    loadJobState(id).then(function (state) {
      if (!job || job.id !== id) return;
      if (state && (state.status === "complete" || state.status === "done")) {
        loadFinishedResults(id).then(function (rendered) {
          if (!rendered && job && job.id === id) {
            startJob(id, { fresh: false });
          }
        });
        return;
      }
      startJob(id, { fresh: false });
    });
  }

  // =========================================================================
  // shared mode controller surface (consumed by public/library.js + ask.js)
  // =========================================================================
  // Library/Ask modes reuse this 4-way switch rather than duplicating
  // body.mode-* bookkeeping. We expose just enough: drive the active mode,
  // read it, and subscribe to changes. Namespaced under PA.modes so it is the
  // only new leak.
  PA.modes = {
    set: function (m, opts) { setMode(m, opts); },
    get: function () { return mode; },
    onModeChange: function (cb) { if (typeof cb === "function") modeChangeCbs.push(cb); }
  };

  // W5 cohorts integration surface (consumed by public/cohorts.js). Lets the
  // cohorts view open the batch stream for a (re-run) jobId — reusing the SAME
  // JobCoordinator path, hash routing, replay + reconnect logic — and subscribe
  // to job-finished events so a "Save as cohort" affordance can appear. This is
  // the only new leak from this file beyond PA.modes; batch internals stay
  // private. Existing single/batch/library flows are untouched.
  PA.batch = {
    // Open (stream/replay) a job by id, switching to Batch mode. Used by the
    // cohort "Run now" action with the freshly-created re-run jobId, and is the
    // identical path a pasted #job-<id> link takes.
    open: function (jobId, opts) {
      if (!jobId) return;
      setHashJob(jobId);
      startJob(jobId, Object.assign({ fresh: true }, opts || {}));
    },
    // Register a callback fired when ANY batch job reaches a terminal state.
    // Payload: { jobId, total, completed, failed, brandsPerPdf }.
    onJobDone: function (cb) { if (typeof cb === "function") jobDoneCbs.push(cb); },
    // The id of the job currently loaded in Batch mode (or null).
    currentJobId: function () { return job ? job.id : null; },
    // Whether the currently-loaded job has finished.
    isCurrentJobDone: function () { return !!(job && job.done); }
  };

  // ---- init ---------------------------------------------------------------
  // Default to single mode (the live flow stays the default).
  setMode("single", { silent: true });
  bindBatch();
  initFromHash();
})();
