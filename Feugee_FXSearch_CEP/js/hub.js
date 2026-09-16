/* =========================================================
   FEUGEE FX SEARCH  -  HUB  (invisible extension)

   The popup is native ScriptUI now (jsx/popup.jsx), opened by the
   File > Scripts launcher bound to Ctrl+Space. The hub only does
   the startup chores nobody should have to click for:
     1. keep the launcher in every AE version's Scripts folder current
     2. warm the popup - build its window and index in the main
        engine - so even the first Ctrl+Space of the session is instant
   ========================================================= */
(function () {
  "use strict";

  var cep = window.__adobe_cep__;
  if (!cep) return;

  function extPath() {
    try { return cep.getSystemPath("extension").replace(/^file:\/\//, ""); } catch (e) { return ""; }
  }

  // Give After Effects a moment to finish launching before scanning presets.
  // fxcore.js is loaded in hub.html for FXCore.popupScript().
  setTimeout(function () {
    var root = extPath();
    cep.evalScript("FG_FXS.installLauncher(" + JSON.stringify(root) + ")", function () {
      cep.evalScript(FXCore.popupScript(FXCore.lit(root), "warm", FXCore.POPUP_VERSION), function () {});
    });
  }, 4000);
})();
