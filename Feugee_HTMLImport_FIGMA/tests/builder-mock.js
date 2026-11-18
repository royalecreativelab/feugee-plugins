#!/usr/bin/env node
/* Run the REAL builder.js against captured IR (tests/out/payload*.json,
   tests/out/smoke-*.json) inside a strict mock of the Figma plugin API.
   The mock throws where Figma throws (bad enums, NaN geometry, text edits
   before the font is loaded, FILL/ABSOLUTE outside auto layout), so real-
   world pages that are too large to push through use_figma still get the
   builder exercised end to end.  usage: node tests/builder-mock.js [files] */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const OUT = path.join(__dirname, "out");
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(OUT).filter((f) => /^(payload|smoke-).*\.json$/.test(f));

const ENUMS = {
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL"],
  primaryAxisAlignItems: ["MIN", "MAX", "CENTER", "SPACE_BETWEEN"],
  counterAxisAlignItems: ["MIN", "MAX", "CENTER", "BASELINE"],
  primaryAxisSizingMode: ["FIXED", "AUTO"], counterAxisSizingMode: ["FIXED", "AUTO"],
  layoutSizingHorizontal: ["FIXED", "HUG", "FILL"], layoutSizingVertical: ["FIXED", "HUG", "FILL"],
  layoutPositioning: ["AUTO", "ABSOLUTE"], textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"], strokeAlign: ["INSIDE", "OUTSIDE", "CENTER"],
  textTruncation: ["DISABLED", "ENDING"], strokeCap: ["NONE", "ROUND", "SQUARE"],
  blendMode: ["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
    "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"]
};
const NUMS = ["x", "y", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "cornerRadius",
  "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "strokeWeight", "strokeTopWeight",
  "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity", "maxLines"];

function fail(msg) { throw new Error(msg); }
function finite(v, what) { if (typeof v !== "number" || !isFinite(v)) fail(what + " not finite: " + v); }
function checkPaints(ps, what) {
  if (!Array.isArray(ps)) fail(what + " not array");
  ps.forEach((p) => {
    if (p.type === "SOLID") { ["r", "g", "b"].forEach((k) => { finite(p.color[k], what + ".color." + k); if (p.color[k] < 0 || p.color[k] > 1) fail(what + " color out of range"); }); if ("a" in p.color) fail(what + " SOLID color must not have alpha"); }
    else if (/^GRADIENT/.test(p.type)) { p.gradientTransform.flat().forEach((v) => finite(v, what + ".gradientTransform")); if (p.gradientStops.length < 2) fail(what + " gradient needs 2 stops"); }
    else if (p.type === "IMAGE") { if (!p.imageHash) fail(what + " image without hash"); }
    else fail(what + " unknown paint " + p.type);
  });
}

let nid = 0;
function makeNode(type, loadedFonts) {
  const n = { type, id: "1:" + (++nid), children: [], parent: null, removed: false, _w: 100, _h: 100, layoutMode: "NONE" };
  const store = {};
  const proxy = new Proxy(n, {
    set(t, k, v) {
      if (ENUMS[k] && ENUMS[k].indexOf(v) < 0) fail(type + "." + k + " bad enum " + v);
      if (NUMS.indexOf(k) >= 0) finite(v, type + "." + k);
      if (k === "fills" || k === "strokes") checkPaints(v, type + "." + k);
      if (k === "effects") v.forEach((e) => { finite(e.radius, "effect.radius"); if (e.offset) { finite(e.offset.x, "offset.x"); finite(e.offset.y, "offset.y"); } });
      if ((k === "layoutSizingHorizontal" || k === "layoutSizingVertical") && v === "FILL" && !(t.parent && t.parent.layoutMode !== "NONE")) fail("FILL outside auto layout");
      if ((k === "layoutSizingHorizontal" || k === "layoutSizingVertical") && v === "HUG" && t.type !== "TEXT" && t.layoutMode === "NONE") fail("HUG on non-auto-layout frame");
      if (k === "layoutPositioning" && v === "ABSOLUTE" && !(t.parent && t.parent.layoutMode !== "NONE")) fail("ABSOLUTE outside auto layout");
      if (k === "characters" || k === "fontName") {
        const fn = k === "fontName" ? v : t.fontName;
        if (!fn || !loadedFonts.has(fn.family + "|" + fn.style)) fail("font not loaded: " + JSON.stringify(fn));
      }
      if (k === "relativeTransform") v.flat().forEach((x) => finite(x, "relativeTransform"));
      if (k === "dashPattern") v.forEach((x) => finite(x, "dashPattern"));
      t[k] = v; return true;
    },
    get(t, k) {
      if (k === "width") return t._w;
      if (k === "height") return t._h;
      return t[k];
    }
  });
  n.appendChild = (c) => { c.parent = proxy; n.children.push(c); };
  n.resize = (w, h) => { finite(w, "resize.w"); finite(h, "resize.h"); if (w < 0.01 || h < 0.01) fail("resize below 0.01"); n._w = w; n._h = h; };
  n.rescale = (s) => { finite(s, "rescale"); n._w *= s; n._h *= s; };
  n.remove = () => { n.removed = true; };
  if (type === "TEXT") {
    const rangeFont = (fn) => { if (!loadedFonts.has(fn.family + "|" + fn.style)) fail("range font not loaded " + JSON.stringify(fn)); };
    const range = (a, b) => { finite(a, "range start"); finite(b, "range end"); if (a < 0 || b > (n.characters || "").length || a >= b) fail("bad range " + a + "-" + b); };
    n.setRangeFontName = (a, b, fn) => { range(a, b); rangeFont(fn); };
    n.setRangeFontSize = (a, b, v) => { range(a, b); finite(v, "fontSize"); if (v < 1) fail("fontSize < 1"); };
    n.setRangeFills = (a, b, v) => { range(a, b); checkPaints(v, "text fills"); };
    n.setRangeLetterSpacing = (a, b, v) => { range(a, b); finite(v.value, "letterSpacing"); };
    n.setRangeLineHeight = (a, b, v) => { range(a, b); finite(v.value, "lineHeight"); if (v.value <= 0) fail("lineHeight <= 0"); };
    n.setRangeTextDecoration = (a, b, v) => { range(a, b); if (["NONE", "UNDERLINE", "STRIKETHROUGH"].indexOf(v) < 0) fail("bad deco " + v); };
    n.setRangeTextCase = (a, b, v) => { range(a, b); if (["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"].indexOf(v) < 0) fail("bad case " + v); };
    n.setRangeHyperlink = (a, b) => range(a, b);
  }
  return proxy;
}

