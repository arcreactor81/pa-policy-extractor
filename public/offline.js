/**
 * offline.js — container shut down, 2 August 2026.
 *
 * The Cloudflare Container behind PDF extraction was deleted because it billed
 * wall-clock time in an idle, self-rearming Durable Object alarm loop (180,004 ms
 * of wall time against 0 ms of CPU, repeatedly, with no traffic to serve). See
 * docs/CONTAINERS-OFFLINE.md for the root cause and the restore procedure.
 *
 * The Worker already refuses the container-backed routes with a 503 and a
 * human sentence, so nothing here is load-bearing for correctness. What this
 * file adds is the difference between a button that *explains* and a button that
 * *fails*: without it, "Analyze policy" looks live, spins, and then reports an
 * error from the network. Every control below is one whose only destination is
 * the container.
 *
 * Implementation note — why the property is redefined rather than just set:
 * app.js and batch.js own these buttons and re-enable them whenever the form
 * becomes valid (`btn.disabled = !ready`). Setting `disabled = true` once here
 * would be undone the moment a user picks a file. Redefining the `disabled`
 * accessor makes those writes no-ops without patching three other files, and
 * without racing them — this script is loaded LAST in index.html, so the
 * redefinition is in place before any of their event handlers can run.
 *
 * TO RESTORE: delete this file, remove its <script> tag from index.html, and
 * remove the .offline-notice / .is-container-offline blocks from styles.css.
 * No other file needs to change.
 */
(function () {
  "use strict";

  var REASON =
    "PDF extraction is offline — the container has been shut down to stop " +
    "it billing idle time. Saved analyses, Library, Export and Ask still work. " +
    "See the notice at the top of this page.";

  /**
   * Controls that cannot do anything while the container is gone.
   *   analyze-btn      — Single mode: analyze the uploaded PDF (POST /api/analyze)
   *   batch-submit-btn — Batch mode: submit a new job (staging → JobCoordinator)
   *   cohort-run-now   — Cohorts: re-run a saved cohort as a new batch job
   * Deliberately NOT listed: anything reading the Library, Ask, Export, web
   * checks, or a cohort's existing runs and diffs. Those are served from D1/R2
   * and Workers AI and are unaffected.
   */
  var OFFLINE_CONTROL_IDS = ["analyze-btn", "batch-submit-btn", "cohort-run-now"];

  function lock(el) {
    if (!el) return;

    // Explain before disabling, so the tooltip exists even if the property
    // redefinition below is unsupported for any reason.
    el.setAttribute("title", REASON);
    el.setAttribute("aria-disabled", "true");
    el.classList.add("is-container-offline");

    // Pin `disabled` true. `configurable: true` keeps this reversible from the
    // console during debugging; the setter swallows writes rather than throwing
    // so app.js / batch.js keep working normally in every other respect.
    try {
      Object.defineProperty(el, "disabled", {
        configurable: true,
        enumerable: true,
        get: function () {
          return true;
        },
        set: function () {
          /* container offline: ignore re-enable attempts */
        },
      });
    } catch (err) {
      /* Property redefinition refused — the attribute below still applies. */
    }
    el.setAttribute("disabled", "disabled");
  }

  function lockAll() {
    for (var i = 0; i < OFFLINE_CONTROL_IDS.length; i++) {
      lock(document.getElementById(OFFLINE_CONTROL_IDS[i]));
    }
  }

  // This script is deferred, so the document has parsed and every id above
  // exists in the static markup. The readyState check is belt-and-braces for
  // the case where it is ever loaded differently.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", lockAll);
  } else {
    lockAll();
  }
})();
