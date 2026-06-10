/* =========================================================================
   Prior-Authorization Access Analyzer — cohorts.js  (Layer 5, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /cohorts.js, no inline code).

   W5 SAVED COHORTS + VERSIONING + WEBHOOK (frontend).

   A COHORT is a named, persistent set of policy PDFs + {brands, runs, explain}
   + optional webhook_url + schedule_enabled. This file adds, entirely
   additively:

     1. "Save as cohort" on a FINISHED batch job — prompts for a name, then
        POST /api/cohorts { name, source_job_id }. The server copies the job's
        PDFs into persistent R2 (cohorts/<id>/*) and seeds config from the job.

     2. A Cohorts MANAGEMENT view, reached via a segmented control inside
        Library mode (the 3-way mode switch geometry is untouched). It lists the
        owner's cohorts, and per cohort:
          - "Run now" -> POST /api/cohorts/:id/run -> opens the batch stream for
            the returned jobId (reusing PA.batch.open, the same JobCoordinator
            path a #job-<id> link takes).
          - configure webhook_url + a daily-schedule toggle (PATCH).
          - a runs/versions list (GET /api/cohorts/:id/runs).
          - "Compare" two runs (GET /api/cohorts/:id/compare?a=&b=) -> a diff
            table highlighting changed (pdf, brand, field) cells (old -> new).

   Everything REUSES the shared window.PA surface (renderers, helpers, the
   3-way mode switch PA.modes, and the batch open/job-done hooks PA.batch) plus
   the design system in styles.css. No new globals beyond reading window.PA.

   Cohort API consumed here (owner-scoped server-side via cf-access email):
     POST   /api/cohorts                  body {name, source_job_id, ...}
     GET    /api/cohorts                  -> { cohorts:[...] }  (+ last run)
     PATCH  /api/cohorts/:id              body {webhook_url?, schedule_enabled?,
                                                 brands?, runs?, explain?, name?}
     DELETE /api/cohorts/:id              -> { ok:true }
     POST   /api/cohorts/:id/run          -> { jobId, runId }
     GET    /api/cohorts/:id/runs         -> { runs:[...] }
     GET    /api/cohorts/:id/compare?a=&b=
                                          -> { changes:[{filename,brand,field,a,b}],
                                               unchanged_count, ... }
   ========================================================================= */
