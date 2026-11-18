/* =========================================================
   FEUGEE HTML IMPORT - loader.js (UI side)
   source -> prepared HTML -> rendered iframe -> capture -> assets
   ========================================================= */
var FeugeeLoader = (function () {
  "use strict";

  // corsproxy.io is gone on purpose: since 2025 it answers 401 without an
  // API key. Public proxies come and go; the local one is the reliable path.
  var PROXIES = {
    local: "http://127.0.0.1:8787/?url={url}",
    allorigins: "https://api.allorigins.win/raw?url={url}",
    codetabs: "https://api.codetabs.com/v1/proxy?quest={url}"
  };
  var AUTO_ORDER = ["local", "allorigins", "codetabs"];
  var TRUE_Q = "(min-width: 0px)", FALSE_Q = "(max-width: 0.0001px)";

  function fill(tpl, url) {
    return tpl.indexOf("{url}") >= 0 ? tpl.replace("{url}", encodeURIComponent(url)) : tpl + encodeURIComponent(url);
  }

  // proxies to try, in order: [{ name, tpl }]
  function proxyChain(cfg) {
    if (!cfg || !cfg.proxy || cfg.proxy === "off") return [];
    if (cfg.proxy === "custom") return cfg.proxyUrl ? [{ name: "custom", tpl: cfg.proxyUrl }] : [];
    var names = cfg.proxy === "auto" || !PROXIES[cfg.proxy] ? AUTO_ORDER : [cfg.proxy];
    var chain = names.map(function (n) { return { name: n, tpl: PROXIES[n] }; });
    // once a proxy worked in this import, try it first (and skip dead ones)
    var st = cfg._proxyState || (cfg._proxyState = { ok: null, dead: {} });
    chain = chain.filter(function (p) { return !st.dead[p.name]; });
    if (st.ok) chain.sort(function (a, b) { return (b.name === st.ok) - (a.name === st.ok); });
    return chain;
  }

  function proxied(url, cfg) {
    var c = proxyChain(cfg);
    return c.length ? fill(c[0].tpl, url) : null;
  }

  // Turn a proxy failure into words: the site is rarely the culprit.
  async function proxyError(r) {
    var body = "";
    try { body = (await r.text()).slice(0, 300); } catch (e) {}
    if (/api key/i.test(body)) return "needs an API key";
    if (r.status >= 520 && r.status <= 530) return "proxy down (HTTP " + r.status + ")";
    return "HTTP " + r.status;
  }

  function timeout(ms, p) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () { rej(new Error("timeout")); }, ms);
      p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); });
    });
  }

  // direct first (data:, blob:, CORS-enabled hosts), proxy second
  async function read(r, kind) {
    if (kind === "text") return await r.text();
    var buf = new Uint8Array(await r.arrayBuffer());
    return { bytes: buf, type: (r.headers.get("content-type") || "").toLowerCase() };
  }

  async function fetchAny(url, cfg, kind) {
    var chain = /^(data|blob):/.test(url) ? [] : proxyChain(cfg);
    var errs = [];
    // 1. direct (data:, blob:, hosts that allow CORS)
    try {
      var r0 = await timeout(chain.length ? 9000 : 25000, fetch(url, { credentials: "omit", redirect: "follow" }));
      if (r0.ok) return await read(r0, kind);
      // a real HTTP answer from the site itself: the proxy would get the same
      if (r0.status === 404 || r0.status === 410) throw new Error("site answered HTTP " + r0.status);
      errs.push("direct: HTTP " + r0.status);
    } catch (e) {
      if (/^site answered/.test(e.message)) throw e;
      errs.push("direct: " + (e.message === "timeout" ? "timeout" : "blocked by CORS"));
    }
    // 2. proxies, in order
    var st = cfg && cfg._proxyState;
    for (var i = 0; i < chain.length; i++) {
      var p = chain[i];
      try {
        // the local proxy refuses instantly when it is not running
        var r = await timeout(p.name === "local" ? 20000 : 15000, fetch(fill(p.tpl, url), { credentials: "omit", redirect: "follow" }));
        if (r.ok) { if (st) st.ok = p.name; return await read(r, kind); }
        var why = await proxyError(r);
        errs.push(p.name + ": " + why);
        // proxy itself is unusable for the rest of this import -> next proxy
        if (/api key|proxy down/.test(why) || r.status === 429 || (p.name !== "local" && (r.status === 401 || r.status === 403))) {
          if (st) st.dead[p.name] = 1;
          continue;
        }
        // otherwise the proxy worked and relayed the SITE's answer (404, 410,
        // 500...): another proxy would get the same, so stop here
        if (st) st.ok = p.name;
        break;
      } catch (e) {
        var msg = e.message === "timeout" ? "timeout" : (p.name === "local" ? "not running" : "unreachable");
        if (st && (msg !== "timeout" || p.name !== "local")) st.dead[p.name] = 1;
        errs.push(p.name + ": " + msg);
      }
    }
    var err = new Error(errs.join(" · "));
    err.attempts = errs;
    throw err;
  }

  function abs(u, base) { try { return new URL(u, base).href; } catch (e) { return u; } }

  // ---------------------------------------------------------
  // CSS inlining - needed for color-scheme emulation (cssRules access)
  // and to route web fonts through the proxy so they load with CORS
  // ---------------------------------------------------------
  async function processCss(css, cssUrl, cfg, depth) {
    // @import
    var imports = [], re = /@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?([^;]*);/g, m;
    while ((m = re.exec(css))) imports.push({ full: m[0], url: abs(m[1], cssUrl), media: m[2].trim() });
    for (var i = 0; i < imports.length; i++) {
      var im = imports[i], rep = "";
      if (depth < 3) {
        try {
          var sub = await processCss(await fetchAny(im.url, cfg, "text"), im.url, cfg, depth + 1);
          rep = im.media ? "@media " + im.media + "{" + sub + "}" : sub;
        } catch (e) { rep = "@import url(\"" + im.url + "\")" + (im.media ? " " + im.media : "") + ";"; }
      }
      css = css.split(im.full).join(rep);
    }
    // absolute url()
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (all, q, u) {
      if (/^(data:|#|about:)/.test(u)) return all;
      return "url(\"" + abs(u, cssUrl) + "\")";
    });
    // fonts through the proxy
    if (cfg && cfg.proxy && cfg.proxy !== "off") {
      css = css.replace(/@font-face\s*\{[^}]*\}/g, function (block) {
        return block.replace(/url\("([^"]+)"\)/g, function (all, u) {
          if (/^data:/.test(u)) return all;
          var p = proxied(u, cfg);
          return p ? "url(\"" + p + "\")" : all;
        });
      });
    }
    return css;
  }

  async function prepare(html, baseUrl, cfg, onStep) {
    var doc = new DOMParser().parseFromString(html, "text/html");
    var base = baseUrl || "";
    var existingBase = doc.querySelector("base[href]");
    if (existingBase && base) base = abs(existingBase.getAttribute("href"), base);
    if (existingBase) existingBase.parentNode.removeChild(existingBase);
    if (base) {
      var b = doc.createElement("base");
      b.setAttribute("href", base);
      doc.head.insertBefore(b, doc.head.firstChild);
    }
    // CSP metas would block our own capture style injection
    [].slice.call(doc.querySelectorAll("meta[http-equiv]")).forEach(function (m) {
      if (/content-security-policy|refresh/i.test(m.getAttribute("http-equiv"))) m.parentNode.removeChild(m);
    });
    if (!cfg.scripts) {
      [].slice.call(doc.querySelectorAll("script")).forEach(function (s) { s.parentNode.removeChild(s); });
      [].slice.call(doc.querySelectorAll("*")).forEach(function (el) {
        for (var i = el.attributes.length - 1; i >= 0; i--) {
          if (/^on/i.test(el.attributes[i].name)) el.removeAttribute(el.attributes[i].name);
        }
      });
    }
    // lazy images: load everything now
    [].slice.call(doc.querySelectorAll("img, source, iframe")).forEach(function (el) {
      el.removeAttribute("loading");
      var ds = el.getAttribute("data-src") || el.getAttribute("data-lazy-src") || el.getAttribute("data-original");
      var src = el.getAttribute("src") || "";
      if (ds && (!src || /^data:image\/(gif|svg)/.test(src) || /placeholder|blank|spacer/i.test(src))) el.setAttribute("src", ds);
      var dss = el.getAttribute("data-srcset") || el.getAttribute("data-lazy-srcset");
      if (dss && !el.getAttribute("srcset")) el.setAttribute("srcset", dss);
    });
    // stylesheets
    var links = [].slice.call(doc.querySelectorAll("link[rel~='stylesheet'][href]"));
    if (links.length && onStep) onStep("Inlining " + links.length + " stylesheet" + (links.length > 1 ? "s" : ""));
    await Promise.all(links.map(async function (link) {
      var href = abs(link.getAttribute("href"), base || undefined);
      try {
        var css = await processCss(await fetchAny(href, cfg, "text"), href, cfg, 0);
        var st = doc.createElement("style");
        if (link.getAttribute("media")) st.setAttribute("media", link.getAttribute("media"));
        st.textContent = css;
        link.parentNode.replaceChild(st, link);
      } catch (e) {
        link.setAttribute("href", href); // browser can still render it, we just can't rewrite it
      }
    }));
    var styles = [].slice.call(doc.querySelectorAll("style"));
    for (var i = 0; i < styles.length; i++) {
      if (/@import|@font-face/.test(styles[i].textContent)) {
        try { styles[i].textContent = await processCss(styles[i].textContent, base || location.href, cfg, 0); } catch (e) {}
      }
    }
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  // ---------------------------------------------------------
  // render + capture
  // ---------------------------------------------------------
  function forceScheme(doc, scheme) {
    var dark = scheme === "dark";
    var reDark = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, reLight = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;
    function fix(text) {
      return text.replace(reDark, dark ? TRUE_Q : FALSE_Q).replace(reLight, dark ? FALSE_Q : TRUE_Q);
    }
    function walkRules(rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.media && r.media.mediaText && /prefers-color-scheme/i.test(r.media.mediaText)) {
          try { r.media.mediaText = fix(r.media.mediaText); } catch (e) {}
        }
        if (r.cssRules) walkRules(r.cssRules);
      }
    }
    for (var s = 0; s < doc.styleSheets.length; s++) {
      var sh = doc.styleSheets[s];
      try {
        if (sh.media && /prefers-color-scheme/i.test(sh.media.mediaText)) sh.media.mediaText = fix(sh.media.mediaText);
        walkRules(sh.cssRules);
      } catch (e) {}
    }
    [].slice.call(doc.querySelectorAll("source[media], link[media], style[media]")).forEach(function (el) {
      var m = el.getAttribute("media");
      if (/prefers-color-scheme/i.test(m)) el.setAttribute("media", fix(m));
    });
    try {
      var cs = doc.defaultView.getComputedStyle(doc.documentElement).colorScheme || "";
      if (/light/.test(cs) && /dark/.test(cs)) doc.documentElement.style.colorScheme = scheme;
      else if (!/dark|light/.test(cs)) doc.documentElement.style.colorScheme = "light";
    } catch (e) {}
  }

  // ---------------------------------------------------------
  // font matching: Figma ships every Google Font. If the page asks for a
  // family this iframe does not have, load it from Google Fonts so the
  // browser measures with the SAME metrics Figma will use - otherwise line
  // wraps drift between the capture and the rebuilt text.
  // ---------------------------------------------------------
  var GENERIC_FAM = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont|segoe ui.*|apple color emoji|noto color emoji|emoji|math|fangsong|inherit|initial|helvetica( neue)?|arial|times( new roman)?|georgia|menlo|monaco|courier( new)?|sf pro.*|sf mono|new york|verdana|tahoma|trebuchet ms)$/i;

  async function matchFonts(doc, cfg) {
    if (cfg.matchFonts === false) return [];
    var win = doc.defaultView, want = {}, n = 0;
    var els = doc.body ? doc.body.getElementsByTagName("*") : [];
    for (var i = 0; i < els.length && n < 6000; i++, n++) {
      var el = els[i];
      if (!el.firstChild) continue;
      var cs = win.getComputedStyle(el);
      var fam = (cs.fontFamily.split(",")[0] || "").replace(/^['"]|['"]$/g, "").trim();
      if (!fam || GENERIC_FAM.test(fam)) continue;
      var w = Math.max(100, Math.min(900, Math.round((parseInt(cs.fontWeight, 10) || 400) / 100) * 100));
      (want[fam] = want[fam] || {})[(cs.fontStyle !== "normal" ? 1 : 0) + "," + w] = 1;
    }
    var cv = doc.createElement("canvas").getContext("2d");
    function missing(fam) {
      var probe = "mmmmmmmmmlli1WQ@#&";
      return ["monospace", "serif"].every(function (fb) {
        cv.font = "72px " + fb; var a = cv.measureText(probe).width;
        cv.font = '72px "' + fam + '", ' + fb; return Math.abs(cv.measureText(probe).width - a) < 0.01;
      });
    }
    // Only families Figma can render: then the browser measures with the
    // exact font Figma will use. Unknown list (tests, old host) = trust Google.
    var inFigma = null;
    if (cfg.figmaFamilies && cfg.figmaFamilies.length) {
      inFigma = {};
      cfg.figmaFamilies.forEach(function (f) { inFigma[f.toLowerCase()] = 1; });
    }
    var fams = Object.keys(want).filter(function (f) {
      return (!inFigma || inFigma[f.toLowerCase()]) && missing(f);
    }).slice(0, 10);
    var loaded = [];
    await Promise.all(fams.map(async function (fam) {
      var tuples = Object.keys(want[fam]).sort(function (a, b) {
        var x = a.split(",").map(Number), y = b.split(",").map(Number);
        return x[0] - y[0] || x[1] - y[1];
      });
      var base = "https://fonts.googleapis.com/css2?family=" + encodeURIComponent(fam).replace(/%20/g, "+");
      var urls = [base + ":ital,wght@" + tuples.join(";") + "&display=block", base + "&display=block"];
      for (var u = 0; u < urls.length; u++) {
        try {
          var css = await fetchAny(urls[u], cfg, "text");
          if (!/@font-face/.test(css)) continue;
          var st = doc.createElement("style");
          st.setAttribute("data-feugee", "font");
          st.textContent = css;
          doc.head.appendChild(st);
          await timeout(8000, Promise.all(tuples.map(function (t) {
            var p = t.split(",");
            return doc.fonts.load((p[0] === "1" ? "italic " : "") + p[1] + ' 16px "' + fam + '"').catch(function () {});
          }))).catch(function () {});
          loaded.push(fam);
          return;
        } catch (e) {}
      }
    }));
    return loaded;
  }

  function waitImages(doc, ms) {
    var imgs = [].slice.call(doc.images).filter(function (i) { return !i.complete; });
    if (!imgs.length) return Promise.resolve();
    return timeout(ms, Promise.all(imgs.map(function (i) {
      return new Promise(function (r) { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); });
    }))).catch(function () {});
  }

  async function renderAndCapture(html, vp, cfg, host, onStep) {
    var frame = document.createElement("iframe");
    frame.setAttribute("sandbox", cfg.scripts ? "allow-same-origin allow-scripts" : "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-30000px;top:0;border:0;width:" + vp.w + "px;height:" + vp.h + "px;";
    host.appendChild(frame);
    try {
      await new Promise(function (res) {
        var done = false;
        frame.onload = function () { if (!done) { done = true; res(); } };
        setTimeout(function () { if (!done) { done = true; res(); } }, 30000);
        frame.srcdoc = html;
      });
      var doc = frame.contentDocument;
      if (!doc) throw new Error("Render frame is not accessible (sandbox)");
      if (onStep) onStep("Waiting for fonts and images");
      try { await timeout(8000, doc.fonts.ready); } catch (e) {}
      await waitImages(doc, 8000);
      if (cfg.scripts) await new Promise(function (r) { setTimeout(r, cfg.settle || 1500); });
      forceScheme(doc, cfg.scheme || "light");
      if (onStep) onStep("Matching fonts with Figma");
      var matched = await matchFonts(doc, cfg);
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      if (onStep) onStep("Reading layout at " + vp.w + "px");
      var out = FeugeeCapture.capture(doc, {
        flatten: cfg.flatten !== false, autoLayout: cfg.autoLayout !== false,
        vectorSvg: cfg.vectorSvg !== false, maxHeight: cfg.maxHeight || 24000
      });
      out.fontsMatched = matched;
      return out;
    } finally {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    }
  }

  // ---------------------------------------------------------
  // assets
  // ---------------------------------------------------------
  function sniff(b) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
    if (b[0] === 0xff && b[1] === 0xd8) return "jpg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
    var head = "";
    for (var i = 0; i < Math.min(b.length, 512); i++) head += String.fromCharCode(b[i]);
    if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(head))) return "svg";
    return "other";
  }

  function canvasEncode(bitmap, maxSide, mime) {
    var s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    var w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
    var cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    return new Promise(function (res) {
      cv.toBlob(function (blob) {
        if (!blob) return res(null);
        blob.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); });
      }, mime || "image/png", 0.92);
    });
  }

  async function rasterSvg(text, w, h) {
    var blob = new Blob([text], { type: "image/svg+xml" });
    var url = URL.createObjectURL(blob);
    try {
      var img = new Image();
      await new Promise(function (res, rej) { img.onload = res; img.onerror = rej; img.src = url; });
      var iw = img.naturalWidth || w || 512, ih = img.naturalHeight || h || 512;
      var scale = Math.min(4, Math.max(1, 2048 / Math.max(iw, ih)));
      var cv = document.createElement("canvas");
      cv.width = Math.round(iw * scale); cv.height = Math.round(ih * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      return await new Promise(function (res) {
        cv.toBlob(function (b) { b ? b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }) : res(null); }, "image/png");
      });
    } finally { URL.revokeObjectURL(url); }
  }

  // bytes -> something figma.createImage accepts (png/jpg/gif <= 4096px)
  async function normalise(bytes, entry) {
    var kind = sniff(bytes);
    var out = {};
    if (kind === "svg") {
      var text = new TextDecoder().decode(bytes);
      out.svg = text;
      if (entry.asFill) out.bytes = await rasterSvg(text);
      return out;
    }
    var bmp = null;
    try { bmp = await createImageBitmap(new Blob([bytes])); } catch (e) {}
    if (bmp) {
      out.nat = [bmp.width, bmp.height];
      if (kind === "other" || bmp.width > 4096 || bmp.height > 4096) {
        out.bytes = await canvasEncode(bmp, 4096, kind === "jpg" ? "image/jpeg" : "image/png");
      } else out.bytes = bytes;
      try { bmp.close(); } catch (e) {}
    } else if (kind !== "other") out.bytes = bytes;
    return out;
  }

  async function pool(items, n, fn) {
    var i = 0;
    async function worker() { while (i < items.length) { var k = i++; await fn(items[k], k); } }
    var ws = [];
    for (var j = 0; j < Math.min(n, items.length); j++) ws.push(worker());
    await Promise.all(ws);
  }

  async function resolveImages(list, cfg, onProgress) {
    var assets = {}, failed = [], done = 0;
    await pool(list, 6, async function (entry) {
      try {
        var got = await fetchAny(entry.url, cfg, "bytes");
        var a = await normalise(got.bytes, entry);
        if (a.bytes || a.svg) assets[entry.key] = a;
        else failed.push(entry.url);
      } catch (e) { failed.push(entry.url); }
      done++;
      if (onProgress) onProgress(done, list.length);
    });
    return { assets: assets, failed: failed };
  }

  // capture files exported by the snippet carry base64 payloads
  async function assetsFromCapture(images, list, onProgress) {
    var assets = {}, failed = [], done = 0;
    var byKey = {};
    list.forEach(function (e) { byKey[e.key] = e; });
    var keys = Object.keys(images || {});
    await pool(keys, 4, async function (k) {
      var it = images[k];
      try {
        if (it && it.b64) {
          var bin = atob(it.b64), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var a = await normalise(bytes, byKey[k] || { asFill: true });
          if (a.bytes || a.svg) assets[k] = a; else failed.push(k);
        } else failed.push(byKey[k] ? byKey[k].url : k);
      } catch (e) { failed.push(byKey[k] ? byKey[k].url : k); }
      done++;
      if (onProgress) onProgress(done, keys.length);
    });
    return { assets: assets, failed: failed };
  }

  return {
    PROXIES: PROXIES,
    fetchAny: fetchAny,
    prepare: prepare,
    renderAndCapture: renderAndCapture,
    resolveImages: resolveImages,
    assetsFromCapture: assetsFromCapture
  };
})();
