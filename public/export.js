/* =========================================================================
   Prior-Authorization Access Analyzer — export.js  (Layer 6, ADDITIVE)
   Vanilla JS, no dependencies. CSP-safe (loaded as /export.js, no inline code;
   script-src 'self'). Loaded AFTER app.js / batch.js / library.js / analytics.js
   so window.PA (+ PA.modes, PA.analytics) exist.

   W4 EXPORTS — a small shared export module surfaced on:
     • a SINGLE result (all brands scored against the one policy),
     • a BATCH job (every PDF × brand in the job), and
     • a LIBRARY detail (the one saved result).

   Three actions, all pure client-side transforms (no new infra, no headless
   browser, no external deps):

     1. PRINT / SAVE-AS-PDF — builds a clean, print-optimized report off-screen
        (brand result card(s) via the SHARED #result-card-tpl renderers, the
        Access Score + justification, barrier profile, and any confidence /
        consensus / spans), then calls window.print(). @media print rules in
        styles.css hide the app chrome and show ONLY the report. The user saves
        as PDF via their browser's print dialog.

     2. FHIR EXPORT — transforms the result(s) into a FHIR R4 Bundle of
        MedicationKnowledge resources (one per brand). The brand maps to
        MedicationKnowledge.code; the PA parameters map into a defensible set of
        fields (.regulatory, .drugCharacteristic + extensions). Downloaded as
        <name>.fhir.json. Clearly labelled as an ILLUSTRATIVE / best-effort
        mapping (it is NOT a clinically validated profile).

     3. CSV / JSON EXPORT — CSV in the ORIGINAL 15-column schema (one row per
        (PDF, brand), RFC-4180 quoting/escaping); JSON = the full result objects
        (incl. justification, confidence, spans, consensus). Client-side
        download via a Blob/data: URI on an <a download> — the same CSP-safe
        pattern as app.js's existing "Download JSON".

   The result-ish object this module consumes is the SAME shape app.js/batch.js
   render: an AnalyzeEvent / ExtractResult with
     { brand?, result:{15 cols}, access_justification, meta, policy_text,
       confidence?, spans?, consensus? }
   plus an optional { filename } (batch carries the per-PDF name).

   Exposes window.PA.exports for the three surfaces to call. Each call site
   guards on PA.exports existing, so if this file fails to load the rest of the
   dashboard is unaffected.
   ========================================================================= */