(function () {
  "use strict";

  // Shared surface from app.js. Bail quietly if absent — every other flow keeps
  // working and cohorts simply stays dormant.
  var PA = window.PA;
  if (!PA) return;

  var $ = function (id) { return document.getElementById(id); };
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }

  // ---- element refs -------------------------------------------------------
  // Library sub-view switch (Analyses / Cohorts).
  var viewSwitch = $("lib-view-switch");
  var viewAnalysesBtn = $("lib-view-analyses");
  var viewCohortsBtn = $("lib-view-cohorts");
  var cohortsCountBadge = $("cohorts-count");

  // List panel.
  var listPanel = $("cohorts-list-panel");
  var listTotal = $("cohorts-total");
  var listRefresh = $("cohorts-refresh");
  var listEmpty = $("cohorts-empty");
  var listCards = $("cohorts-cards");

  // Error box.
  var errBox = $("cohorts-error");
  var errMsg = $("cohorts-error-message");

  // Detail panel.
  var detailPanel = $("cohort-detail");
  var detailBack = $("cohort-detail-back");
  var detailTitle = $("cohort-detail-title");
  var detailName = detailPanel ? detailPanel.querySelector(".cohort-detail-name") : null;
  var detailMeta = $("cohort-detail-meta");
  var runNowBtn = $("cohort-run-now");
  var deleteBtn = $("cohort-delete");

  // Config (webhook + schedule).
  var webhookInput = $("cohort-webhook");
  var scheduleToggle = $("cohort-schedule");
  var configSaveBtn = $("cohort-config-savebtn");
  var configStatus = $("cohort-config-status");

  // Runs / versions.
  var runsCount = $("cohort-runs-count");
  var runsEmpty = $("cohort-runs-empty");
  var runsWrap = $("cohort-runs-wrap");
  var runsBody = $("cohort-runs-body");
  var compareBtn = $("cohort-compare-btn");
  var runsHint = $("cohort-runs-hint");

  // Compare diff.
  var comparePanel = $("cohort-compare");
  var compareScope = $("cohort-compare-scope");
  var compareSummary = $("cohort-compare-summary");
  var compareEmpty = $("cohort-compare-empty");
  var compareWrap = $("cohort-compare-wrap");
  var diffBody = $("cohort-diff-body");
  var compareClose = $("cohort-compare-close");

  // "Save as cohort" button injected into the batch job header actions.
  var saveCohortBtn = $("batch-save-cohort");

  // ---- state --------------------------------------------------------------
  var subView = "analyses";        // "analyses" | "cohorts"
  var cohortsLoadedOnce = false;
  var listLoading = false;
  var openCohort = null;           // the cohort object currently in detail
  var runsLoading = false;
  var selectedRuns = [];           // up to 2 run ids picked for compare

  // =========================================================================
  // small helpers
  // =========================================================================
  function flashErr(msg) {
    if (!errMsg) return;
    errMsg.textContent = msg;
    show(errBox);
  }
  function clearErr() { hide(errBox); }

  // Epoch ms (or ISO string / seconds) -> friendly date+time. Tolerant of the
  // server returning seconds, ms, or an ISO timestamp for created_at.
  function fmtWhen(v) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    var d;
    if (!isNaN(n)) {
      // Heuristic: < 1e12 is plausibly seconds, else ms.
      d = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      d = new Date(v);
    }
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // CSV string OR array -> array of trimmed, non-empty brand names.
  function brandsToArray(v) {
    if (Array.isArray(v)) return v.filter(Boolean);
    if (typeof v === "string") return v.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }

  function truthy(v) {
    return v === true || v === 1 || v === "1" || v === "true";
  }

  function setBtnBusy(btn, busy) {
    if (!btn) return;
    if (busy) { btn.classList.add("is-loading"); btn.disabled = true; }
    else { btn.classList.remove("is-loading"); btn.disabled = false; }
  }

  // A short, human summary line for a run, derived from whatever summary shape
  // the server provides (summary_json / summary). Best-effort + defensive.
  function runSummaryText(run) {
    var s = run && (run.summary || run.summary_json);
    if (typeof s === "string") {
      try { s = JSON.parse(s); } catch (e) { return s.slice(0, 80); }
    }
    if (!s || typeof s !== "object") return run && run.status === "complete" ? "completed" : "—";
    var parts = [];
    var totals = s.totals || s;
    if (totals.completed_pdfs != null || totals.total_pdfs != null) {
      parts.push((totals.completed_pdfs != null ? totals.completed_pdfs : "?") +
        "/" + (totals.total_pdfs != null ? totals.total_pdfs : "?") + " PDFs");
    }
    if (totals.failed_pdfs) parts.push(totals.failed_pdfs + " failed");
    // Per-brand mean access score, if present.
    var scores = s.access_scores || s.per_brand || s.brand_scores;
    if (scores && typeof scores === "object") {
      var vals = Object.keys(scores).map(function (k) { return Number(scores[k]); }).filter(function (x) { return !isNaN(x); });
      if (vals.length) {
        var mean = Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
        parts.push("avg access " + mean);
      }
    }
    return parts.length ? parts.join(" · ") : "—";
  }

  // =========================================================================
  // Library sub-view switching (Analyses <-> Cohorts)
  // =========================================================================
  function setSubView(next) {
    if (next !== "analyses" && next !== "cohorts") return;
    subView = next;
    var cohorts = next === "cohorts";
    document.body.classList.toggle("cohorts-active", cohorts);

    if (viewAnalysesBtn) {
      viewAnalysesBtn.classList.toggle("is-active", !cohorts);
      viewAnalysesBtn.setAttribute("aria-selected", cohorts ? "false" : "true");
    }
    if (viewCohortsBtn) {
      viewCohortsBtn.classList.toggle("is-active", cohorts);
      viewCohortsBtn.setAttribute("aria-selected", cohorts ? "true" : "false");
    }

    if (cohorts) {
      clearErr();
      // Show the list by default (hide detail) when entering the cohorts view.
      showCohortList();
      if (!cohortsLoadedOnce) loadCohorts();
    } else {
      // Returning to Analyses: the analyses panels are CSS-gated back on by
      // removing body.cohorts-active. library.js still owns their content.
      clearErr();
    }
  }

  function showCohortList() {
    hide(detailPanel);
    hide(comparePanel);
    show(listPanel);
    PA.revealNow(listPanel);
  }

  // =========================================================================
  // GET /api/cohorts — the list
  // =========================================================================
  function loadCohorts() {
    if (listLoading) return;
    listLoading = true;
    clearErr();
    if (listRefresh) listRefresh.classList.add("is-busy");

    fetch("/api/cohorts", { headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        cohortsLoadedOnce = true;
        var cohorts = (data && (data.cohorts || data.rows)) || [];
        renderCohortList(cohorts);
      })
      .catch(function (err) {
        flashErr("Could not load cohorts — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () {
        listLoading = false;
        if (listRefresh) listRefresh.classList.remove("is-busy");
      });
  }

  function renderCohortList(cohorts) {
    var n = cohorts.length;
    if (listTotal) listTotal.textContent = String(n);
    if (cohortsCountBadge) cohortsCountBadge.textContent = String(n);
    PA.clearChildren(listCards);

    if (!n) {
      hide(listCards);
      show(listEmpty);
      return;
    }
    hide(listEmpty);
    show(listCards);
    cohorts.forEach(function (c, i) {
      listCards.appendChild(buildCohortCard(c, i));
    });
  }

  function buildCohortCard(c, i) {
    var card = PA.el("button", "cohort-card");
    card.type = "button";
    if (!PA.reducedMotion()) card.style.setProperty("--rd", (Math.min(i, 14) * 40) + "ms");
    card.setAttribute("aria-label", "Open cohort " + (c.name || "untitled"));

    // Head: name + PDF count.
    var head = PA.el("div", "cohort-card-head");
    head.appendChild(PA.el("span", "cohort-card-name", c.name || "Untitled cohort"));
    var pdfCount = (c.pdf_count != null) ? c.pdf_count : (c.pdfCount != null ? c.pdfCount : "—");
    head.appendChild(PA.el("span", "count-badge", String(pdfCount) + " PDF" + (pdfCount === 1 ? "" : "s")));
    card.appendChild(head);

    // Brand pills (capped) + config summary.
    var brands = brandsToArray(c.brands);
    var brandsWrap = PA.el("div", "cohort-card-brands");
    brands.slice(0, 6).forEach(function (b) {
      brandsWrap.appendChild(PA.el("span", "pill pill-brand", b));
    });
    if (brands.length > 6) brandsWrap.appendChild(PA.el("span", "pill pill-ghost", "+" + (brands.length - 6)));
    if (!brands.length) brandsWrap.appendChild(PA.el("span", "subtle", "default brands"));
    card.appendChild(brandsWrap);

    // Meta row: runs setting + explain + last run.
    var meta = PA.el("div", "cohort-card-meta subtle");
    var runsN = Number(c.runs) || 1;
    meta.appendChild(PA.el("span", null, runsN > 1 ? ("deep ×" + runsN) : "single run"));
    meta.appendChild(PA.el("span", null, truthy(c.explain) ? "quotes on" : "quotes off"));
    var lastRun = c.last_run || c.lastRun;
    meta.appendChild(PA.el("span", null, "last run " + (lastRun ? fmtWhen(lastRun.created_at || lastRun.when || lastRun) : "never")));
    card.appendChild(meta);

    // Foot: webhook + schedule badges.
    var foot = PA.el("div", "cohort-card-foot");
    if (c.webhook_url) {
      var hook = PA.el("span", "cohort-badge is-hook", "webhook");
      foot.appendChild(hook);
    }
    var sched = PA.el("span", "cohort-badge" + (truthy(c.schedule_enabled) ? " is-on" : ""),
      truthy(c.schedule_enabled) ? "scheduled daily" : "schedule off");
    foot.appendChild(sched);
    card.appendChild(foot);

    card.addEventListener("click", function () { openDetail(c); });
    return card;
  }

  // =========================================================================
  // cohort detail
  // =========================================================================
  function openDetail(cohort) {
    openCohort = cohort;
    selectedRuns = [];
    clearErr();
    hide(listPanel);
    hide(comparePanel);
    show(detailPanel);
    PA.revealNow(detailPanel);

    var brands = brandsToArray(cohort.brands);
    if (detailName) detailName.textContent = cohort.name || "Untitled cohort";
    if (detailTitle) {
      var pc = (cohort.pdf_count != null) ? cohort.pdf_count : (cohort.pdfCount != null ? cohort.pdfCount : "?");
      detailTitle.textContent = pc + " PDF" + (pc === 1 ? "" : "s") +
        (brands.length ? (" · " + brands.length + " brand" + (brands.length === 1 ? "" : "s")) : "");
    }
    if (detailMeta) {
      var runsN = Number(cohort.runs) || 1;
      detailMeta.textContent = "Created " + fmtWhen(cohort.created_at) +
        " · " + (runsN > 1 ? ("deep confidence ×" + runsN) : "single run") +
        " · " + (truthy(cohort.explain) ? "source quotes on" : "source quotes off");
    }

    // Seed config controls.
    if (webhookInput) webhookInput.value = cohort.webhook_url || "";
    if (scheduleToggle) scheduleToggle.checked = truthy(cohort.schedule_enabled);
    if (configStatus) configStatus.textContent = "";

    // Reset compare + runs UI then load the runs.
    hide(comparePanel);
    if (compareBtn) compareBtn.disabled = true;
    loadRuns(cohort.id);
  }

  // =========================================================================
  // POST /api/cohorts/:id/run — re-run, then open the batch stream
  // =========================================================================
  function runNow() {
    if (!openCohort) return;
    var id = openCohort.id;
    setBtnBusy(runNowBtn, true);
    clearErr();

    fetch("/api/cohorts/" + encodeURIComponent(id) + "/run", {
      method: "POST",
      headers: { "Accept": "application/json" }
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!resp.ok || !data || !data.jobId) {
            throw new Error((data && data.error) || ("HTTP " + resp.status + (text ? (": " + text.slice(0, 160)) : "")));
          }
          return data;
        });
      })
      .then(function (data) {
        // Open the new job in the batch stream (switches to Batch mode). This is
        // the identical reconnectable path a pasted #job-<id> link takes.
        if (PA.batch && PA.batch.open) {
          PA.batch.open(data.jobId);
        } else if (PA.modes) {
          // Fallback: at least switch to batch + set the hash.
          location.hash = "#job-" + data.jobId;
          PA.modes.set("batch", {});
        }
      })
      .catch(function (err) {
        flashErr("Could not start a cohort run — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () {
        setBtnBusy(runNowBtn, false);
      });
  }

  // =========================================================================
  // DELETE /api/cohorts/:id
  // =========================================================================
  function deleteCohort() {
    if (!openCohort) return;
    var name = openCohort.name || "this cohort";
    // Native confirm is CSP-safe and dependency-free; destructive + persistent
    // (also deletes the cohort's R2 PDFs server-side), so a guard is warranted.
    if (!window.confirm("Delete “" + name + "”? This removes the cohort, its stored PDFs and all of its runs. This cannot be undone.")) return;

    var id = openCohort.id;
    setBtnBusy(deleteBtn, true);
    clearErr();

    fetch("/api/cohorts/" + encodeURIComponent(id), { method: "DELETE", headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (!resp.ok) return resp.text().then(function (t) { throw new Error("HTTP " + resp.status + (t ? (": " + t.slice(0, 160)) : "")); });
        return null;
      })
      .then(function () {
        openCohort = null;
        showCohortList();
        loadCohorts();
      })
      .catch(function (err) {
        flashErr("Could not delete the cohort — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () {
        setBtnBusy(deleteBtn, false);
      });
  }

  // =========================================================================
  // PATCH /api/cohorts/:id — webhook + schedule (+ name, validated server-side)
  // =========================================================================
  function saveConfig() {
    if (!openCohort) return;
    var id = openCohort.id;
    var url = webhookInput ? webhookInput.value.trim() : "";

    // Light client-side validation (server is authoritative + SSRF-guards).
    if (url && !/^https:\/\//i.test(url)) {
      if (configStatus) {
        configStatus.textContent = "Webhook must start with https://";
        configStatus.style.color = "var(--red-text)";
      }
      return;
    }

    var body = {
      // Send null to clear the webhook; the server treats null/empty as remove.
      webhook_url: url || null,
      schedule_enabled: scheduleToggle && scheduleToggle.checked ? 1 : 0
    };

    setBtnBusy(configSaveBtn, true);
    if (configStatus) { configStatus.textContent = ""; configStatus.style.color = ""; }

    fetch("/api/cohorts/" + encodeURIComponent(id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!resp.ok) throw new Error((data && data.error) || ("HTTP " + resp.status + (text ? (": " + text.slice(0, 160)) : "")));
          return data;
        });
      })
      .then(function (data) {
        // Reflect saved values locally so the list/detail stay in sync.
        openCohort.webhook_url = url || null;
        openCohort.schedule_enabled = body.schedule_enabled;
        if (configStatus) {
          configStatus.style.color = "";
          configStatus.textContent = "Saved";
          setTimeout(function () { if (configStatus) configStatus.textContent = ""; }, 1800);
        }
        // Keep the (already-loaded) list fresh next time it is shown.
        cohortsLoadedOnce = false;
      })
      .catch(function (err) {
        if (configStatus) {
          configStatus.style.color = "var(--red-text)";
          configStatus.textContent = (err && err.message) ? err.message : "Save failed";
        }
      })
      .finally(function () {
        setBtnBusy(configSaveBtn, false);
      });
  }

  // =========================================================================
  // GET /api/cohorts/:id/runs — versions list
  // =========================================================================
  function loadRuns(cohortId) {
    if (runsLoading) return;
    runsLoading = true;
    PA.clearChildren(runsBody);
    hide(runsWrap);
    hide(runsEmpty);

    fetch("/api/cohorts/" + encodeURIComponent(cohortId) + "/runs", { headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        var runs = (data && (data.runs || data.rows)) || [];
        renderRuns(runs);
      })
      .catch(function (err) {
        flashErr("Could not load this cohort's runs — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () { runsLoading = false; });
  }

  function renderRuns(runs) {
    if (runsCount) runsCount.textContent = String(runs.length);
    selectedRuns = [];
    updateCompareEnabled();
    PA.clearChildren(runsBody);

    if (!runs.length) {
      hide(runsWrap);
      show(runsEmpty);
      if (runsHint) runsHint.textContent = "Select two runs (A and B) to compare field-level changes between versions.";
      return;
    }
    hide(runsEmpty);
    show(runsWrap);

    runs.forEach(function (run, i) {
      runsBody.appendChild(buildRunRow(run, i));
    });
  }

  function buildRunRow(run, i) {
    var tr = document.createElement("tr");
    if (!PA.reducedMotion()) tr.style.setProperty("--rd", (Math.min(i, 14) * 30) + "ms");
    tr.className = "lib-row";

    var runId = run.id || run.run_id;

    // Compare checkbox.
    var tdPick = PA.el("td", null);
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "cohort-run-check";
    cb.value = String(runId);
    cb.setAttribute("aria-label", "Select run for comparison");
    cb.addEventListener("change", function () { onRunPick(cb, runId); });
    tdPick.appendChild(cb);
    tr.appendChild(tdPick);

    // Run label: short id + a version index (newest is highest).
    var tdRun = PA.el("td", null);
    var label = "v" + (run.version != null ? run.version : (run.idx != null ? run.idx : (i + 1)));
    var runLab = PA.el("span", "cohort-run-label", label);
    runLab.title = String(runId);
    tdRun.appendChild(runLab);
    tr.appendChild(tdRun);

    // Status pill.
    var tdStatus = PA.el("td", null);
    var status = run.status || "—";
    var pillCls = "pill cohort-run-status " +
      (status === "complete" || status === "done" ? "pill-brand"
        : status === "failed" || status === "error" ? "pill-ghost is-err" : "pill-ghost");
    tdStatus.appendChild(PA.el("span", pillCls, status));
    tr.appendChild(tdStatus);

    // Summary.
    var tdSummary = PA.el("td", null);
    tdSummary.appendChild(PA.el("span", "cohort-run-summary", runSummaryText(run)));
    tr.appendChild(tdSummary);

    // When.
    tr.appendChild(PA.el("td", null, fmtWhen(run.created_at || run.when)));

    // Open-job action (re-open the batch stream for this run's job).
    var tdOpen = PA.el("td", null);
    var jobId = run.job_id || run.jobId;
    if (jobId) {
      var openBtn = PA.el("button", "btn btn-ghost btn-sm cohort-run-open", "Open");
      openBtn.type = "button";
      openBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (PA.batch && PA.batch.open) PA.batch.open(jobId);
        else { location.hash = "#job-" + jobId; if (PA.modes) PA.modes.set("batch", {}); }
      });
      tdOpen.appendChild(openBtn);
    } else {
      tdOpen.appendChild(PA.el("span", "subtle", "—"));
    }
    tr.appendChild(tdOpen);

    return tr;
  }

  // Track up to two picked runs (A, B). A third pick replaces the oldest.
  function onRunPick(cb, runId) {
    var key = String(runId);
    if (cb.checked) {
      if (selectedRuns.indexOf(key) === -1) selectedRuns.push(key);
      // Cap at 2: uncheck + drop the oldest selection.
      while (selectedRuns.length > 2) {
        var drop = selectedRuns.shift();
        var box = runsBody.querySelector('input.cohort-run-check[value="' + cssEscape(drop) + '"]');
        if (box) box.checked = false;
      }
    } else {
      var idx = selectedRuns.indexOf(key);
      if (idx !== -1) selectedRuns.splice(idx, 1);
    }
    updateCompareEnabled();
  }

  // Minimal attribute-value escaper for the querySelector above (run ids are
  // server-issued, but be defensive against quotes/backslashes).
  function cssEscape(v) {
    return String(v).replace(/["\\]/g, "\\$&");
  }

  function updateCompareEnabled() {
    if (compareBtn) compareBtn.disabled = selectedRuns.length !== 2;
    if (runsHint) {
      runsHint.textContent = selectedRuns.length === 2
        ? "Two runs selected — click “Compare selected” to see field-level changes."
        : (selectedRuns.length === 1
          ? "One run selected — pick a second run to compare."
          : "Select two runs (A and B) to compare field-level changes between versions.");
    }
  }

  // =========================================================================
  // GET /api/cohorts/:id/compare?a=&b= — version diff
  // =========================================================================
  function runCompare() {
    if (!openCohort || selectedRuns.length !== 2) return;
    var id = openCohort.id;
    var a = selectedRuns[0], b = selectedRuns[1];

    setBtnBusy(compareBtn, true);
    clearErr();

    var url = "/api/cohorts/" + encodeURIComponent(id) + "/compare" +
      "?a=" + encodeURIComponent(a) + "&b=" + encodeURIComponent(b);

    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        renderDiff(data, a, b);
      })
      .catch(function (err) {
        flashErr("Could not compare these runs — " + (err && err.message ? err.message : "network error") + ".");
      })
      .finally(function () {
        // Re-enable per the current selection (compare consumed nothing).
        if (compareBtn) compareBtn.disabled = selectedRuns.length !== 2;
        compareBtn.classList.remove("is-loading");
      });
  }

  function renderDiff(data, aId, bId) {
    var changes = (data && data.changes) || [];
    var unchanged = (data && (data.unchanged_count != null ? data.unchanged_count
      : data.unchanged != null ? data.unchanged : null));

    show(comparePanel);
    PA.revealNow(comparePanel);
    if (compareScope) {
      compareScope.textContent = "· run " + String(aId).slice(0, 6) + " (A) → " + String(bId).slice(0, 6) + " (B)";
    }
    if (compareSummary) {
      var bits = [changes.length + " changed field" + (changes.length === 1 ? "" : "s")];
      if (unchanged != null) bits.push(unchanged + " unchanged");
      compareSummary.textContent = bits.join(" · ") + ".";
    }

    PA.clearChildren(diffBody);

    if (!changes.length) {
      hide(compareWrap);
      show(compareEmpty);
      if (comparePanel && comparePanel.scrollIntoView) {
        comparePanel.scrollIntoView({ block: "nearest", behavior: PA.reducedMotion() ? "auto" : "smooth" });
      }
      return;
    }
    hide(compareEmpty);
    show(compareWrap);

    changes.forEach(function (ch, i) {
      var tr = document.createElement("tr");
      tr.className = "is-changed";
      if (!PA.reducedMotion()) tr.style.setProperty("--rd", (Math.min(i, 16) * 25) + "ms");

      var tdFile = PA.el("td", null);
      var fileChip = PA.el("span", "lib-file-cell", ch.filename || "—");
      fileChip.title = ch.filename || "";
      tdFile.appendChild(fileChip);
      tr.appendChild(tdFile);

      var tdBrand = PA.el("td", null);
      tdBrand.appendChild(PA.el("span", "pill pill-brand", ch.brand || "—"));
      tr.appendChild(tdBrand);

      tr.appendChild(PA.el("td", "cohort-diff-field", ch.field || "—"));

      var tdA = PA.el("td", null);
      tdA.appendChild(PA.el("span", "cohort-diff-old", diffVal(ch.a)));
      tr.appendChild(tdA);

      var tdB = PA.el("td", null);
      tdB.appendChild(PA.el("span", "cohort-diff-new", diffVal(ch.b)));
      tr.appendChild(tdB);

      diffBody.appendChild(tr);
    });
  }

  // Render a diff cell value readably (null/empty -> em dash; objects -> JSON).
  function diffVal(v) {
    if (v == null || v === "") return "—";
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  // =========================================================================
  // "Save as cohort" — on a finished batch job (POST /api/cohorts)
  // =========================================================================
  // Surfaced when a batch job finishes (PA.batch.onJobDone). The button POSTs
  // { name, source_job_id } and the server copies the job's PDFs into the
  // persistent cohort store + seeds config from the job.
  function onJobDone(desc) {
    if (!saveCohortBtn || !desc || !desc.jobId) return;
    // A newly-finished job is always saveable: reset any prior "saved"/"failed"
    // state on the button and surface it with the current jobId.
    saveCohortBtn.dataset.jobId = desc.jobId;
    saveCohortBtn.disabled = false;
    saveCohortBtn.classList.remove("is-loading");
    saveCohortBtn.textContent = "Save as cohort";
    show(saveCohortBtn);
  }

  function saveAsCohort() {
    if (!saveCohortBtn) return;
    var jobId = (PA.batch && PA.batch.currentJobId && PA.batch.currentJobId()) ||
      saveCohortBtn.dataset.jobId;
    if (!jobId) return;

    var name = window.prompt("Name this cohort (its PDFs + settings are saved persistently and can be re-run any time):", "");
    if (name == null) return;          // cancelled
    name = name.trim();
    if (!name) { name = "Cohort " + new Date().toLocaleDateString(); }

    setBtnBusy(saveCohortBtn, true);
    saveCohortBtn.textContent = "Saving…";

    fetch("/api/cohorts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ name: name, source_job_id: jobId })
    })
      .then(function (resp) {
        return resp.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          if (!resp.ok || !data) throw new Error((data && data.error) || ("HTTP " + resp.status + (text ? (": " + text.slice(0, 160)) : "")));
          return data;
        });
      })
      .then(function (data) {
        setBtnBusy(saveCohortBtn, false);
        saveCohortBtn.textContent = "Saved as cohort ✓";
        saveCohortBtn.disabled = true;
        // Force the cohorts list to refetch next time it is opened.
        cohortsLoadedOnce = false;
        if (cohortsCountBadge && data) {
          // Optimistic bump so the badge nudges the user toward the new cohort.
          var cur = parseInt(cohortsCountBadge.textContent, 10);
          if (!isNaN(cur)) cohortsCountBadge.textContent = String(cur + 1);
        }
      })
      .catch(function (err) {
        setBtnBusy(saveCohortBtn, false);
        saveCohortBtn.textContent = "Save failed — retry";
        flashErr("Could not save the cohort — " + (err && err.message ? err.message : "network error") + ".");
      });
  }

  // =========================================================================
  // mode + wiring
  // =========================================================================
  function onModeChange(next) {
    if (next === "library") {
      // The sub-view switch only makes sense in Library mode; reveal it and keep
      // whichever sub-view was last active. Default to Analyses on first entry.
      show(viewSwitch);
      if (subView === "cohorts") {
        showCohortList();
        if (!cohortsLoadedOnce) loadCohorts();
      }
    } else {
      // Leaving Library mode: hidden via .library-only CSS anyway, but drop the
      // cohorts-active body flag so the analyses panels are the default on
      // return and other modes are never affected.
      // (We keep subView state so the user returns to where they left off.)
    }
  }

  function bind() {
    // Sub-view switch.
    if (viewAnalysesBtn) viewAnalysesBtn.addEventListener("click", function () { setSubView("analyses"); });
    if (viewCohortsBtn) viewCohortsBtn.addEventListener("click", function () { setSubView("cohorts"); });

    // List.
    if (listRefresh) listRefresh.addEventListener("click", loadCohorts);

    // Detail.
    if (detailBack) detailBack.addEventListener("click", function () { showCohortList(); });
    if (runNowBtn) runNowBtn.addEventListener("click", runNow);
    if (deleteBtn) deleteBtn.addEventListener("click", deleteCohort);
    if (configSaveBtn) configSaveBtn.addEventListener("click", saveConfig);
    if (compareBtn) compareBtn.addEventListener("click", runCompare);
    if (compareClose) compareClose.addEventListener("click", function () { hide(comparePanel); });

    // Save-as-cohort (finished batch job).
    if (saveCohortBtn) saveCohortBtn.addEventListener("click", saveAsCohort);

    // Hooks from the shared surface.
    if (PA.modes && PA.modes.onModeChange) PA.modes.onModeChange(onModeChange);
    if (PA.batch && PA.batch.onJobDone) PA.batch.onJobDone(onJobDone);
  }

  // ---- init ---------------------------------------------------------------
  bind();
  // Reflect the current mode on load (e.g. a #job/#lib hash already switched it).
  if (PA.modes && PA.modes.get && PA.modes.get() === "library") {
    show(viewSwitch);
  }
})();
