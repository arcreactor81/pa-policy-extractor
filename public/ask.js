/* =========================================================================
   Prior-Authorization Access Analyzer — ask.js  (Layer 8, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /ask.js, no inline code).

   ASK mode: advisory Q&A over the caller's OWN knowledge corpus — the
   markdown digests written for every saved analysis and web check. This file
   ONLY adds behaviour and REUSES app.js's shared surface (window.PA) + the
   4-way mode switch (window.PA.modes, owned by batch.js). The Single live,
   Batch job and Library flows are left completely unchanged.

   Ask API consumed here (provided by the Worker + AI Search, src/knowledge.ts):
     POST /api/ask                {question: 1..1000 chars}
         -> 200 { answer: string|null, citations: [{key, snippet?, score?}] }
         |  503 { error } while the AI Search instance isn't created yet
         |  400/401/429 { error }
     POST /api/knowledge/backfill -> 200 { written, skipped }
         (digests the caller's existing library rows so Ask has a corpus)

   Citation keys look like
     knowledge/<owner-encoded>/<sha64>-<BRAND>.md            (analysis digest)
     knowledge/<owner-encoded>/<sha64>-<BRAND>-webcheck.md   (web-check digest)
   and are parsed into "BRAND · sha8" / "BRAND · web check" chip labels.
   ========================================================================= */