(function () {
  "use strict";

  var PA = window.PA;
  if (!PA) return;

  // The 15 deliverable column keys (exact Submissions-tab headers), in order.
  // Mirrors src/types.ts ResultRow. This is the canonical CSV schema.
  var CSV_COLUMNS = [
    "Filename",
    "Brand",
    "Age",
    "Step Therapy Requirements Documented in Policy",
    "Number of Steps through Brands",
    "Number of Steps through Generic",
    "Step through-Phototherapy",
    "TB Test required",
    "Quantity Limits",
    "Specialist Types",
    "Initial Authorization Duration(in-months)",
    "Reauthorization Duration(in-months)",
    "Reauthorization Required",
    "Reauthorization Requirements Documented in Policy",
    "Access Score"
  ];

  // =========================================================================
  // normalization — accept the various result-ish shapes used across surfaces
  // =========================================================================
  // Returns a normalized record: { brand, filename, result, access_justification,
  // meta, policy_text, confidence, spans, consensus }. Tolerates:
  //   • a `result` AnalyzeEvent ({ brand, result:{...}, ... })
  //   • a stored ExtractResult ({ result:{...}, ... })
  //   • the batch row wrapper ({ filename, brand, data:{...} })
  function normalize(obj) {
    if (!obj || typeof obj !== "object") return null;
    // Batch row wrapper: { pdfIndex, filename, brand, data:ExtractResult }.
    if (obj.data && typeof obj.data === "object" && obj.data.result) {
      return normalize(Object.assign({ filename: obj.filename, brand: obj.brand }, obj.data));
    }
    var res = obj.result;
    if (!res || typeof res !== "object") return null;
    return {
      brand: obj.brand || res.Brand || "",
      filename: obj.filename || res.Filename || "",
      result: res,
      access_justification: obj.access_justification || "",
      meta: obj.meta || null,
      policy_text: obj.policy_text || "",
      confidence: obj.confidence || null,
      spans: obj.spans || null,
      consensus: obj.consensus || null
    };
  }

  function normalizeAll(items) {
    return (items || []).map(normalize).filter(Boolean);
  }

  // A filesystem-safe base name from the export scope.
  function safeBase(name) {
    var s = String(name || "pa-export").replace(/\.pdf$/i, "");
    s = s.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    return s || "pa-export";
  }

  // =========================================================================
  // CSP-safe download — Blob URL preferred (handles large CSVs), data: URI
  // fallback. Mirrors batch.js downloadAll() exactly.
  // =========================================================================
  function downloadText(text, filename, mime) {
    mime = mime || "application/octet-stream";
    try {
      var blob = new Blob([text], { type: mime + ";charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      var durl = "data:" + mime + ";charset=utf-8," + encodeURIComponent(text);
      var a2 = document.createElement("a");
      a2.href = durl; a2.download = filename;
      document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
    }
  }

  // =========================================================================
  // 1. CSV — original 15-column schema, one row per (PDF, brand).
  // =========================================================================
  // RFC-4180 quoting: a field is wrapped in double quotes when it contains a
  // comma, a double quote, CR or LF; embedded double quotes are doubled. We
  // ALWAYS quote here for maximum interoperability (Excel/Sheets) and to avoid
  // edge cases (leading +/-/=/@ formula-injection, leading/trailing spaces).
  function csvCell(value) {
    var s = (value == null) ? "" : String(value);
    // Excel formula-injection guard: a cell that begins with = + - @ (or a
    // tab/CR that could be interpreted as one) is prefixed with a single quote
    // so spreadsheet apps treat it as text, not a formula. Harmless for plain
    // data and still round-trips as text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(items) {
    var norm = normalizeAll(items);
    var lines = [];
    lines.push(CSV_COLUMNS.map(csvCell).join(","));
    norm.forEach(function (n) {
      var res = n.result || {};
      var row = CSV_COLUMNS.map(function (col) {
        // Filename/Brand fall back to the normalized scope values when the
        // result row omitted them.
        var v = res[col];
        if ((v == null || v === "") && col === "Filename") v = n.filename;
        if ((v == null || v === "") && col === "Brand") v = n.brand;
        return csvCell(v);
      });
      lines.push(row.join(","));
    });
    // CRLF line endings are the RFC-4180 default and the most Excel-friendly.
    return lines.join("\r\n") + "\r\n";
  }

  function downloadCsv(items, base) {
    var csv = toCsv(items);
    downloadText(csv, safeBase(base) + ".csv", "text/csv");
  }

  // =========================================================================
  // 2. JSON — the FULL result objects (justification, confidence, spans,
  // consensus). One self-describing document; an array of result objects.
  // =========================================================================
  function toJsonDoc(items, scope) {
    var norm = normalizeAll(items);
    return {
      export_kind: "pa-access-analyzer-results",
      generated_at: new Date().toISOString(),
      scope: scope || "results",
      count: norm.length,
      results: norm.map(function (n) {
        var out = {
          filename: n.filename,
          brand: n.brand,
          result: n.result,
          access_justification: n.access_justification,
          meta: n.meta,
          policy_text: n.policy_text
        };
        // Include the optional maps only when present (byte-clean otherwise).
        if (n.confidence) out.confidence = n.confidence;
        if (n.spans) out.spans = n.spans;
        if (n.consensus) out.consensus = n.consensus;
        return out;
      })
    };
  }

  function downloadJson(items, base, scope) {
    var json = JSON.stringify(toJsonDoc(items, scope), null, 2);
    downloadText(json, safeBase(base) + ".json", "application/json");
  }

  // =========================================================================
  // 3. FHIR R4 — Bundle of MedicationKnowledge resources (one per brand).
  // =========================================================================
  // ILLUSTRATIVE / best-effort mapping. This is a defensible, machine-readable
  // representation of the extracted PA parameters using FHIR R4
  // MedicationKnowledge — it is NOT a clinically validated FHIR profile and
  // should not be used for production interoperability without review. Every
  // resource carries an explicit disclaimer extension + text note saying so.

  var FHIR_EXT_BASE = "https://pa-access-analyzer.example/fhir/StructureDefinition/";
  var FHIR_CS_BASE = "https://pa-access-analyzer.example/fhir/CodeSystem/";

  function isBlank(v) {
    var s = String(v == null ? "" : v).trim().toLowerCase();
    return s === "" || s === "na" || s === "n/a" || s === "unspecified" || s === "none";
  }

  // A drugCharacteristic entry: { code:{text}, value[x] }. We use valueString
  // for everything (display strings) so a single shape covers all params.
  function drugChar(typeText, value) {
    return {
      type: { text: typeText },
      valueString: String(value)
    };
  }

  // A simple typed extension carrying one value as a string.
  function strExt(name, value) {
    return { url: FHIR_EXT_BASE + name, valueString: String(value) };
  }
  function boolExt(name, value) {
    return { url: FHIR_EXT_BASE + name, valueBoolean: !!value };
  }
  function intExt(name, value) {
    return { url: FHIR_EXT_BASE + name, valueInteger: Number(value) };
  }

  // yes/no display string -> boolean | null (null when unknown/NA).
  function yesNo(v) {
    if (isBlank(v)) return null;
    var s = String(v).trim().toLowerCase();
    if (s === "yes" || s === "true" || s === "required") return true;
    if (s === "no" || s === "false" || s === "not required") return false;
    return null;
  }

  // Build ONE MedicationKnowledge resource from a normalized record.
  function toMedicationKnowledge(n, idx) {
    var res = n.result || {};
    var brand = res["Brand"] || n.brand || "UNKNOWN";
    var filename = res["Filename"] || n.filename || "";
    var score = PA.snapScore(res["Access Score"]);
    var sm = PA.SCORE_META[score] || PA.SCORE_META[0];

    // ---- regulatory: step therapy, durations, reauth as a maxDispense /
    // schedule-ish block. FHIR R4 MedicationKnowledge.regulatory[] carries a
    // regulatoryAuthority + maxDispense + schedule; we attach our PA detail as
    // extensions on the regulatory element so the structure stays valid R4. ----
    var regExtensions = [];
    var stepBranded = res["Number of Steps through Brands"];
    var stepGeneric = res["Number of Steps through Generic"];
    if (!isBlank(stepBranded)) regExtensions.push(strExt("step-therapy-branded-count", stepBranded));
    if (!isBlank(stepGeneric)) regExtensions.push(strExt("step-therapy-generic-count", stepGeneric));
    var photo = yesNo(res["Step through-Phototherapy"]);
    if (photo !== null) regExtensions.push(boolExt("step-therapy-phototherapy-required", photo));
    if (!isBlank(res["Step Therapy Requirements Documented in Policy"])) {
      regExtensions.push(strExt("step-therapy-requirements", res["Step Therapy Requirements Documented in Policy"]));
    }
    var reauthReq = yesNo(res["Reauthorization Required"]);
    if (reauthReq !== null) regExtensions.push(boolExt("reauthorization-required", reauthReq));
    if (!isBlank(res["Reauthorization Requirements Documented in Policy"])) {
      regExtensions.push(strExt("reauthorization-requirements", res["Reauthorization Requirements Documented in Policy"]));
    }
    var initMonths = res["Initial Authorization Duration(in-months)"];
    var reauthMonths = res["Reauthorization Duration(in-months)"];
    if (!isBlank(initMonths)) regExtensions.push(strExt("initial-authorization-duration-months", initMonths));
    if (!isBlank(reauthMonths)) regExtensions.push(strExt("reauthorization-duration-months", reauthMonths));

    var regulatory = {
      regulatoryAuthority: {
        display: "Payer prior-authorization policy (extracted)" + (filename ? " — " + filename : "")
      }
    };
    if (regExtensions.length) regulatory.extension = regExtensions;

    // ---- drugCharacteristic: eligibility + UM params that read naturally as
    // "characteristics" of how the drug is covered. ----
    var characteristics = [];
    if (!isBlank(res["Age"])) characteristics.push(drugChar("Minimum age requirement", res["Age"]));
    if (!isBlank(res["TB Test required"])) characteristics.push(drugChar("TB test required before therapy", res["TB Test required"]));
    if (!isBlank(res["Quantity Limits"])) characteristics.push(drugChar("Quantity limits", res["Quantity Limits"]));
    if (!isBlank(res["Specialist Types"])) characteristics.push(drugChar("Specialist prescriber types required", res["Specialist Types"]));

    // ---- Access Score + justification as a top-level extension (our headline
    // derived metric) and mirrored into a human-readable note below. ----
    var accessExt = {
      url: FHIR_EXT_BASE + "access-score",
      extension: [
        intExt("value", score),
        strExt("bucket", sm.label),
        strExt("interpretation", sm.meaning)
      ]
    };
    if (n.access_justification) {
      accessExt.extension.push(strExt("justification", n.access_justification));
    }

    // ---- provenance / confidence / consensus as extensions (best-effort). ----
    var provExtensions = [];
    if (n.meta) {
      if (n.meta.model) provExtensions.push(strExt("extraction-model", n.meta.model));
      if (typeof n.meta.runs === "number") provExtensions.push(intExt("extraction-runs", n.meta.runs));
    }
    if (n.consensus) {
      // Count UNANIMOUS fields (every model produced the same value). Handles the
      // N-validator shape ({primary, validators, agree_count, total, unanimous})
      // and the legacy single-secondary shape ({primary, secondary, agree}).
      var total = 0, agree = 0;
      for (var k in n.consensus) {
        if (!n.consensus.hasOwnProperty(k) || !n.consensus[k]) continue;
        var c = n.consensus[k];
        total++;
        var ok = (typeof c.unanimous === "boolean") ? c.unanimous
          : (Array.isArray(c.validators)
              ? (typeof c.agree_count === "number" && typeof c.total === "number"
                  ? c.agree_count === c.total : false)
              : !!c.agree);
        if (ok) agree++;
      }
      if (total) {
        provExtensions.push({
          url: FHIR_EXT_BASE + "model-consensus",
          extension: [intExt("fields-compared", total), intExt("fields-agreed", agree)]
        });
      }
    }

    var extensions = [
      {
        url: FHIR_EXT_BASE + "disclaimer",
        valueString: "ILLUSTRATIVE best-effort mapping of an extracted prior-authorization " +
          "policy to FHIR R4 MedicationKnowledge. NOT a clinically validated FHIR profile; " +
          "do not use for production interoperability without review."
      },
      accessExt
    ];
    if (provExtensions.length) {
      extensions.push({ url: FHIR_EXT_BASE + "extraction-provenance", extension: provExtensions });
    }

    // Human-readable narrative (FHIR DomainResource.text). XHTML, escaped.
    var narrativeBits = [
      "Access Score: " + score + " (" + sm.label + ").",
      n.access_justification ? ("Justification: " + n.access_justification) : "",
      "Illustrative FHIR mapping — not a validated profile."
    ].filter(Boolean);

    var mk = {
      resourceType: "MedicationKnowledge",
      id: "mk-" + safeBase(brand).toLowerCase() + "-" + (idx + 1),
      meta: {
        tag: [{
          system: FHIR_CS_BASE + "export-kind",
          code: "pa-access-analyzer",
          display: "Illustrative PA access mapping"
        }]
      },
      text: {
        status: "generated",
        div: '<div xmlns="http://www.w3.org/1999/xhtml">' +
          escapeHtml(brand + " — " + narrativeBits.join(" ")) + "</div>"
      },
      extension: extensions,
      // Brand -> MedicationKnowledge.code.
      code: {
        coding: [{
          system: FHIR_CS_BASE + "brand",
          code: brand,
          display: brand
        }],
        text: brand
      },
      status: "active",
      regulatory: [regulatory]
    };
    if (characteristics.length) mk.drugCharacteristic = characteristics;

    return mk;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toFhirBundle(items) {
    var norm = normalizeAll(items);
    var entries = norm.map(function (n, i) {
      var mk = toMedicationKnowledge(n, i);
      return {
        // No persistent server, so a urn:uuid fullUrl keeps the Bundle valid
        // and self-contained (a "collection" Bundle).
        fullUrl: "urn:uuid:" + pseudoUuid(),
        resource: mk
      };
    });
    return {
      resourceType: "Bundle",
      type: "collection",
      timestamp: new Date().toISOString(),
      meta: {
        tag: [{
          system: FHIR_CS_BASE + "export-kind",
          code: "pa-access-analyzer",
          display: "Illustrative best-effort PA access mapping — not a validated FHIR profile"
        }]
      },
      entry: entries
    };
  }

  // RFC-4122-ish v4 uuid (best-effort; crypto.randomUUID when available).
  function pseudoUuid() {
    try {
      if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (e) { /* fall through */ }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === "x" ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function downloadFhir(items, base) {
    var bundle = toFhirBundle(items);
    var json = JSON.stringify(bundle, null, 2);
    downloadText(json, safeBase(base) + ".fhir.json", "application/fhir+json");
  }

  // =========================================================================
  // PRINT / SAVE-AS-PDF — build a clean report off-screen, window.print().
  // =========================================================================
  // The report reuses the SHARED #result-card-tpl renderers (PA.cloneBrandCard +
  // PA.populateBrandCard) so the printed result card(s) are byte-identical to
  // the on-screen ones (score gauge, justification, barrier profile, parameter
  // cards, and any confidence/consensus/spans). @media print rules in styles.css
  // hide #print-report in screen view, hide everything else when printing, and
  // strip the interactive chrome (JSON/copy buttons, evidence carets, etc.).
  var printHost = null;

  function ensurePrintHost() {
    if (printHost && document.body.contains(printHost)) return printHost;
    printHost = document.getElementById("print-report");
    if (!printHost) {
      printHost = document.createElement("section");
      printHost.id = "print-report";
      printHost.setAttribute("aria-hidden", "true"); // off-screen on screen media
      document.body.appendChild(printHost);
    }
    return printHost;
  }

  function buildPrintReport(items, title) {
    var norm = normalizeAll(items);
    var host = ensurePrintHost();
    PA.clearChildren(host);
    if (!norm.length) return host;

    // ---- report header (brand mark + title + meta line) ----
    var head = PA.el("header", "print-head");
    var hrow = PA.el("div", "print-head-row");
    hrow.appendChild(PA.el("span", "print-logo", "PA"));
    var htext = PA.el("div", "print-head-text");
    htext.appendChild(PA.el("h1", "print-title", title || "Prior-Authorization Access Report"));
    htext.appendChild(PA.el("p", "print-sub",
      "Plaque Psoriasis policy extraction · " + norm.length + " result" + (norm.length === 1 ? "" : "s")));
    hrow.appendChild(htext);
    head.appendChild(hrow);
    var meta = PA.el("p", "print-meta",
      "Generated " + new Date().toLocaleString() + " · DeepSeek v4-pro + Docling. " +
      "Access Score and barrier profile derived from the extracted policy fields.");
    head.appendChild(meta);
    host.appendChild(head);

    // ---- one shared result card per (PDF, brand), grouped by filename ----
    var lastFile = null;
    norm.forEach(function (n, i) {
      var fname = n.filename || n.result.Filename || "";
      if (fname && fname !== lastFile && norm.length > 1) {
        host.appendChild(PA.el("h2", "print-file-heading", fname));
        lastFile = fname;
      }
      var brand = n.brand || n.result.Brand || "";
      var card = PA.cloneBrandCard(brand);
      // Mark printed cards so reduced interactive affordances apply (CSS).
      card.classList.add("is-print");
      host.appendChild(card);
      // Reconstruct the AnalyzeEvent shape populateBrandCard expects.
      PA.populateBrandCard(card, {
        brand: brand,
        result: n.result,
        access_justification: n.access_justification,
        meta: n.meta,
        policy_text: n.policy_text,
        confidence: n.confidence,
        spans: n.spans,
        consensus: n.consensus
      }, fname);
    });

    var foot = PA.el("footer", "print-foot");
    foot.appendChild(PA.el("p", null,
      "This report is generated client-side from the analyzer's extracted fields. " +
      "Verify against the source policy before clinical or coverage decisions."));
    host.appendChild(foot);
    return host;
  }

  function printReport(items, title) {
    var norm = normalizeAll(items);
    if (!norm.length) return;
    buildPrintReport(norm, title);
    document.body.classList.add("printing");

    var cleanup = function () {
      document.body.classList.remove("printing");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Fallback cleanup in case afterprint never fires (older browsers).
    setTimeout(cleanup, 60000);

    // The shared card renderers animate the score gauge / count-up over ~700ms
    // via rAF (settling to the final value). Wait past that so the printed PDF
    // captures the SETTLED gauge, not a mid-sweep frame. Reduced-motion snaps
    // instantly, so print right away then.
    var delay = PA.reducedMotion() ? 0 : 800;
    setTimeout(function () {
      try { window.print(); }
      catch (e) { cleanup(); }
    }, delay);
  }

  // =========================================================================
  // export bar — the three actions, surfaced on each result-bearing view.
  // =========================================================================
  // getItems: () => Array<result-ish>. Re-read on each click so streaming /
  // late-arriving results are always included. baseName / printTitle / scope
  // describe the export scope (single file, batch job id, library detail).
  function buildExportBar(opts) {
    opts = opts || {};
    var getItems = typeof opts.getItems === "function" ? opts.getItems : function () { return []; };

    var bar = PA.el("div", "export-bar" + (opts.compact ? " export-bar-compact" : ""));
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "Export this analysis");

    if (!opts.compact) {
      bar.appendChild(PA.el("span", "export-bar-label", "Export"));
    }

    var status = PA.el("span", "copy-status export-status");
    status.setAttribute("aria-live", "polite");

    function withGuard(fn, emptyMsg) {
      return function () {
        var items = normalizeAll(getItems());
        if (!items.length) {
          status.textContent = emptyMsg || "Nothing to export yet";
          setTimeout(function () { status.textContent = ""; }, 2200);
          return;
        }
        try { fn(items); }
        catch (e) {
          status.textContent = "Export failed";
          if (window.console && console.warn) console.warn("export failed:", e && e.message);
          setTimeout(function () { status.textContent = ""; }, 2600);
        }
      };
    }

    var base = function () { return opts.baseName ? opts.baseName() : "pa-export"; };
    var scope = opts.scope || "results";
    var title = function () { return opts.printTitle ? opts.printTitle() : "Prior-Authorization Access Report"; };

    bar.appendChild(actionBtn("Print / PDF", "print", withGuard(function (items) {
      printReport(getItems(), title());
    })));
    bar.appendChild(actionBtn("CSV", "csv", withGuard(function (items) {
      downloadCsv(getItems(), base());
      flash(status, "CSV downloaded");
    })));
    bar.appendChild(actionBtn("JSON", "json", withGuard(function (items) {
      downloadJson(getItems(), base(), scope);
      flash(status, "JSON downloaded");
    })));
    bar.appendChild(actionBtn("FHIR", "fhir", withGuard(function (items) {
      downloadFhir(getItems(), base());
      flash(status, "FHIR bundle downloaded");
    })));

    bar.appendChild(status);
    return bar;
  }

  function flash(status, msg) {
    status.textContent = msg;
    setTimeout(function () { status.textContent = ""; }, 1800);
  }

  function actionBtn(label, kind, onClick) {
    var b = PA.el("button", "btn btn-ghost btn-sm export-btn export-btn-" + kind, label);
    b.type = "button";
    b.appendChild(iconFor(kind));
    // Put the glyph before the label for a consistent look.
    b.insertBefore(b.lastChild, b.firstChild);
    b.addEventListener("click", onClick);
    return b;
  }

  // Tiny inline SVG glyphs (no external assets; currentColor-tinted).
  function iconFor(kind) {
    var svg = PA.svgEl("svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "export-ico");
    var p = PA.svgEl("path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.7");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    var d;
    if (kind === "print") {
      d = "M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2M6 14h12v7H6z";
    } else if (kind === "fhir") {
      // a "plus / health" cross inside a rounded square
      d = "M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 8v8M8 12h8";
    } else {
      // generic document-with-download arrow (CSV / JSON)
      d = "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 12v5m0 0l-2-2m2 2l2-2";
    }
    p.setAttribute("d", d);
    svg.appendChild(p);
    return svg;
  }

  // =========================================================================
  // public surface
  // =========================================================================
  PA.exports = {
    CSV_COLUMNS: CSV_COLUMNS.slice(),
    // transforms (pure)
    toCsv: toCsv,
    toJsonDoc: toJsonDoc,
    toFhirBundle: toFhirBundle,
    toMedicationKnowledge: toMedicationKnowledge,
    // downloads
    downloadCsv: downloadCsv,
    downloadJson: downloadJson,
    downloadFhir: downloadFhir,
    // print
    printReport: printReport,
    // the surfaced action bar
    buildExportBar: buildExportBar
  };
})();
