/* =========================================================
   FEUGEE HTML IMPORT - capture.js
   Walks a RENDERED document and returns a layout IR (plain JSON).
   Runs in any browser context: the plugin UI iframe, or the user's own
   tab through the capture snippet. No Figma API in here.

   Coordinates in the IR are page-absolute and UNTRANSFORMED: every CSS
   transform is recorded first, then neutralised while measuring, and the
   builder re-applies it as a Figma relativeTransform. That way nested
   transforms compose the same way they do in the browser.
   ========================================================= */
var FeugeeCapture = (function () {
  "use strict";

  var SKIP = {
    script: 1, style: 1, noscript: 1, template: 1, meta: 1, link: 1, head: 1,
    title: 1, base: 1, area: 1, map: 1, param: 1, source: 1, track: 1,
    datalist: 1, option: 1, optgroup: 1, slot: 1
  };
  var SEMANTIC = {
    header: 1, nav: 1, main: 1, section: 1, footer: 1, article: 1, aside: 1,
    form: 1, ul: 1, ol: 1, table: 1, dialog: 1, figure: 1
  };
  var NAMES = {
    header: "Header", nav: "Nav", main: "Main", section: "Section", footer: "Footer",
    article: "Article", aside: "Aside", form: "Form", button: "Button", a: "Link",
    img: "Image", ul: "List", ol: "List", li: "List Item", input: "Input",
    textarea: "Textarea", select: "Select", h1: "H1", h2: "H2", h3: "H3", h4: "H4",
    h5: "H5", h6: "H6", p: "Paragraph", figure: "Figure", table: "Table",
    video: "Video", canvas: "Canvas", iframe: "Embed", svg: "Vector", label: "Label",
    dialog: "Dialog", blockquote: "Quote", hr: "Divider"
  };
  var REPLACED = { img: 1, svg: 1, video: 1, canvas: 1, iframe: 1, embed: 1, object: 1, input: 1, textarea: 1, select: 1, picture: 1, hr: 1 };
  var BLEND = {
    multiply: "MULTIPLY", screen: "SCREEN", overlay: "OVERLAY", darken: "DARKEN",
    lighten: "LIGHTEN", "color-dodge": "COLOR_DODGE", "color-burn": "COLOR_BURN",
    "hard-light": "HARD_LIGHT", "soft-light": "SOFT_LIGHT", difference: "DIFFERENCE",
    exclusion: "EXCLUSION", hue: "HUE", saturation: "SATURATION", color: "COLOR",
    luminosity: "LUMINOSITY"
  };
  var EPS = 0.75;

  // ---------------------------------------------------------
  // small parsers
  // ---------------------------------------------------------
  function splitTop(s, sep) {
    var out = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
        if (cur.trim()) out.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function r2(n) { return Math.round(n * 100) / 100; }

  var _cctx = null, _ccache = {};
  function color(str) {
    if (!str) return null;
    if (_ccache.hasOwnProperty(str)) return _ccache[str];
    var c = null;
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.]+)(%?))?\s*\)$/.exec(str);
    if (m) {
      var a = m[4] == null ? 1 : parseFloat(m[4]) / (m[5] ? 100 : 1);
      c = { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: a };
    } else if (str === "transparent" || str === "none") {
      c = { r: 0, g: 0, b: 0, a: 0 };
    } else {
      // oklch(), color(), lab() ... let the browser gamut-map it into sRGB pixels
      try {
        if (!_cctx) {
          var cv = document.createElement("canvas");
          cv.width = cv.height = 1;
          _cctx = cv.getContext("2d", { willReadFrequently: true });
        }
        _cctx.clearRect(0, 0, 1, 1);
        _cctx.fillStyle = "rgba(0,0,0,0)";
        _cctx.fillStyle = str;
        _cctx.fillRect(0, 0, 1, 1);
        var d = _cctx.getImageData(0, 0, 1, 1).data;
        c = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
      } catch (e) { c = null; }
    }
    _ccache[str] = c;
    return c;
  }

  function isColorToken(t) {
    return /^(#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|transparent|currentcolor)/i.test(t) ||
      (/^[a-z]+$/i.test(t) && t !== "inset");
  }

  function parseShadows(str) {
    if (!str || str === "none") return [];
    var out = [];
    splitTop(str, ",").forEach(function (sh) {
      var toks = splitTop(sh, " "), nums = [], col = null, inset = false;
      toks.forEach(function (t) {
        if (t === "inset") inset = true;
        else if (/^-?[\d.]/.test(t)) nums.push(px(t));
        else if (isColorToken(t)) col = color(t);
      });
      if (!col || col.a <= 0 || nums.length < 2) return;
      out.push({ k: inset ? "inner" : "drop", c: col, x: nums[0], y: nums[1], b: nums[2] || 0, s: nums[3] || 0 });
    });
    return out;
  }

  function cornerAngle(dir, w, h) {
    var a = Math.atan2(h, w) * 180 / Math.PI;
    var top = /top/.test(dir), bottom = /bottom/.test(dir), left = /left/.test(dir), right = /right/.test(dir);
    if (top && right) return a;
    if (bottom && right) return 180 - a;
    if (bottom && left) return 180 + a;
    if (top && left) return 360 - a;
    if (top) return 0;
    if (right) return 90;
    if (bottom) return 180;
    if (left) return 270;
    return 180;
  }

  function parseAngle(t) {
    var n = parseFloat(t);
    if (/turn$/.test(t)) return n * 360;
    if (/grad$/.test(t)) return n * 0.9;
    if (/rad$/.test(t)) return n * 180 / Math.PI;
    return n;
  }

  function parseStops(parts, lenPx) {
    var stops = [];
    parts.forEach(function (p) {
      var toks = splitTop(p, " "), col = null, pos = [];
      toks.forEach(function (t) {
        if (/^-?[\d.]+(%|px|em|rem)?$/.test(t)) {
          pos.push(/%$/.test(t) ? parseFloat(t) / 100 : (lenPx ? px(t) / lenPx : 0));
        } else if (!col) col = color(t);
      });
      if (!col) return; // colour hint, ignored
      if (!pos.length) stops.push({ c: col, p: null });
      pos.forEach(function (q) { stops.push({ c: col, p: q }); });
    });
    if (stops.length < 2) return null;
    if (stops[0].p == null) stops[0].p = 0;
    if (stops[stops.length - 1].p == null) stops[stops.length - 1].p = 1;
    for (var i = 1; i < stops.length - 1; i++) {
      if (stops[i].p != null) continue;
      var j = i; while (stops[j].p == null) j++;
      var a = stops[i - 1].p, b = stops[j].p;
      for (var k = i; k < j; k++) stops[k].p = a + (b - a) * (k - i + 1) / (j - i + 1);
      i = j;
    }
    var last = 0;
    stops.forEach(function (s) { s.p = Math.max(last, Math.min(1, s.p)); last = s.p; });
    // CSS interpolates premultiplied: a transparent stop takes its neighbour's hue
    stops.forEach(function (s, idx) {
      if (s.c.a > 0) return;
      var nb = null;
      for (var d = 1; d < stops.length && !nb; d++) {
        if (stops[idx - d] && stops[idx - d].c.a > 0) nb = stops[idx - d].c;
        else if (stops[idx + d] && stops[idx + d].c.a > 0) nb = stops[idx + d].c;
      }
      if (nb) s.c = { r: nb.r, g: nb.g, b: nb.b, a: 0 };
    });
    return stops.map(function (s) { return { c: s.c, p: r2(s.p * 1000) / 1000 }; });
  }

  function parseGradient(str, w, h) {
    var m = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/.exec(str.trim());
    if (!m) return null;
    var parts = splitTop(m[3], ",");
    if (m[2] === "linear") {
      var angle = 180, first = parts[0];
      if (/^to\s/.test(first)) { angle = cornerAngle(first, w, h); parts.shift(); }
      else if (/^-?[\d.]+(deg|turn|rad|grad)$/.test(first)) { angle = parseAngle(first); parts.shift(); }
      var th = angle * Math.PI / 180;
      var L = Math.abs(w * Math.sin(th)) + Math.abs(h * Math.cos(th));
      var stops = parseStops(parts, L);
      return stops ? { k: "lin", angle: angle, stops: stops } : null;
    }
    if (m[2] === "radial") {
      var cx = 0.5, cy = 0.5, circle = false;
      if (!isColorToken(splitTop(parts[0], " ")[0]) || /\bat\b|circle|ellipse|closest|farthest/.test(parts[0])) {
        var shape = parts.shift();
        circle = /circle/.test(shape);
        var at = /\bat\s+(.*)$/.exec(shape);
        if (at) {
          var xy = splitTop(at[1], " ");
          var kw = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
          var fx = xy[0], fy = xy[1] || "center";
          if (fx === "top" || fx === "bottom") { var t = fx; fx = fy === "center" ? "center" : fy; fy = t; }
          cx = kw.hasOwnProperty(fx) ? kw[fx] : (/%$/.test(fx) ? parseFloat(fx) / 100 : px(fx) / (w || 1));
          cy = kw.hasOwnProperty(fy) ? kw[fy] : (/%$/.test(fy) ? parseFloat(fy) / 100 : px(fy) / (h || 1));
        }
      }
      var rstops = parseStops(parts, Math.max(w, h));
      return rstops ? { k: "rad", cx: cx, cy: cy, circle: circle, stops: rstops } : null;
    }
    // conic: no native equivalent in a plain fill - approximate with its first stop
    var cst = parseStops(parts.filter(function (p) { return !/^from|^at/.test(p); }), 1);
    return cst ? { k: "solid", c: cst[0].c } : null;
  }

  function parseRadius(v, w, h) {
    var first = splitTop(v || "0", " ")[0] || "0";
    var r = /%$/.test(first) ? parseFloat(first) / 100 * Math.min(w, h) : px(first);
    return Math.max(0, Math.min(r, Math.min(w, h) / 2));
  }

  // ---------------------------------------------------------
  // transforms
  // ---------------------------------------------------------
  function mul(m, n) { // 2D affine [a,b,c,d,e,f]
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  function cssMatrix(cs) {
    var m = [1, 0, 0, 1, 0, 0], touched = false;
    if (cs.translate && cs.translate !== "none") {
      var t = splitTop(cs.translate, " ");
      m = mul(m, [1, 0, 0, 1, px(t[0]), px(t[1] || 0)]); touched = true;
    }
    if (cs.rotate && cs.rotate !== "none") {
      var rt = splitTop(cs.rotate, " "), ang = parseAngle(rt[rt.length - 1]);
      if (rt.length === 1 || rt[0] === "z" || (rt.length === 4 && px(rt[2]) !== 0 && !px(rt[0]) && !px(rt[1]))) {
        var a = ang * Math.PI / 180;
        m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); touched = true;
      }
    }
    if (cs.scale && cs.scale !== "none") {
      var sc = splitTop(cs.scale, " ");
      var sx = parseFloat(sc[0]), sy = sc[1] != null ? parseFloat(sc[1]) : sx;
      m = mul(m, [sx, 0, 0, sy, 0, 0]); touched = true;
    }
    var tr = cs.transform;
    if (tr && tr !== "none") {
      var v = (/\(([^)]*)\)/.exec(tr) || [])[1];
      if (v) {
        var n = v.split(",").map(parseFloat);
        if (/^matrix3d/.test(tr)) n = [n[0], n[1], n[4], n[5], n[12], n[13]];
        if (n.length === 6 && n.every(isFinite)) { m = mul(m, n); touched = true; }
      }
    }
    if (!touched) return null;
    if (Math.abs(m[0] - 1) < 1e-4 && Math.abs(m[3] - 1) < 1e-4 && Math.abs(m[1]) < 1e-4 && Math.abs(m[2]) < 1e-4 &&
        Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01) return null;
    return m.map(function (x) { return Math.round(x * 10000) / 10000; });
  }

  // ---------------------------------------------------------
  // main
  // ---------------------------------------------------------
  // App-shell pages (Framer, many SPAs) pin html/body to 100vh and scroll
  // an inner element instead of the document, so a naive capture stops at
  // the first screen. Find that main scroller and let it (and its
  // ancestors) grow to full content height for the duration of the capture.
  // ---------------------------------------------------------
  function unrollShell(doc, win) {
    var root = doc.documentElement, vw = win.innerWidth, vh = win.innerHeight;
    if (root.scrollHeight > vh + 4) return null;            // document scrolls normally
    var best = null, bestH = 0;
    var els = doc.body ? doc.body.getElementsByTagName("*") : [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.ownerSVGElement || el.clientHeight < vh * 0.6 || el.clientWidth < vw * 0.6) continue;
      var extra = el.scrollHeight - el.clientHeight;
      if (extra < 40) continue;
      var oy = win.getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > bestH) { best = el; bestH = el.scrollHeight; }
    }
    if (!best) return null;
    var touched = [];
    function free(el, isScroller) {
      touched.push([el, el.getAttribute("style")]);
      var cs = win.getComputedStyle(el), s = el.style;
      s.setProperty("height", "auto", "important");
      s.setProperty("max-height", "none", "important");
      if (isScroller || cs.overflowY !== "visible") s.setProperty("overflow-y", "visible", "important");
      // pinned top+bottom (inset:0) boxes would keep viewport height
      if ((cs.position === "absolute" || cs.position === "fixed") && cs.bottom !== "auto") s.setProperty("bottom", "auto", "important");
      if (cs.position === "fixed") s.setProperty("position", "absolute", "important");
    }
    free(best, true);
    for (var p = best.parentElement; p; p = p.parentElement) free(p, false);
    best.scrollTop = 0;
    void root.offsetHeight;
    return {
      el: best,
      undo: function () {
        touched.forEach(function (t) {
          if (t[1] == null) t[0].removeAttribute("style"); else t[0].setAttribute("style", t[1]);
        });
      }
    };
  }

  // ---------------------------------------------------------
  function capture(doc, opts) {
    opts = opts || {};
    var win = doc.defaultView;
    var flatten = opts.flatten !== false;
    var wantAuto = opts.autoLayout !== false;
    var maxH = opts.maxHeight || 24000;
    var stats = { elements: 0, texts: 0, images: 0, svgs: 0, skipped: 0 };
    var images = {}, imageList = [], nextImg = 0;

    function imgKey(url, usage) {
      if (!url) return null;
      if (!images[url]) {
        images[url] = { key: "i" + (nextImg++), url: url, asSvg: false, asFill: false };
        imageList.push(images[url]);
      }
      if (usage === "svg") images[url].asSvg = true; else images[url].asFill = true;
      return images[url].key;
    }

    // 1. settle animations at their end state
    try {
      (doc.getAnimations ? doc.getAnimations() : []).forEach(function (a) {
        try { a.finish(); } catch (e) { try { a.pause(); } catch (e2) {} }
      });
    } catch (e) {}

    // 2. record transforms, then neutralise them for measuring
    var tf = new Map();
    var all = doc.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el0 = all[i];
      if (el0.ownerSVGElement) continue;
      var cs0 = win.getComputedStyle(el0);
      var m = cssMatrix(cs0);
      if (m) tf.set(el0, { m: m, o: cs0.transformOrigin });
    }
    var neutral = doc.createElement("style");
    neutral.setAttribute("data-feugee", "capture");
    neutral.textContent =
      ":not(svg *){transform:none!important;translate:none!important;rotate:none!important;scale:none!important;" +
      "transition:none!important;caret-color:transparent!important}";
    (doc.head || doc.documentElement).appendChild(neutral);

    var sx0 = win.scrollX, sy0 = win.scrollY;
    win.scrollTo(0, 0);
    void doc.documentElement.offsetHeight;
    var unrolled = opts.unroll === false ? null : unrollShell(doc, win);

    var root = doc.documentElement, body = doc.body || root;
    var W = root.clientWidth || win.innerWidth;
    var H = Math.min(maxH, Math.max(root.scrollHeight, body.scrollHeight, win.innerHeight));
    var range = doc.createRange();

    function bbox(el) {
      var r = el.getBoundingClientRect();
      return { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
    }

    function nameOf(el) {
      var t = el.localName;
      var base = NAMES[t] || t;
      var lab = el.getAttribute("aria-label");
      if (lab) return base + " " + lab.slice(0, 40);
      if (el.id) return base + " #" + el.id;
      var c = el.classList && el.classList[0];
      return c ? base + " ." + c : base;
    }

    function fontFamilies(cs) {
      return splitTop(cs.fontFamily, ",").map(function (f) { return f.replace(/^['"]|['"]$/g, "").trim(); });
    }

    function segStyle(cs, href) {
      var deco = cs.textDecorationLine || cs.textDecoration || "";
      var fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color;
      return {
        fam: fontFamilies(cs),
        wt: parseInt(cs.fontWeight, 10) || 400,
        it: cs.fontStyle !== "normal",
        sz: r2(px(cs.fontSize)),
        c: color(fill),
        ls: cs.letterSpacing === "normal" ? 0 : r2(px(cs.letterSpacing)),
        lh: cs.lineHeight === "normal" ? null : r2(px(cs.lineHeight)),
        deco: /line-through/.test(deco) ? "STRIKETHROUGH" : (/underline/.test(deco) ? "UNDERLINE" : null),
        cs: cs.textTransform === "uppercase" ? "UPPER" : cs.textTransform === "lowercase" ? "LOWER" :
          cs.textTransform === "capitalize" ? "TITLE" : null,
        href: href || null
      };
    }

    function collapse(s, ws) {
      if (/^pre$|^pre-wrap$|^break-spaces$/.test(ws)) return s.replace(/\r\n?/g, "\n");
      if (ws === "pre-line") return s.replace(/[ \t\f\r]+/g, " ").replace(/ ?\n ?/g, "\n");
      return s.replace(/[ \t\n\r\f]+/g, " ");
    }

    function tidySegs(segs) {
      var out = [], prevEnd = "\n";
      segs.forEach(function (s) {
        var t = s.t;
        if (!s.pre && (prevEnd === " " || prevEnd === "\n") && t.charAt(0) === " ") t = t.slice(1);
        if (!t) return;
        if (!s.pre && t === "\n" && out.length) {
          var last = out[out.length - 1];
          if (!last.pre) last.t = last.t.replace(/ +$/, "");
        }
        out.push({ t: t, st: s.st, pre: s.pre });
        prevEnd = t.charAt(t.length - 1);
      });
      if (out.length && !out[out.length - 1].pre) out[out.length - 1].t = out[out.length - 1].t.replace(/[ ]+$/, "");
      return out.filter(function (s) { return s.t.length; });
    }

    function hasBoxVisual(cs) {
      if ((color(cs.backgroundColor) || { a: 0 }).a > 0) return true;
      if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
      if (px(cs.borderTopWidth) || px(cs.borderRightWidth) || px(cs.borderBottomWidth) || px(cs.borderLeftWidth)) return true;
      if (cs.boxShadow && cs.boxShadow !== "none") return true;
      return false;
    }

    // inline content that can become ONE Figma text with styled ranges
    function isPlainInline(el) {
      if (SKIP[el.localName]) return true;
      if (REPLACED[el.localName]) return false;
      var cs = win.getComputedStyle(el);
      if (cs.display === "none") return true;
      if (cs.display !== "inline" && cs.display !== "contents") return false;
      if (hasBoxVisual(cs) || px(cs.paddingLeft) > 1 || px(cs.paddingRight) > 1) return false;
      if (tf.has(el) || parseFloat(cs.opacity) < 1) return false;
      if (cs.position === "absolute" || cs.position === "fixed") return false;
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && c.localName !== "br" && !isPlainInline(c)) return false;
      }
      return true;
    }

    function canMergeText(el, cs) {
      var hasText = false;
      var flexy = /flex|grid/.test(cs.display);
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { if (/\S/.test(c.data)) hasText = true; }
        else if (c.nodeType === 1) {
          if (c.localName === "br") continue;
          if (flexy) return false; // flex/grid items are blockified, each is its own box
          if (!isPlainInline(c)) return false;
          if (/\S/.test(c.textContent)) hasText = true;
        }
      }
      return hasText;
    }

    function lineInfo(rects) {
      var list = [];
      for (var i = 0; i < rects.length; i++) if (rects[i].width > 0.01 || rects[i].height > 0.01) list.push(rects[i]);
      if (!list.length) return null;
      list.sort(function (a, b) { return a.top - b.top; });
      var lines = [];
      list.forEach(function (r) {
        var mid = (r.top + r.bottom) / 2, hit = null;
        for (var k = 0; k < lines.length; k++) if (mid > lines[k].top && mid < lines[k].bottom) { hit = lines[k]; break; }
        if (hit) {
          hit.top = Math.min(hit.top, r.top); hit.bottom = Math.max(hit.bottom, r.bottom);
          hit.left = Math.min(hit.left, r.left); hit.right = Math.max(hit.right, r.right);
        } else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      });
      lines.sort(function (a, b) { return a.top - b.top; });
      var u = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      lines.forEach(function (l) {
        u.left = Math.min(u.left, l.left); u.top = Math.min(u.top, l.top);
        u.right = Math.max(u.right, l.right); u.bottom = Math.max(u.bottom, l.bottom);
      });
      return { lines: lines, u: u };
    }

    function alignOf(cs) {
      var a = cs.textAlign;
      if (a === "center" || a === "-webkit-center") return "CENTER";
      if (a === "right" || a === "end" || a === "-webkit-right") return cs.direction === "rtl" && a === "end" ? "LEFT" : "RIGHT";
      if (a === "justify") return "JUSTIFIED";
      if (a === "start" && cs.direction === "rtl") return "RIGHT";
      return "LEFT";
    }

    // Build a text IR node from segments + geometry.
    // box: content box of the owning block (null for loose text runs)
    function makeText(segs, li, cs, box, el) {
      if (!segs.length || !li) return null;
      var text = segs.map(function (s) { return s.t; }).join("");
      if (!/\S/.test(text)) return null;
      var sx = win.scrollX, sy = win.scrollY;
      var n = li.lines.length;
      var lh = segs[0].st.lh;
      if (!lh) {
        lh = n > 1 ? (li.lines[n - 1].top - li.lines[0].top) / (n - 1) : (li.lines[0].bottom - li.lines[0].top);
      }
      var firstH = li.lines[0].bottom - li.lines[0].top;
      var y = li.lines[0].top - (lh - firstH) / 2 + sy;
      // a plain text block's content box IS its stack of line boxes: exact pitch + top
      if (box && box.h > 0 && /^(block|list-item|inline-block|flow-root)$/.test(cs.display)) {
        var pitch = box.h / n;
        if (!segs[0].st.lh && pitch >= firstH * 0.9 && pitch <= firstH * 1.8) { lh = pitch; y = box.y; }
        else if (Math.abs(n * lh - box.h) <= 1) y = box.y;
      }
      lh = r2(lh);
      var align = alignOf(cs);
      var nowrap = /nowrap|pre$/.test(cs.whiteSpace);
      var trunc = cs.textOverflow === "ellipsis" && cs.overflowX !== "visible" && nowrap;
      var clamp = parseInt(cs.webkitLineClamp, 10) || 0;
      var node = {
        type: "text", name: text.trim().slice(0, 48),
        segs: segs.map(function (s) {
          var st = s.st;
          return { t: s.t, fam: st.fam, wt: st.wt, it: st.it, sz: st.sz, c: st.c, ls: st.ls, lh: st.lh || lh, deco: st.deco, cs: st.cs, href: st.href };
        }),
        align: align, lines: n, lh: lh
      };
      if (box && (n > 1 || align !== "LEFT" || trunc || clamp)) {
        node.x = box.x; node.w = box.w; node.auto = false;
      } else {
        node.x = li.u.left + sx; node.w = li.u.right - li.u.left;
        node.auto = n === 1 && !trunc;
      }
      if (n === 1 && box && align !== "LEFT" && (li.u.right - li.u.left) < box.w * 0.98 && !trunc) {
        // short centred line in a wide box: keep the box width so it stays centred
        node.auto = false;
      }
      node.y = y; node.h = n * lh;
      if (box) node.bw = r2(box.w);
      if (trunc) { node.trunc = 1; }
      if (clamp) { node.trunc = clamp; }
      if (el && cs.backgroundClip === "text" || el && cs.webkitBackgroundClip === "text") {
        var g = cs.backgroundImage && cs.backgroundImage !== "none" ? parseGradient(splitTop(cs.backgroundImage, ",")[0], node.w, node.h) : null;
        if (g) node.fill = g;
      }
      stats.texts++;
      return node;
    }

    // is this box's WIDTH decided by its content (Figma HUG) or by its container?
    function fitWidth(el, cs) {
      if (/^inline/.test(cs.display) || cs.display === "table" || cs.position === "absolute" ||
          cs.position === "fixed" || (cs.float && cs.float !== "none")) return true;
      var p = el.parentElement;
      if (!p) return false;
      var pcs = win.getComputedStyle(p);
      if (/flex/.test(pcs.display)) {
        if (!/column/.test(pcs.flexDirection)) return !(parseFloat(cs.flexGrow) > 0);
        var as = cs.alignSelf === "auto" ? pcs.alignItems : cs.alignSelf;
        return !/stretch|normal/.test(as);
      }
      if (/grid/.test(pcs.display)) {
        var js = cs.justifySelf === "auto" ? pcs.justifyItems : cs.justifySelf;
        return !/stretch|normal|legacy/.test(js);
      }
      return false;
    }

    function padOf(cs) {
      return [px(cs.borderTopWidth) + px(cs.paddingTop), px(cs.borderRightWidth) + px(cs.paddingRight),
        px(cs.borderBottomWidth) + px(cs.paddingBottom), px(cs.borderLeftWidth) + px(cs.paddingLeft)].map(r2);
    }

    function contentBox(el, cs, b) {
      var bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth), bt = px(cs.borderTopWidth), bb = px(cs.borderBottomWidth);
      var pl = px(cs.paddingLeft), pr = px(cs.paddingRight), pt = px(cs.paddingTop), pb = px(cs.paddingBottom);
      return { x: b.x + bl + pl, y: b.y + bt + pt, w: Math.max(0, b.w - bl - br - pl - pr), h: Math.max(0, b.h - bt - bb - pt - pb) };
    }

    function textBlock(el, cs, b) {
      var segs = [];
      (function collect(node, href) {
        for (var c = node.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) {
            var pcs = win.getComputedStyle(node);
            if (pcs.visibility !== "visible") continue;
            var t = collapse(c.data, pcs.whiteSpace);
            if (t) segs.push({ t: t, st: segStyle(pcs, href), pre: /^pre/.test(pcs.whiteSpace) || pcs.whiteSpace === "break-spaces" });
          } else if (c.nodeType === 1) {
            if (c.localName === "br") { segs.push({ t: "\n", st: segStyle(win.getComputedStyle(node), href), pre: true }); continue; }
            if (SKIP[c.localName]) continue;
            var ccs = win.getComputedStyle(c);
            if (ccs.display === "none") continue;
            collect(c, c.localName === "a" && c.href ? c.href : href);
          }
        }
      })(el, el.localName === "a" && el.href ? el.href : null);
      segs = tidySegs(segs);
      if (!segs.length) return null;
      range.selectNodeContents(el);
      return makeText(segs, lineInfo(range.getClientRects()), cs, contentBox(el, cs, b), el);
    }

    function looseText(tn, pcs, href) {
      if (pcs.visibility !== "visible") return null;
      var t = collapse(tn.data, pcs.whiteSpace);
      if (!/\S/.test(t)) return null;
      if (!/^pre/.test(pcs.whiteSpace)) t = t.replace(/^ +| +$/g, "");
      range.selectNodeContents(tn);
      return makeText([{ t: t, st: segStyle(pcs, href) }], lineInfo(range.getClientRects()), pcs, null, null);
    }

    // background-* longhands are comma lists, one entry per layer
    function layerVal(list, i) { var a = splitTop(list || "", ","); return a.length ? a[i % a.length] : ""; }

    function boxStyle(el, cs, b, out) {
      var fills = [];
      var bg = color(cs.backgroundColor);
      if (bg && bg.a > 0) fills.push({ k: "solid", c: bg });
      var clipText = cs.backgroundClip === "text" || cs.webkitBackgroundClip === "text";
      if (cs.backgroundImage && cs.backgroundImage !== "none" && !clipText) {
        var layers = splitTop(cs.backgroundImage, ",");
        for (var i = layers.length - 1; i >= 0; i--) {
          var L = layers[i];
          var um = /^url\((['"]?)(.*?)\1\)$/.exec(L);
          if (um) {
            var size = layerVal(cs.backgroundSize, i), rep = layerVal(cs.backgroundRepeat, i);
            var fit = /cover/.test(size) ? "FILL" : /contain/.test(size) ? "FIT" :
              (/no-repeat/.test(rep) || /^100%/.test(size)) ? "FILL" : "TILE";
            var key = imgKey(um[2], "fill");
            if (key) { fills.push({ k: "img", key: key, fit: fit }); stats.images++; }
          } else {
            var g = parseGradient(L, b.w, b.h);
            if (g) fills.push(g);
          }
        }
      }
      out.fills = fills;
      var sides = ["Top", "Right", "Bottom", "Left"], wts = [], col = null, style = "solid";
      sides.forEach(function (s) {
        var st = cs["border" + s + "Style"], w = st === "none" || st === "hidden" ? 0 : px(cs["border" + s + "Width"]);
        var c = color(cs["border" + s + "Color"]);
        if (w > 0 && c && c.a > 0) { if (!col || w > Math.max.apply(null, wts)) { col = c; style = st; } } else w = 0;
        wts.push(r2(w));
      });
      if (col) out.border = { w: wts, c: col, style: style };
      var rad = [
        parseRadius(cs.borderTopLeftRadius, b.w, b.h), parseRadius(cs.borderTopRightRadius, b.w, b.h),
        parseRadius(cs.borderBottomRightRadius, b.w, b.h), parseRadius(cs.borderBottomLeftRadius, b.w, b.h)
      ];
      if (rad[0] || rad[1] || rad[2] || rad[3]) out.rad = rad.map(r2);
      var fx = parseShadows(cs.boxShadow);
      if (fx.length) out.fx = fx;
      var bm = /blur\(([\d.]+)px\)/.exec(cs.filter || "");
      if (bm && +bm[1] > 0) out.blur = +bm[1];
      var bbm = /blur\(([\d.]+)px\)/.exec(cs.backdropFilter || cs.webkitBackdropFilter || "");
      if (bbm && +bbm[1] > 0) out.bblur = +bbm[1];
      if (BLEND[cs.mixBlendMode]) out.blend = BLEND[cs.mixBlendMode];
      var op = parseFloat(cs.opacity);
      if (op < 1) out.op = r2(op);
      return !!(fills.length || col || fx.length || out.blur || out.bblur);
    }

    function zBucket(cs) {
      var positioned = cs.position !== "static";
      var z = cs.zIndex === "auto" ? 0 : parseInt(cs.zIndex, 10) || 0;
      if (!positioned) return 0;
      if (z < 0) return -1000 + z;
      if (z === 0) return 1;
      return 2 + z;
    }

    function attachTransform(el, node, b) {
      var t = tf.get(el);
      if (!t) return;
      var o = splitTop(t.o || "", " ");
      node.tf = t.m;
      node.to = [r2(px(o[0] != null ? o[0] : b.w / 2)), r2(px(o[1] != null ? o[1] : b.h / 2))];
    }

    // ---------- replaced elements ----------
    function imageNode(el, cs, b) {
      var node = { type: "rect", name: el.getAttribute("alt") ? "Image " + el.getAttribute("alt").slice(0, 40) : nameOf(el), x: b.x, y: b.y, w: b.w, h: b.h };
      boxStyle(el, cs, b, node);
      var url = el.currentSrc || el.src;
      var of = cs.objectFit;
      var fit = of === "contain" || of === "scale-down" || of === "none" ? "FIT" : "FILL";
      if (url) {
        var isSvg = /\.svg(\?|#|$)/i.test(url) || /^data:image\/svg/i.test(url);
        var key = imgKey(url, isSvg && opts.vectorSvg !== false ? "svg" : "fill");
        node.fills = (node.fills || []).concat([{ k: "img", key: key, fit: fit }]);
        node.img = key;
        if (isSvg) node.svgImg = 1;
        stats.images++;
      }
      node.nat = [el.naturalWidth || 0, el.naturalHeight || 0];
      return node;
    }

    function serializeSvg(el, b) {
      var clone = el.cloneNode(true);
      var src = [el].concat([].slice.call(el.querySelectorAll("*")));
      var dst = [clone].concat([].slice.call(clone.querySelectorAll("*")));
      var PROPS = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
        "stroke-dashoffset", "stroke-miterlimit", "fill-rule", "clip-rule", "fill-opacity", "stroke-opacity", "opacity",
        "stop-color", "stop-opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline"];
      var GEOM = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, text: 1, tspan: 1, use: 1, g: 1, svg: 1, stop: 1 };
      // SVG initial values: an attribute is only written when it differs from what
      // the element would inherit anyway - keeps the markup small for Figma's parser
      var INITIAL = {
        fill: "rgb(0,0,0)", stroke: "none", "stroke-width": "1", "stroke-linecap": "butt", "stroke-linejoin": "miter",
        "stroke-dasharray": "none", "stroke-dashoffset": "0", "stroke-miterlimit": "4", "fill-rule": "nonzero",
        "clip-rule": "nonzero", "fill-opacity": "1", "stroke-opacity": "1"
      };
      var NOT_INHERITED = { opacity: 1, "stop-color": 1, "stop-opacity": 1 };
      var eff = new Map();
      var removals = [];
      for (var i = 0; i < src.length; i++) {
        var s = src[i], d = dst[i];
        if (!d) continue;
        var ln = s.localName;
        var ccs = win.getComputedStyle(s);
        if (ccs.display === "none" && ln !== "symbol" && ln !== "defs" && !s.closest("defs,symbol,clipPath,mask,linearGradient,radialGradient,pattern")) {
          removals.push(d); continue;
        }
        if (!GEOM[ln]) continue;
        var inherited = (s === el ? null : eff.get(s.parentNode)) || INITIAL;
        var mine = {};
        eff.set(s, mine);
        PROPS.forEach(function (p) { d.removeAttribute(p); }); // drop raw attrs (currentColor etc.)
        PROPS.forEach(function (p) {
          if (ln === "stop" && p !== "stop-color" && p !== "stop-opacity") return;
          if (ln !== "stop" && (p === "stop-color" || p === "stop-opacity")) return;
          if (/^font|^text-anchor|^dominant/.test(p) && ln !== "text" && ln !== "tspan") return;
          var v = ccs.getPropertyValue(p);
          if (!v) return;
          if (p === "fill" || p === "stroke") {
            var um = /url\(["']?(?:[^#"')]*)?(#[^"')]+)["']?\)/.exec(v);
            if (um) v = "url(" + um[1] + ")";
            else if (v !== "none") {
              var c = color(v);
              if (c) {
                v = "rgb(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," + Math.round(c.b * 255) + ")";
                if (c.a < 1) d.setAttribute(p + "-opacity", String(r2(c.a * (parseFloat(ccs.getPropertyValue(p + "-opacity")) || 1))));
              }
            }
          } else if (p === "stop-color") {
            var sc = color(v);
            if (sc) {
              v = "rgb(" + Math.round(sc.r * 255) + "," + Math.round(sc.g * 255) + "," + Math.round(sc.b * 255) + ")";
              if (sc.a < 1) d.setAttribute("stop-opacity", String(r2(sc.a)));
            }
          } else v = v.replace(/px$/, "");
          mine[p] = v;
          if (!NOT_INHERITED[p] && inherited[p] === v) return; // would inherit it anyway
          if (p === "opacity" && v === "1") return;
          d.setAttribute(p, v);
        });
        for (var ip in inherited) if (!mine.hasOwnProperty(ip)) mine[ip] = inherited[ip];
        d.removeAttribute("class");
        d.removeAttribute("style");
      }
      removals.forEach(function (d) { if (d.parentNode) d.parentNode.removeChild(d); });
      // pull in <symbol>/<def> referenced from outside this svg (icon sprites)
      var defs = null;
      [].slice.call(clone.querySelectorAll("use")).forEach(function (u) {
        var ref = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
        if (ref.charAt(0) !== "#" || clone.querySelector(ref.replace(/([^\w#-])/g, "\\$1"))) return;
        var target = doc.getElementById(ref.slice(1));
        if (!target) return;
        if (!defs) { defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs"); clone.insertBefore(defs, clone.firstChild); }
        defs.appendChild(target.cloneNode(true));
      });
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      clone.setAttribute("width", String(r2(b.w)));
      clone.setAttribute("height", String(r2(b.h)));
      if (!clone.getAttribute("viewBox") && el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width) {
        var vb = el.viewBox.baseVal;
        clone.setAttribute("viewBox", [vb.x, vb.y, vb.width, vb.height].join(" "));
      }
      clone.removeAttribute("class");
      clone.removeAttribute("style");
      return new XMLSerializer().serializeToString(clone);
    }

    function formNode(el, cs, b) {
      var node = { type: "frame", name: nameOf(el), x: b.x, y: b.y, w: b.w, h: b.h, kids: [], pad: padOf(cs), fitW: fitWidth(el, cs) };
      boxStyle(el, cs, b, node);
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (el.localName === "input" && (type === "checkbox" || type === "radio")) {
        node.type = "rect";
        if (!node.border) node.border = { w: [1, 1, 1, 1], c: { r: 0.46, g: 0.46, b: 0.46, a: 1 }, style: "solid" };
        if (!node.rad) node.rad = type === "radio" ? [b.w / 2, b.w / 2, b.w / 2, b.w / 2] : [2.5, 2.5, 2.5, 2.5];
        var acc = color(cs.accentColor && cs.accentColor !== "auto" ? cs.accentColor : "rgb(0, 117, 255)");
        node.fills = el.checked ? [{ k: "solid", c: acc }] : (node.fills && node.fills.length ? node.fills : [{ k: "solid", c: { r: 1, g: 1, b: 1, a: 1 } }]);
        delete node.kids;
        if (el.checked) {
          var glyph = type === "radio"
            ? '<circle cx="8" cy="8" r="3.4" fill="#ffffff"/>'
            : '<path d="M3.6 8.4l2.9 2.9 5.9-6.6" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>';
          node.type = "frame";
          node.kids = [{ type: "svg", name: type === "radio" ? "Dot" : "Check", x: b.x, y: b.y, w: b.w, h: b.h,
            svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + r2(b.w) + '" height="' + r2(b.h) + '" viewBox="0 0 16 16">' + glyph + "</svg>" }];
        }
        return node;
      }
      if (el.localName === "input" && /^(hidden|file|range|color|image)$/.test(type)) return node.fills.length || node.border ? (node.type = "rect", node) : null;
      var val = "", ph = false;
      if (el.localName === "select") val = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : "";
      else if (type === "password") val = el.value ? new Array(el.value.length + 1).join("\u2022") : "";
      else val = el.value || "";
      if (!val && el.placeholder) { val = el.placeholder; ph = true; }
      if (/^(submit|button|reset)$/.test(type) && !val) val = el.value || (type === "submit" ? "Submit" : "");
      if (val) {
        var cb = contentBox(el, cs, b);
        var st = segStyle(cs, null);
        if (ph) {
          try { var pc = color(win.getComputedStyle(el, "::placeholder").color); if (pc) st.c = pc; } catch (e) {}
        }
        var lh = st.lh || r2(st.sz * 1.2);
        var multi = el.localName === "textarea";
        var t = {
          type: "text", name: val.slice(0, 48), segs: [{ t: val, fam: st.fam, wt: st.wt, it: st.it, sz: st.sz, c: st.c, ls: st.ls, lh: lh, deco: null, cs: st.cs }],
          align: /^(submit|button|reset)$/.test(type) ? "CENTER" : alignOf(cs), lines: 1, lh: lh,
          x: cb.x, w: cb.w, auto: false, y: multi ? cb.y : cb.y + (cb.h - lh) / 2, h: lh
        };
        if (!multi) t.trunc = 1;
        node.kids.push(t);
        stats.texts++;
      }
      if (!node.kids.length) node.type = "rect";
      return node;
    }

    // ---------- the walk ----------
    function walk(el) {
      var ln = el.localName;
      if (SKIP[ln]) return [];
      if (el === neutral) return [];
      var cs = win.getComputedStyle(el);
      if (cs.display === "none") return [];
      var op = parseFloat(cs.opacity);
      if (op === 0 && opts.keepHidden !== true) { stats.skipped++; return []; }
      var b = bbox(el);
      stats.elements++;
      var visible = cs.visibility === "visible";
      var node, res;

      if (ln === "svg") {
        if (!visible || b.w < 0.5 || b.h < 0.5) return [];
        node = { type: "svg", name: nameOf(el), x: b.x, y: b.y, w: b.w, h: b.h, svg: serializeSvg(el, b) };
        if (op < 1) node.op = r2(op);
        stats.svgs++;
        res = node;
      } else if (ln === "img") {
        if (!visible || b.w < 0.5 || b.h < 0.5) return [];
        res = imageNode(el, cs, b);
      } else if (ln === "video") {
        node = { type: "rect", name: "Video", x: b.x, y: b.y, w: b.w, h: b.h };
        boxStyle(el, cs, b, node);
        if (el.poster) { node.fills = node.fills.concat([{ k: "img", key: imgKey(el.poster, "fill"), fit: cs.objectFit === "contain" ? "FIT" : "FILL" }]); }
        else node.fills = node.fills.concat([{ k: "solid", c: { r: 0.07, g: 0.07, b: 0.08, a: 1 } }]);
        res = node;
      } else if (ln === "canvas") {
        node = { type: "rect", name: "Canvas", x: b.x, y: b.y, w: b.w, h: b.h };
        boxStyle(el, cs, b, node);
        try {
          var du = el.toDataURL("image/png");
          if (du && du.length > 32) node.fills = node.fills.concat([{ k: "img", key: imgKey(du, "fill"), fit: "FILL" }]);
        } catch (e) {}
        res = node;
      } else if (ln === "iframe" || ln === "embed" || ln === "object") {
        node = { type: "rect", name: "Embed (" + ln + ")", x: b.x, y: b.y, w: b.w, h: b.h };
        boxStyle(el, cs, b, node);
        node.fills = node.fills.concat([{ k: "solid", c: { r: 0.9, g: 0.9, b: 0.92, a: 1 } }]);
        res = node;
      } else if (ln === "input" || ln === "textarea" || ln === "select") {
        if (!visible) return [];
        res = formNode(el, cs, b);
      } else if (ln === "hr") {
        node = { type: "rect", name: "Divider", x: b.x, y: b.y, w: b.w, h: b.h };
        boxStyle(el, cs, b, node);
        res = node;
      }

      if (res) {
        if (!res.name) res.name = nameOf(el);
        if (cs.position === "absolute" || cs.position === "fixed") res.abs = 1;
        res.z = zBucket(cs);
        attachTransform(el, res, b);
        if (BLEND[cs.mixBlendMode]) res.blend = BLEND[cs.mixBlendMode];
        return [res];
      }

      // ---------- generic box ----------
      node = { type: "frame", name: nameOf(el), x: b.x, y: b.y, w: b.w, h: b.h, pad: padOf(cs), fitW: fitWidth(el, cs) };
      var visual = boxStyle(el, cs, b, node) && visible;
      if (!visible) { node.fills = []; delete node.border; delete node.fx; }
      var kids = [];
      if (canMergeText(el, cs)) {
        var t = textBlock(el, cs, b);
        if (t) kids.push(t);
      } else {
        var href = ln === "a" && el.href ? el.href : null;
        for (var c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) {
            var lt = looseText(c, cs, href);
            if (lt) kids.push(lt);
          } else if (c.nodeType === 1) {
            var sub = walk(c);
            for (var k = 0; k < sub.length; k++) kids.push(sub[k]);
          }
        }
      }

      var clipCss = cs.overflowX !== "visible" || cs.overflowY !== "visible";
      var overflows = clipCss && kids.some(function (k) {
        return k.x < b.x - EPS || k.y < b.y - EPS || k.x + k.w > b.x + b.w + EPS || k.y + k.h > b.y + b.h + EPS;
      });
      if (overflows) node.clip = 1;
      if (!node.clip && node.fx && node.fx.some(function (f) { return f.s; }) && !kids.some(function (k) {
        return k.x < b.x - EPS || k.y < b.y - EPS || k.x + k.w > b.x + b.w + EPS || k.y + k.h > b.y + b.h + EPS;
      })) node.clip = 1;
      var tfm = tf.get(el);
      var flexy = /flex|grid/.test(cs.display);
      var keep = !flatten || visual || node.clip || node.op || tfm || node.blend ||
        (SEMANTIC[ln] && kids.length) ||
        (wantAuto && kids.length >= 2 && (flexy || ln === "a" || ln === "button" || ln === "li"));
      if (!keep) return kids;
      if (!kids.length && !visual) return [];
      node.kids = kids;
      if (!kids.length) { node.type = "rect"; delete node.kids; }
      if (cs.position === "absolute" || cs.position === "fixed") node.abs = 1;
      node.z = zBucket(cs);
      node.grow = parseFloat(cs.flexGrow) || 0;
      node.dir = /column/.test(cs.flexDirection) && /flex/.test(cs.display) ? "col" : (/flex/.test(cs.display) ? "row" : "block");
      node.jc = cs.justifyContent;
      if (tfm) attachTransform(el, node, b);
      return [node];
    }

    // ---------- verified auto layout ----------
    // A frame only becomes auto layout when re-placing its children with
    // padding + one gap + one alignment reproduces their measured position.
    function near(a, b, e) { return Math.abs(a - b) <= (e || EPS); }

    function tryAxis(n, flow, horiz) {
      var P = horiz ? "x" : "y", S = horiz ? "w" : "h", Q = horiz ? "y" : "x", T = horiz ? "h" : "w";
      var k = flow.slice().sort(function (a, b) { return a[P] - b[P]; });
      var gaps = [];
      for (var i = 1; i < k.length; i++) gaps.push(k[i][P] - (k[i - 1][P] + k[i - 1][S]));
      if (gaps.some(function (g) { return g < -EPS; })) return null;
      var gap = gaps.length ? gaps[0] : 0;
      if (!gaps.every(function (g) { return near(g, gap, 1); })) return null;
      var startPad = k[0][P] - n[P];
      var endPad = n[P] + n[S] - (k[k.length - 1][P] + k[k.length - 1][S]);
      if (startPad < -EPS || endPad < -EPS) return null;

      // real CSS padding (+border) is the Figma padding; where the children sit
      // inside it decides the alignment. Never invent padding from leftover space.
      var cp = n.pad || [0, 0, 0, 0]; // t r b l
      var cS = horiz ? cp[3] : cp[0], cE = horiz ? cp[1] : cp[2];
      var cA = horiz ? cp[0] : cp[3], cB = horiz ? cp[2] : cp[1];

      var primary, pS, pE, hugP = false;
      if (k.length > 1 && /space-between/.test(n.jc || "")) { primary = "SPACE_BETWEEN"; pS = startPad; pE = endPad; }
      else if (near(endPad, cE) && startPad >= cS - EPS) { primary = "MIN"; pS = startPad; pE = cE; hugP = true; }
      else if (near(startPad, cS)) { primary = "MIN"; pS = startPad; pE = Math.min(endPad, cE); }
      else if (near(endPad, cE)) { primary = "MAX"; pS = Math.min(startPad, cS); pE = endPad; }
      else if (near(startPad - cS, endPad - cE)) { primary = "CENTER"; pS = cS; pE = cE; }
      else { primary = "MIN"; pS = startPad; pE = Math.min(endPad, cE); }

      var offs = k.map(function (c) { return c[Q] - n[Q]; });
      var ends = k.map(function (c) { return n[Q] + n[T] - (c[Q] + c[T]); });
      if (Math.min.apply(null, offs) < -EPS || Math.min.apply(null, ends) < -EPS) return null;
      var maxCross = Math.max.apply(null, k.map(function (c) { return c[T]; }));
      var counter, pA, pB;
      var allOff = offs.every(function (o) { return near(o, offs[0]); });
      var allEnd = ends.every(function (o) { return near(o, ends[0]); });
      var centreOk = function (a, b) {
        var mid = a + (n[T] - a - b) / 2;
        return k.every(function (c) { return near(c[Q] - n[Q] + c[T] / 2, mid); });
      };
      if (allOff && allEnd && k.length === 1 && !near(offs[0], cA) && centreOk(cA, cB)) { counter = "CENTER"; pA = cA; pB = cB; }
      else if (allOff) { counter = "MIN"; pA = offs[0]; pB = Math.min(cB, Math.max(0, n[T] - offs[0] - maxCross)); }
      else if (allEnd) { counter = "MAX"; pB = ends[0]; pA = Math.min(cA, Math.max(0, n[T] - ends[0] - maxCross)); }
      else if (centreOk(cA, cB)) { counter = "CENTER"; pA = cA; pB = cB; }
      else {
        var m0 = (k[0][Q] + k[0][T] / 2) - (n[Q] + n[T] / 2);
        if (!k.every(function (c) { return near((c[Q] + c[T] / 2) - (n[Q] + n[T] / 2), m0); })) return null;
        counter = "CENTER"; pA = Math.max(0, m0 * 2); pB = Math.max(0, -m0 * 2);
      }
      var hugC = counter !== "MAX" && near(pA + maxCross + pB, n[T], 1);
      // width may only hug when CSS sizes it from content; stretching kids win otherwise
      if (horiz) { if (!n.fitW || k.some(function (c) { return c.grow > 0; })) { hugP = false; pE = Math.min(endPad, cE); } }
      else if (!n.fitW) hugC = false;
      if (k.length === 1 && primary === "SPACE_BETWEEN") primary = "MIN";

      var al = { dir: horiz ? "H" : "V", gap: r2(primary === "SPACE_BETWEEN" ? 0 : Math.max(0, gap)), primary: primary, counter: counter };
      if (horiz) { al.pl = r2(pS); al.pr = r2(pE); al.pt = r2(pA); al.pb = r2(pB); }
      else { al.pt = r2(pS); al.pb = r2(pE); al.pl = r2(pA); al.pr = r2(pB); }
      if (hugP) al.hugP = 1;
      if (hugC) al.hugC = 1;

      // sizing the measurement proves. A child never FILLs an axis its parent hugs.
      var inner = n[T] - pA - pB;
      k.forEach(function (c) {
        var crossSize = c.type === "text" && c.bw != null && !horiz ? c.bw : c[T];
        if (!hugC && counter !== "CENTER" && !(c.fitW && !horiz) && near(crossSize, inner, 1)) c[horiz ? "fillV" : "fillH"] = 1;
        if (!hugP && c.grow > 0 && primary !== "SPACE_BETWEEN") c[horiz ? "fillH" : "fillV"] = 1;
        // one-line text in a box that hugs its width: let the box grow with the words
        if (c.type === "text" && c.lines === 1 && !c.trunc && (horiz ? hugP : hugC)) c.auto = true;
      });
      al.order = k;
      return al;
    }

    function autolayout(n) {
      if (!n.kids) return;
      n.kids.forEach(autolayout);
      if (!wantAuto || n.type !== "frame") return;
      var flow = n.kids.filter(function (c) { return !c.abs; });
      if (!flow.length) return;
      if (flow.some(function (c) { return c.tf; })) return;
      var prefer = n.dir === "row" ? [true, false] : [false, true];
      var al = null;
      for (var i = 0; i < 2 && !al; i++) al = tryAxis(n, flow, prefer[i]);
      if (!al) {
        flow.forEach(function (c) { delete c.fillH; delete c.fillV; });
        return;
      }
      // children order = axis order for flow kids, z-order preserved for absolute kids
      var order = al.order; delete al.order;
      var abs = n.kids.filter(function (c) { return c.abs; });
      var under = abs.filter(function (c) { return (c.z || 0) < 0; });
      var over = abs.filter(function (c) { return (c.z || 0) >= 0; });
      n.kids = under.concat(order, over);
      n.al = al;
    }

    function zsort(n) {
      if (!n.kids) return;
      n.kids.forEach(zsort);
      if (n.al) return;
      n.kids = n.kids.map(function (k, i) { return { k: k, i: i }; })
        .sort(function (a, b) { return ((a.k.z || 0) - (b.k.z || 0)) || (a.i - b.i); })
        .map(function (o) { return o.k; });
    }

    function prune(list) {
      return list.filter(function (k) {
        if (k.kids) k.kids = prune(k.kids);
        if (k.type === "frame" && k.kids && !k.kids.length && !(k.fills && k.fills.length) && !k.border && !k.fx) return false;
        if (k.w <= 1.01 && k.h <= 1.01 && !(k.kids && k.kids.length)) return false; // sr-only
        var inside = k.x + k.w > -EPS && k.x < W + EPS && k.y + k.h > -EPS && k.y < H + EPS;
        return inside || (k.kids && k.kids.length);
      });
    }

    function strip(n) {
      delete n.dir; delete n.jc; delete n.grow; delete n.pad; delete n.bw; delete n.fitW;
      if (n.z === 0) delete n.z;
      ["x", "y", "w", "h"].forEach(function (p) { if (n[p] != null) n[p] = r2(n[p]); });
      if (n.kids) n.kids.forEach(strip);
    }

    try {
      var kids = walk(body);
      if (body !== root) {
        // html-level content outside <body> is rare; ignore
      }
      var bodyCs = win.getComputedStyle(body), rootCs = win.getComputedStyle(root);
      var bgc = color(bodyCs.backgroundColor);
      if (!bgc || bgc.a === 0) bgc = color(rootCs.backgroundColor);
      if (!bgc || bgc.a === 0) bgc = { r: 1, g: 1, b: 1, a: 1 };
      kids = prune(kids);
      var only = kids.length === 1 ? kids[0] : null;
      if (only && only.name === "body" && only.kids && !only.border && !only.fx && !only.tf && !only.op && !only.clip &&
          (!only.fills || only.fills.length <= 1 && (!only.fills.length || only.fills[0].k === "solid"))) {
        kids = only.kids; // body box = page background, already the root fill
      }
      var rootNode = { type: "frame", name: "root", x: 0, y: 0, w: W, h: H, kids: kids, pad: [0, 0, 0, 0] };
      rootNode.dir = "block";
      autolayout(rootNode);
      zsort(rootNode);
      strip(rootNode);
      return {
        v: 1,
        title: (doc.title || "").trim() || "Untitled",
        url: String(doc.baseURI || ""),
        viewport: { w: W, h: win.innerHeight },
        w: W, h: H,
        bg: bgc,
        root: rootNode,
        images: imageList,
        stats: stats
      };
    } finally {
      if (neutral.parentNode) neutral.parentNode.removeChild(neutral);
      if (unrolled) unrolled.undo();
      try { win.scrollTo(sx0, sy0); } catch (e) {}
    }
  }

  return { capture: capture, _parseGradient: parseGradient, _color: color, _splitTop: splitTop };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FeugeeCapture;