(function () {
  "use strict";

  // The shared surface app.js exports. If it is somehow absent (app.js failed
  // to load), bail quietly — the other modes keep working, Ask stays dormant.
  var PA = window.PA;
  if (!PA) return;

  var $ = function (id) { return document.getElementById(id); };
  var el = PA.el;

  // ---- constants ----------------------------------------------------------
  var MAX_Q_CHARS = 1000;     // mirrors MAX_QUESTION_CHARS server-side
  var MAX_HISTORY = 5;        // session-only question history (no persistence)
  var CHIP_CLIP = 64;         // history-chip label clip (full text in title)

  // The one-line setup hint appended under the server's 503 message.
  var SETUP_HINT =
    "Dashboard → AI → AI Search → create instance 'pa-knowledge' over the pa-knowledge bucket.";

  // ---- element refs -------------------------------------------------------
  var qInput = $("ask-q");
  var countEl = $("ask-count");
  var askBtn = $("ask-submit");
  var askLabel = $("ask-submit-label");
  var noteEl = $("ask-note");
  var resultsEl = $("ask-results");
  var historyEl = $("ask-history");
  var backfillBtn = $("ask-backfill");
  var backfillStatus = $("ask-backfill-status");

  // If the Ask DOM is absent (older index.html), stay dormant.
  if (!qInput || !askBtn || !resultsEl) return;

  // ---- state --------------------------------------------------------------
  var asking = false;       // a POST /api/ask is in flight
  var backfilling = false;  // a POST /api/knowledge/backfill is in flight
  var askSeq = 0;           // guards out-of-order responses across asks
  var history = [];         // session-only previous questions, newest first

  // ---- small helpers ------------------------------------------------------
  function show(n) { if (n) n.hidden = false; }
  function hide(n) { if (n) n.hidden = true; }
  function trim(s) { return String(s == null ? "" : s).replace(/^\s+|\s+$/g, ""); }

  // =========================================================================
  // citation-key parsing
  // =========================================================================
  // knowledge/<owner-encoded>/<sha64>-<BRAND>[-webcheck].md ->
  //   { brand, sha8, webcheck }. The BRAND segment is encodeURIComponent'd in
  //   the key; the sha is displayed as its first 8 hex chars. Anything that
  //   doesn't match degrades to showing the basename as the "brand".
  function parseCitationKey(key) {
    var s = String(key == null ? "" : key);
    var slash = s.lastIndexOf("/");
    var base = slash >= 0 ? s.slice(slash + 1) : s;
    if (/\.md$/i.test(base)) base = base.slice(0, -3);
    var webcheck = false;
    if (/-webcheck$/i.test(base)) {
      webcheck = true;
      base = base.slice(0, base.length - "-webcheck".length);
    }
    var brand = base, sha8 = "";
    var m = /^([0-9a-fA-F]{8,64})-(.+)$/.exec(base);
    if (m) {
      sha8 = m[1].slice(0, 8).toLowerCase();
      brand = m[2];
    }
    try { brand = decodeURIComponent(brand); } catch (e) { /* keep raw */ }
    return { brand: brand || "?", sha8: sha8, webcheck: webcheck };
  }

  // =========================================================================
  // notes (setup / rate-limit / failure) — one at a time, cleared on next ask
  // =========================================================================
  function clearNote() {
    hide(noteEl);
    if (noteEl) {
      PA.clearChildren(noteEl);
      noteEl.className = "ask-note";
    }
  }

  // kind: "amber" | "red" | "muted"; lines: [{text, hint?}...] rendered as
  // stacked <p> nodes (textContent only — never markup from the wire).
  function showNote(kind, lines) {
    if (!noteEl) return;
    PA.clearChildren(noteEl);
    noteEl.className = "ask-note ask-note-" + kind;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      noteEl.appendChild(el("p", "ask-note-line" + (line.hint ? " ask-note-hint" : ""), line.text));
    }
    show(noteEl);
  }

  // =========================================================================
  // answer + SOURCES rendering
  // =========================================================================
  function citeChip(c) {
    var key = c && c.key != null ? String(c.key) : "";
    var meta = parseCitationKey(key);
    var detail = meta.webcheck ? "web check" : (meta.sha8 || "digest");
    // A <span>, not a <button>: these are display-only source attributions
    // (P0 has no chip action), and a focusable button that does nothing on
    // Enter/Space is an accessibility lie. The full R2 key rides in title.
    var chip = el("span", "ask-cite-chip", meta.brand + " · " + detail);
    chip.title = key;
    return chip;
  }

  function renderAnswer(data) {
    PA.clearChildren(resultsEl);

    var answer = data && typeof data.answer === "string" ? trim(data.answer) : "";
    var citations = data && data.citations && data.citations.length ? data.citations : [];

    if (!answer) {
      // Empty corpus / nothing generated: serif-italic whisper, no SOURCES.
      resultsEl.appendChild(el("p", "ask-whisper",
        "No relevant documents in your corpus yet — run some analyses first, or build the knowledge base below."));
      return;
    }

    // The answer is MODEL TEXT: always textContent into <p> nodes (never
    // innerHTML). Paragraphs are preserved by splitting on blank lines.
    var ans = el("div", "ask-answer" + (PA.reducedMotion() ? "" : " ask-answer-in"));
    var paras = answer.split(/\n\s*\n/);
    for (var i = 0; i < paras.length; i++) {
      var p = trim(paras[i]);
      if (p) ans.appendChild(el("p", "ask-answer-p", p));
    }
    resultsEl.appendChild(ans);

    if (citations.length) {
      var src = el("div", "ask-sources");
      src.appendChild(el("span", "ask-sources-label", "Sources"));
      var chips = el("div", "ask-cite-chips");
      for (var j = 0; j < citations.length; j++) chips.appendChild(citeChip(citations[j]));
      src.appendChild(chips);
      resultsEl.appendChild(src);
    }
  }

  // =========================================================================
  // session-only question history (max 5, newest first, no persistence)
  // =========================================================================
  function pushHistory(q) {
    var next = [q];
    for (var i = 0; i < history.length && next.length < MAX_HISTORY; i++) {
      if (history[i] !== q) next.push(history[i]);
    }
    history = next;
    renderHistory();
  }

  function renderHistory() {
    if (!historyEl) return;
    PA.clearChildren(historyEl);
    if (!history.length) { hide(historyEl); return; }
    historyEl.appendChild(el("span", "ask-history-label", "Recent"));
    history.forEach(function (q) {
      var label = q.length > CHIP_CLIP ? q.slice(0, CHIP_CLIP - 1) + "…" : q;
      var chip = el("button", "ask-history-chip", label);
      chip.type = "button";
      chip.title = q;
      chip.setAttribute("aria-label", "Refill question: " + q);
      chip.addEventListener("click", function () {
        qInput.value = q;
        refreshCount();
        refreshAskEnabled();
        try { qInput.focus(); } catch (e) { /* ignore */ }
      });
      historyEl.appendChild(chip);
    });
    show(historyEl);
  }

  // =========================================================================
  // ask flow
  // =========================================================================
  function refreshCount() {
    if (countEl) countEl.textContent = qInput.value.length + " / " + MAX_Q_CHARS;
  }

  function refreshAskEnabled() {
    askBtn.disabled = asking || trim(qInput.value).length === 0;
  }

  function setAskBusy(b) {
    asking = b;
    askBtn.classList.toggle("is-loading", b);
    if (askLabel) askLabel.textContent = b ? "Asking…" : "Ask";
    refreshAskEnabled();
  }

  function ask() {
    if (asking) return;
    var q = trim(qInput.value);
    if (!q) return;
    if (q.length > MAX_Q_CHARS) q = q.slice(0, MAX_Q_CHARS); // server cap, belt + braces

    clearNote();                  // every new ask dismisses the previous note
    PA.clearChildren(resultsEl);
    pushHistory(q);
    setAskBusy(true);
    var seq = ++askSeq;

    fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ question: q })
    })
      .then(function (r) {
        // Read the JSON body even on errors (the server's {error} is the copy).
        return r.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (res) {
        if (seq !== askSeq) return; // a newer ask superseded this one
        setAskBusy(false);
        if (res.ok) { renderAnswer(res.data); return; }
        var msg = res.data && res.data.error ? String(res.data.error) : ("HTTP " + res.status);
        if (res.status === 503) {
          // Not configured yet: surface the server's message + the setup path.
          showNote("amber", [{ text: msg }, { text: SETUP_HINT, hint: true }]);
        } else if (res.status === 429) {
          showNote("muted", [{ text: msg }]); // server text includes the retry window
        } else {
          // 400 / 401 / 500: the server's error text, red-soft.
          showNote("red", [{ text: msg }]);
        }
      })
      .catch(function (err) {
        if (seq !== askSeq) return;
        setAskBusy(false);
        showNote("red", [{
          text: err && err.message ? "Network error: " + err.message : "Network error — try again."
        }]);
      });
  }

  // =========================================================================
  // knowledge-base backfill ("Index existing analyses")
  // =========================================================================
  function setBackfillBusy(b) {
    backfilling = b;
    if (backfillBtn) backfillBtn.disabled = b;
  }

  function backfill() {
    if (backfilling) return;
    setBackfillBusy(true);
    if (backfillStatus) {
      backfillStatus.className = "ask-kb-status";
      backfillStatus.textContent = "indexing…";
    }

    fetch("/api/knowledge/backfill", {
      method: "POST",
      headers: { "Accept": "application/json" }
    })
      .then(function (r) {
        return r.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: r.ok, status: r.status, data: data }; });
      })
      .then(function (res) {
        setBackfillBusy(false);
        if (!backfillStatus) return;
        if (res.ok) {
          var written = Number(res.data && res.data.written) || 0;
          var skipped = Number(res.data && res.data.skipped) || 0;
          backfillStatus.textContent =
            "indexed " + written + " analyses (" + skipped + " skipped)";
        } else if (res.status === 429) {
          backfillStatus.textContent = "rate limited — try again in a minute";
        } else {
          backfillStatus.className = "ask-kb-status is-err";
          backfillStatus.textContent =
            res.data && res.data.error ? String(res.data.error) : ("HTTP " + res.status);
        }
      })
      .catch(function () {
        setBackfillBusy(false);
        if (backfillStatus) {
          backfillStatus.className = "ask-kb-status is-err";
          backfillStatus.textContent = "network error — try again";
        }
      });
  }

  // =========================================================================
  // wire up
  // =========================================================================
  function bind() {
    qInput.addEventListener("input", function () {
      refreshCount();
      refreshAskEnabled();
    });
    // Ctrl/Cmd+Enter submits (plain Enter keeps inserting newlines).
    qInput.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (!askBtn.disabled) ask();
      }
    });
    askBtn.addEventListener("click", ask);
    if (backfillBtn) backfillBtn.addEventListener("click", backfill);
  }

  // ---- init ---------------------------------------------------------------
  bind();
  refreshCount();
  refreshAskEnabled();
})();
