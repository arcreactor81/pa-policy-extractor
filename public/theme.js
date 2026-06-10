/* =========================================================================
   Prior-Authorization Access Analyzer — theme.js (head bootstrap)

   Runs synchronously in <head> BEFORE first paint (no `defer`/`async`) so it
   can flag JS-on and apply the persisted theme with zero FOUC. Externalized
   from an inline <head> <script> to satisfy the Worker's CSP (script-src
   'self'; no inline scripts). Behavior is byte-for-byte identical to the
   former inline bootstrap.

   1. Flag the document as JS-capable so entrance reveals only hide when JS can
      un-hide them (the `.js .reveal` rule in styles.css).
   2. Apply any persisted light/dark theme override before paint.
   ========================================================================= */
(function () {
  var d = document.documentElement;
  d.className = (d.className ? d.className + " " : "") + "js";
  try {
    var t = localStorage.getItem("pa_theme_v1");
    if (t === "light" || t === "dark") d.setAttribute("data-theme", t);
  } catch (e) {}
})();
