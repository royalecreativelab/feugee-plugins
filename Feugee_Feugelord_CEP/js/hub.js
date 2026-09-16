/* =========================================================
   FEUGEE FEUGELORD  -  HUB  (After Effects, invisible)

   Watches the outbox Illustrator writes to and builds every
   payload as shape layers. Polls instead of BridgeTalk: a file
   drop survives either app restarting, BridgeTalk does not.

   Hidden CEP pages get their timers throttled while AE is in the
   background, so the hub also checks the moment AE is activated -
   switching from Illustrator to AE is when the layer is wanted.
   ========================================================= */
(function () {
  "use strict";

  var cep = window.__adobe_cep__;
  if (!cep || !window.cep || !window.cep.fs) return;

  var POLL_MS = 300;
  var outbox = "";
  var busy = false;
  var pauseUntil = 0;       // host not answering (still loading): back off instead of hammering

  function userData() {
    // getSystemPath returns a URL (Application%20Support); cep.fs does not decode it
    try { return decodeURIComponent(cep.getSystemPath("userData").replace(/^file:\/\//, "")); } catch (e) { return ""; }
  }

  function next() {
    if (busy || !outbox || Date.now() < pauseUntil) return;
    var res = window.cep.fs.readdir(outbox);
    if (res.err !== 0 || !res.data || !res.data.length) return;
    var files = res.data.filter(function (n) { return /\.json$/.test(n); }).sort();
    if (!files.length) return;
    busy = true;
    var path = outbox + "/" + files[0];
    cep.evalScript("FG_LORD.build(" + JSON.stringify(path) + ")", function (res) {
      busy = false;
      if (typeof res !== "string" || !/^(OK|ERR)\|/.test(res)) { pauseUntil = Date.now() + 2000; return; }
      // more than one push queued (fast clicking): drain without waiting a tick
      setTimeout(next, 0);
    });
  }

  function start() {
    outbox = userData() + "/Feugee/Feugelord/outbox";
    window.cep.fs.makedir(userData() + "/Feugee");
    window.cep.fs.makedir(userData() + "/Feugee/Feugelord");
    window.cep.fs.makedir(outbox);
    setInterval(next, POLL_MS);
    next();
  }

  try {
    cep.addEventListener("com.adobe.csxs.events.ApplicationActivate", next);
  } catch (e) {}

  start();
})();