function figmaMock() {
  const loaded = new Set();
  const FONTS = [];
  [["Inter", ["Thin", "Extra Light", "Light", "Regular", "Medium", "Semi Bold", "Bold", "Extra Bold", "Black", "Italic", "Bold Italic"]],
   ["Roboto", ["Regular", "Medium", "Bold", "Italic"]], ["Roboto Mono", ["Regular", "Bold"]], ["Georgia", ["Regular", "Bold", "Italic"]],
   ["Arial", ["Regular", "Bold"]], ["Source Code Pro", ["Regular", "Bold"]]]
    .forEach(([f, ss]) => ss.forEach((s) => FONTS.push({ fontName: { family: f, style: s } })));
  const page = makeNode("PAGE", loaded);
  page.layoutMode = "NONE";
  return {
    currentPage: page,
    listAvailableFontsAsync: async () => FONTS,
    loadFontAsync: async (fn) => { if (!FONTS.some((f) => f.fontName.family === fn.family && f.fontName.style === fn.style)) throw new Error("no font"); loaded.add(fn.family + "|" + fn.style); },
    createFrame: () => makeNode("FRAME", loaded),
    createRectangle: () => makeNode("RECTANGLE", loaded),
    createText: () => makeNode("TEXT", loaded),
    createNodeFromSvg: (svg) => {
      if (!/^<svg[\s>]/.test(svg) || !/<\/svg>\s*$/.test(svg)) fail("svg not a standalone <svg> document");
      const n = makeNode("FRAME", loaded);
      const w = +(svg.match(/\swidth="([\d.]+)/) || [])[1] || 24, h = +(svg.match(/\sheight="([\d.]+)/) || [])[1] || 24;
      n.resize(w, h);
      return n;
    },
    createImage: (bytes) => { if (!bytes || !bytes.length) fail("empty image"); return { hash: "h" + bytes.length }; },
    base64Decode: (s) => new Uint8Array(Buffer.from(s, "base64"))
  };
}

(async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "builder.js"), "utf8");
  let bad = 0;
  for (const f of files) {
    const payload = JSON.parse(fs.readFileSync(path.join(OUT, path.basename(f)), "utf8"));
    for (const doc of payload.docs) {
      const figma = figmaMock();
      const ctx = vm.createContext({ figma, console, setTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, isFinite, Infinity, NaN });
      vm.runInContext(src + "\n;this.FeugeeBuild = FeugeeBuild;", ctx);
      const assets = {};
      for (const k in payload.assets) { const a = payload.assets[k]; assets[k] = {}; if (a.svg) assets[k].svg = a.svg; if (a.b64) assets[k].bytes = figma.base64Decode(a.b64); }
      const t0 = Date.now();
      let st;
      try { st = await ctx.FeugeeBuild.build(doc, assets, {}); }
      catch (e) { bad++; console.log("CRASH " + f + " " + doc.label + ": " + e.message); continue; }
      const ok = st.warnings.length === 0;
      if (!ok) bad++;
      console.log((ok ? "OK    " : "WARN  ") + f + "  " + doc.label + "  " + (Date.now() - t0) + "ms  nodes " + st.nodes +
        " texts " + st.texts + " vectors " + st.vectors + " images " + st.images + " autolayout " + st.autolayout +
        " missingImg " + st.missingImages + " svgFailed " + st.svgFailed);
      st.warnings.slice(0, 8).forEach((w) => console.log("      - " + w));
      if (st.warnings.length > 8) console.log("      ... +" + (st.warnings.length - 8));
    }
  }
  process.exit(bad ? 1 : 0);
})();
