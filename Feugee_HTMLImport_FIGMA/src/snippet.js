/* =========================================================
   FEUGEE HTML IMPORT - snippet.js
   Paste into the DevTools console of ANY tab (logged-in, localhost,
   a specific UI state). Captures exactly what is on screen and downloads
   a .json that the plugin imports. build.mjs prepends capture.js.
   ========================================================= */
(async function () {
  "use strict";
  if (window.__feugeeCapturing) return;
  window.__feugeeCapturing = true;
  var toast = null;
  function say(t, err) {
    if (!toast) {
      toast = document.createElement("div");
      toast.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:10px 14px;border-radius:6px;" +
        "font:600 12px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#f1f1f4;background:#161619;" +
        "border:1px solid #34343d;box-shadow:0 6px 24px rgba(0,0,0,.35);border-left:3px solid #f2631c;max-width:320px";
      document.documentElement.appendChild(toast);
    }
    toast.style.borderLeftColor = err ? "#e05a49" : "#f2631c";
    toast.textContent = "FEUGEE CAPTURE \u00b7 " + t;
  }
  function b64(bytes) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }
  async function viaCanvas(url) {
    var img = [].slice.call(document.images).filter(function (i) { return (i.currentSrc || i.src) === url && i.complete && i.naturalWidth; })[0];
    if (!img) return null;
    var cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d").drawImage(img, 0, 0);
    var blob = await new Promise(function (r) { try { cv.toBlob(r, "image/png"); } catch (e) { r(null); } });
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }
  try {
    var doc = FeugeeCapture.capture(document, { flatten: true, autoLayout: true, vectorSvg: true });
    say("layout read, fetching " + doc.images.length + " images");
    var images = {}, done = 0, failed = 0;
    var list = doc.images.slice(), idx = 0;
    async function worker() {
      while (idx < list.length) {
        var e = list[idx++], bytes = null;
        try {
          var r = await fetch(e.url, { credentials: "include" });
          if (r.ok) bytes = new Uint8Array(await r.arrayBuffer());
        } catch (er) {}
        if (!bytes) { try { bytes = await viaCanvas(e.url); } catch (er2) {} }
        if (bytes) images[e.key] = { b64: b64(bytes) }; else failed++;
        done++;
        say("images " + done + "/" + list.length + (failed ? " (" + failed + " blocked)" : ""));
      }
    }
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
    var payload = { kind: "feugee-capture", v: 1, capturedAt: new Date().toISOString(), doc: doc, images: images };
    var blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    var a = document.createElement("a");
    var host = (location.hostname || "page").replace(/[^\w.-]/g, "_");
    a.href = URL.createObjectURL(blob);
    a.download = "feugee-capture-" + host + "-" + doc.w + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    say("saved " + a.download + " (" + Math.round(blob.size / 1024) + " KB). Drop it into the plugin.");
  } catch (e) {
    say("failed: " + (e && e.message ? e.message : e), true);
    throw e;
  } finally {
    window.__feugeeCapturing = false;
    setTimeout(function () { if (toast && toast.parentNode) toast.parentNode.removeChild(toast); }, 7000);
  }
})();
