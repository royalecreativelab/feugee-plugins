/* =========================================================
   FEUGEE FX SEARCH  -  CORE (pure, no DOM, no host)

   Shared by the native popup (jsx/popup.jsx, ExtendScript) and the
   library panel (index.html, CEP) - so keep it ES3-friendly and ASCII. Everything here is plain functions over plain
   data so tools/tests/test-fxsearch.js can run it under Node.

   Item    { id, kind: "fx"|"preset"|"cmd", name, cat, key, obsolete }
   Data    { favorites:[id], aliases:{alias:id}, overrides:{id:id},
             usage:{id:n}, recent:[id], presetFolders:[path], settings:{} }
   ========================================================= */
var FXCore = (function () {
  "use strict";

  var DEFAULT_SETTINGS = {
    noSelection: "adjustment",   // "adjustment" | "error"
    insertBelowSelected: true,   // new effect lands under the selected effect
    showObsolete: false,
    keepOpen: false,             // Enter behaves like Shift+Enter
    closeOnBlur: true            // clicking back into AE dismisses the popup
  };

  var SCOPES = ["all", "fx", "preset", "fav", "cmd"];
  var SCOPE_LABEL = { all: "ALL", fx: "EFFECTS", preset: "PRESETS", fav: "FAVORITES", cmd: "COMMANDS" };

  var COMMANDS = [
    { key: "snapshot",      name: "Snapshot - save frame as PNG",   cat: "Snapshot" },
    { key: "snapshot-copy", name: "Snapshot - copy frame to clipboard", cat: "Snapshot" },
    { key: "reindex",       name: "Rebuild effect & preset index", cat: "FX Search" },
    { key: "library",       name: "Open FX Search library panel",  cat: "FX Search" }
  ];

  // ---------------------------------------------------------
  // DATA
  // ---------------------------------------------------------
  function emptyData() {
    return { v: 1, favorites: [], aliases: {}, overrides: {}, usage: {}, recent: [],
             presetFolders: [], settings: clone(DEFAULT_SETTINGS) };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Anything missing or of the wrong type falls back to the default, so a
  // hand-edited or half-written file can never take the popup down.
  function normalizeData(raw) {
    var d = emptyData();
    if (!raw || typeof raw !== "object") return d;
    if (isArr(raw.favorites)) d.favorites = raw.favorites.filter(isStr);
    if (isObj(raw.aliases)) d.aliases = pickStr(raw.aliases);
    if (isObj(raw.overrides)) d.overrides = pickStr(raw.overrides);
    if (isObj(raw.usage)) {
      for (var k in raw.usage) if (typeof raw.usage[k] === "number") d.usage[k] = raw.usage[k];
    }
    if (isArr(raw.recent)) d.recent = raw.recent.filter(isStr).slice(0, 30);
    if (isArr(raw.presetFolders)) d.presetFolders = raw.presetFolders.filter(isStr);
    if (isObj(raw.settings)) {
      for (var s in DEFAULT_SETTINGS) {
        if (typeof raw.settings[s] === typeof DEFAULT_SETTINGS[s]) d.settings[s] = raw.settings[s];
      }
    }
    return d;
  }

  function parseData(text) {
    if (!text) return emptyData();
    try { return normalizeData(JSON.parse(text)); } catch (e) { return emptyData(); }
  }

  function isArr(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function isObj(v) { return v && typeof v === "object" && !isArr(v); }
  function isStr(v) { return typeof v === "string" && v.length > 0; }
  function pickStr(o) {
    var out = {};
    for (var k in o) if (isStr(k) && isStr(o[k])) out[k] = o[k];
    return out;
  }

  function recordUse(data, id) {
    data.usage[id] = (data.usage[id] || 0) + 1;
    data.recent = [id].concat(data.recent.filter(function (r) { return r !== id; })).slice(0, 30);
    return data;
  }

  function toggleFavorite(data, id) {
    var i = data.favorites.indexOf(id);
    if (i >= 0) data.favorites.splice(i, 1); else data.favorites.push(id);
    return i < 0;
  }

  function normAlias(a) { return String(a || "").toLowerCase().replace(/\s+/g, ""); }

  function setAlias(data, alias, id) {
    var a = normAlias(alias);
    if (!a) return false;
    data.aliases[a] = id;
    return true;
  }

  function aliasesOf(data, id) {
    var out = [];
    for (var a in data.aliases) if (data.aliases[a] === id) out.push(a);
    return out.sort();
  }

  // ---------------------------------------------------------
  // INDEX  (host payload -> items)
  //
  // The host sends rows, not objects, to keep the evalScript string small:
  //   [kind, name, category, key, obsoleteFlag]
  // ---------------------------------------------------------
  function buildItems(rows) {
    var items = [];
    var seen = {};
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || !r[1] || !r[3]) continue;
      var kind = r[0] === "p" ? "preset" : "fx";
      var id = (kind === "fx" ? "fx:" : "ps:") + r[3];
      if (seen[id]) continue;
      seen[id] = true;
      items.push(prep({ id: id, kind: kind, name: String(r[1]), cat: String(r[2] || ""),
                        key: String(r[3]), obsolete: !!r[4] }));
    }
    for (var c = 0; c < COMMANDS.length; c++) {
      var cmd = COMMANDS[c];
      items.push(prep({ id: "cmd:" + cmd.key, kind: "cmd", name: cmd.name, cat: cmd.cat,
                        key: cmd.key, obsolete: false }));
    }
    return items;
  }

  function prep(item) {
    item.low = item.name.toLowerCase();
    item.words = splitWords(item.name);
    item.initials = item.words.map(function (w) { return w.text.charAt(0); }).join("");
    item.catLow = item.cat.toLowerCase();
    item.keyLow = item.kind === "fx" ? item.key.toLowerCase() : "";
    return item;
  }

  // Word starts inside the original name, so highlights map straight back.
  // "CC Ball Action" -> CC, Ball, Action   "Hue/Saturation" -> Hue, Saturation
  // "VR Blur"        -> VR, Blur           "Lumetri Color"  -> Lumetri, Color
  function splitWords(name) {
    var words = [];
    var re = /[A-Za-z0-9\u00C0-\uFFFF]+/g;
    var m;
    while ((m = re.exec(name)) !== null) {
      words.push({ text: m[0].toLowerCase(), start: m.index });
    }
    return words;
  }

  function byId(items) {
    var map = {};
    for (var i = 0; i < items.length; i++) map[items[i].id] = items[i];
    return map;
  }

  // ---------------------------------------------------------
  // SCORING
  //
  // Tiers are far apart so a weaker match can never out-rank a stronger
  // one through usage bonuses alone; bonuses only sort inside a tier.
  // ---------------------------------------------------------
  var T_ALIAS = 100000, T_EXACT = 50000, T_PREFIX = 30000, T_WORDS = 28500,
      T_INITIALS = 27000, T_SUBSTR = 15000, T_TOKENS = 12000, T_META = 6000, T_FUZZY = 3000;

  function normQuery(q) { return String(q || "").toLowerCase().replace(/^\s+|\s+$/g, "").replace(/\s+/g, " "); }

  function matchName(q, item) {
    // returns { tier, pos:[indices] } or null
    var low = item.low;
    if (low === q) return { tier: T_EXACT, pos: range(0, q.length) };
    if (low.indexOf(q) === 0) return { tier: T_PREFIX - low.length, pos: range(0, q.length) };

    var tokens = q.split(" ");

    // every query token starts a word, in order: "gau bl" -> Gaussian Blur
    var wp = wordPrefixes(tokens, item.words);
    if (wp) return { tier: T_WORDS - item.words.length, pos: wp };

    // initials: "gb" -> Gaussian Blur, "ccba" -> CC Ball Action
    if (tokens.length === 1 && q.length >= 2 && item.initials.indexOf(q) === 0) {
      var ip = [];
      for (var i = 0; i < q.length; i++) ip.push(item.words[i].start);
      return { tier: T_INITIALS - item.words.length, pos: ip };
    }

    var at = low.indexOf(q);
    if (at > 0) return { tier: T_SUBSTR - at, pos: range(at, at + q.length) };

    if (tokens.length > 1) {
      var tp = [];
      for (var t = 0; t < tokens.length; t++) {
        var ti = low.indexOf(tokens[t]);
        if (ti < 0) { tp = null; break; }
        tp = tp.concat(range(ti, ti + tokens[t].length));
      }
      if (tp) return { tier: T_TOKENS, pos: tp };
    }

    if (q.length >= 3) {
      var fz = subsequence(q.replace(/ /g, ""), low);
      if (fz) return { tier: T_FUZZY - fz.gaps * 12 - low.length, pos: fz.pos };
    }
    return null;
  }

  function wordPrefixes(tokens, words) {
    var pos = [];
    var w = 0;
    for (var t = 0; t < tokens.length; t++) {
      var tok = tokens[t];
      if (!tok) continue;
      while (w < words.length && words[w].text.indexOf(tok) !== 0) w++;
      if (w >= words.length) return null;
      pos = pos.concat(range(words[w].start, words[w].start + tok.length));
      w++;
    }
    return pos.length ? pos : null;
  }

  function subsequence(q, text) {
    var pos = [];
    var gaps = 0;
    var last = -1;
    for (var i = 0; i < q.length; i++) {
      var at = text.indexOf(q.charAt(i), last + 1);
      if (at < 0) return null;
      if (last >= 0 && at !== last + 1) gaps++;
      pos.push(at);
      last = at;
    }
    // a subsequence spread over the whole name is noise, not a match
    if (gaps > Math.max(2, Math.floor(q.length / 2))) return null;
    return { gaps: gaps, pos: pos };
  }

  function range(a, b) { var out = []; for (var i = a; i < b; i++) out.push(i); return out; }

  // Everyday effects win ties: "blur" should reach Gaussian Blur before
  // VR Blur, "gb" Gaussian Blur before Grow Bounds. Worth less than one tier
  // step, so it only breaks ties; the user's own usage takes over quickly.
  var COMMON = {};
  ("ADBE Gaussian Blur 2|ADBE Box Blur2|ADBE Motion Blur|ADBE Camera Lens Blur|CC Radial Fast Blur|" +
   "ADBE Glo2|ADBE Drop Shadow|ADBE Fill|ADBE Tint|ADBE CurvesCustom|ADBE Easy Levels2|ADBE HUE SATURATION|" +
   "ADBE Lumetri|ADBE Exposure2|ADBE Brightness & Contrast 2|ADBE Vibrance|ADBE Color Balance 2|ADBE Tritone|" +
   "ADBE Fractal Noise|ADBE Turbulent Displace|ADBE Displacement Map|ADBE Noise|ADBE Add Grain|" +
   "ADBE Echo|ADBE Posterize Time|ADBE Linear Wipe|ADBE Radial Wipe|ADBE Venetian Blinds|ADBE Ramp|" +
   "ADBE 4ColorGradient|ADBE Geometry2|ADBE Tile|ADBE Offset|ADBE Corner Pin|ADBE Wave Warp|ADBE Bulge|" +
   "ADBE Twirl|ADBE Simple Choker|ADBE Matte Choker|ADBE Set Matte3|ADBE Invert|ADBE Unsharp Mask2|" +
   "ADBE Mosaic|ADBE Stroke|ADBE Roughen Edges|ADBE Find Edges|ADBE Slider Control|ADBE Checkbox Control|" +
   "ADBE Point Control|ADBE Color Control|ADBE Angle Control|ADBE Layer Control|ADBE Keylight 1.2")
    .split("|").forEach(function (m) { COMMON["fx:" + m] = true; });

  function bonus(item, data) {
    var b = 0;
    if (COMMON[item.id]) b += 600;
    if (data.favorites.indexOf(item.id) >= 0) b += 400;
    b += Math.min(data.usage[item.id] || 0, 30) * 20;
    var r = data.recent.indexOf(item.id);
    if (r >= 0 && r < 10) b += (10 - r) * 15;
    // Presets sit one tier below effects: typing "blur" means Gaussian Blur,
    // not the "Blur - Gaussian In" transition preset. The Presets scope
    // (Tab) removes the effects from the race entirely.
    if (item.kind === "preset") b -= 2000;
    if (item.obsolete) b -= 2500;
    if (item.kind === "preset" && /^legacy/i.test(item.cat)) b -= 800;
    return b;
  }

  function inScope(item, scope, data) {
    if (scope === "fx") return item.kind === "fx";
    if (scope === "preset") return item.kind === "preset";
    if (scope === "cmd") return item.kind === "cmd";
    if (scope === "fav") return data.favorites.indexOf(item.id) >= 0;
    return true;
  }

  function scoreItem(q, item, data) {
    var m = matchName(q, item);
    if (!m) {
      if (q.length >= 2 && (item.catLow.indexOf(q) >= 0 || (item.keyLow && item.keyLow.indexOf(q) >= 0))) {
        m = { tier: T_META, pos: [] };
      } else {
        return null;
      }
    }
    return { item: item, score: m.tier + bonus(item, data), pos: m.pos };
  }

  /**
   * search(items, query, { scope, data, limit })
   *   -> [{ item, score, pos, section? }]
   * Empty query returns favorites then recents, tagged with `section`.
   */
  function search(items, query, opts) {
    opts = opts || {};
    var data = opts.data || emptyData();
    var scope = opts.scope || "all";
    var limit = opts.limit || 60;
    var showObsolete = !!(data.settings && data.settings.showObsolete);
    var q = normQuery(query);
    var map = opts.map || byId(items);

    if (!q) return idleList(items, map, data, scope, limit);

    var out = [];
    var aliasId = data.aliases[normAlias(q)];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!inScope(it, scope, data)) continue;
      if (it.obsolete && !showObsolete && it.id !== aliasId) continue;
      var s = scoreItem(q, it, data);
      if (it.id === aliasId) {
        s = s || { item: it, score: 0, pos: [] };
        s.score += T_ALIAS;
        s.alias = true;
      }
      if (s) out.push(s);
    }
    out.sort(function (a, b) {
      return b.score - a.score || a.item.name.length - b.item.name.length || cmp(a.item.low, b.item.low);
    });
    return out.slice(0, limit);
  }

  // No chained ternaries in this file: it also runs in ExtendScript (the
  // native popup), which parses a ? b : c ? d : e as (a ? b : c) ? d : e.
  // tools/tests/test-fxsearch.js scans for them.
  function cmp(x, y) {
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  }

  function idleList(items, map, data, scope, limit) {
    var out = [];
    var used = {};
    function push(id, section) {
      var it = map[id];
      if (!it || used[id] || !inScope(it, scope, data)) return;
      used[id] = true;
      out.push({ item: it, score: 0, pos: [], section: section });
    }
    for (var f = 0; f < data.favorites.length; f++) push(data.favorites[f], "FAVORITES");
    for (var r = 0; r < data.recent.length; r++) push(data.recent[r], "RECENT");
    if (scope === "cmd" || (scope === "all" && !out.length)) {
      for (var c = 0; c < items.length; c++) if (items[c].kind === "cmd") push(items[c].id, "COMMANDS");
    }
    if ((scope === "fx" || scope === "preset") && out.length < limit) {
      var rest = items.filter(function (it) {
        return !used[it.id] && inScope(it, scope, data) && (!it.obsolete || data.settings.showObsolete);
      }).sort(function (a, b) {
        return cmp(a.catLow, b.catLow) || cmp(a.low, b.low);
      });
      for (var x = 0; x < rest.length && out.length < limit; x++) push(rest[x].id, "A-Z");
    }
    return out.slice(0, limit);
  }

  // Override: applying an effect runs the user's preset instead.
  function resolveTarget(item, data, map) {
    if (item.kind !== "fx") return item;
    var over = data.overrides[item.id];
    if (over && map[over]) return map[over];
    if (over && over.indexOf("ps:") === 0) {
      var path = over.substring(3);
      return { id: over, kind: "preset", key: path, name: path.split(/[\\\/]/).pop().replace(/\.ffx$/i, ""), cat: "Override" };
    }
    return item;
  }

  // [0,1,2,5] over "Gaussian" -> [{t:"Gau",hit:true},{t:"ss",hit:false},{t:"i",hit:true},...]
  function segments(text, pos) {
    var hit = {};
    for (var i = 0; i < (pos || []).length; i++) hit[pos[i]] = true;
    var out = [];
    for (var c = 0; c < text.length; c++) {
      var h = !!hit[c];
      if (out.length && out[out.length - 1].hit === h) out[out.length - 1].t += text.charAt(c);
      else out.push({ t: text.charAt(c), hit: h });
    }
    return out;
  }

  function nextScope(scope, dir) {
    var i = SCOPES.indexOf(scope);
    if (i < 0) i = 0;
    return SCOPES[(i + (dir < 0 ? SCOPES.length - 1 : 1)) % SCOPES.length];
  }

  // ---------------------------------------------------------
  // HOST CALL BUILDERS
  // JSON string literals are valid ExtendScript string literals.
  // ---------------------------------------------------------
  function lit(s) { return JSON.stringify(String(s)); }

  function applyCall(target, mode, data, displayName) {
    var st = data.settings || DEFAULT_SETTINGS;
    var opts = (st.noSelection === "adjustment" ? "A" : "") + (st.insertBelowSelected ? "B" : "");
    return "FG_FXS.apply(" + lit(target.kind) + "," + lit(target.key) + "," + lit(mode) + "," +
           lit(opts) + "," + lit(displayName || target.name) + ")";
  }

  function saveCall(data) { return "FG_FXS.saveData(" + lit(encodeURIComponent(JSON.stringify(data))) + ")"; }

  /**
   * Snapshot is two host calls (see host.jsx). evalFn(script, cb) is the
   * caller's bridge; done({ ok, msg }) fires once, success or timeout.
   */
  function snapshot(evalFn, copy, done, opts) {
    opts = opts || {};
    var interval = opts.interval || 150, limit = opts.timeout || 20000, waited = 0;
    evalFn("FG_FXS.snapshot()", function (res) {
      var rep = parseReply(res);
      if (!rep.ok) { done(rep); return; }
      var path = rep.msg;
      (function poll() {
        evalFn("FG_FXS.snapshotStatus(" + lit(path) + "," + (copy ? "true" : "false") + ")", function (r) {
          if (String(r).indexOf("WAIT|") === 0) {
            waited += interval;
            if (waited >= limit) { done({ ok: false, msg: "Snapshot is still rendering - check the folder later" }); return; }
            setTimeout(poll, interval);
            return;
          }
          done(parseReply(r));
        });
      })();
    });
  }

  /**
   * ExtendScript that loads the native popup (once per version) into the
   * shared main engine and runs one action: "show" or "warm".
   *
   * Must be evaluated as a TOP-LEVEL script - evalScript string or a
   * File > Scripts launcher - never from inside a function: $.evalFile
   * evaluates into the calling scope, so a file loaded inside a function
   * loses its globals when that function returns (measured on AE 26.5).
   * The root travels in an env var so the script declares no variables of
   * its own in an engine every Feugee panel shares.
   */
  function popupScript(rootExpr, action, version) {
    return [
      'try {',
      '  if (typeof FG_FXS_POPUP === "undefined" || FG_FXS_POPUP.version !== ' + lit(version) + ') {',
      '    if (typeof FG_FXS_POPUP !== "undefined" && FG_FXS_POPUP.dispose) FG_FXS_POPUP.dispose();',
      '    $.setenv("FEUGEE_FXS_ROOT", ' + rootExpr + ');',
      '    if ($.getenv("FEUGEE_FXS_ROOT") && new File($.getenv("FEUGEE_FXS_ROOT") + "/jsx/popup.jsx").exists) {',
      '      if (typeof FG_FXS === "undefined") $.evalFile(new File($.getenv("FEUGEE_FXS_ROOT") + "/jsx/host.jsx"));',
      '      $.evalFile(new File($.getenv("FEUGEE_FXS_ROOT") + "/jsx/popup.jsx"));',
      '      FG_FXS_POPUP.init($.getenv("FEUGEE_FXS_ROOT"));',
      '    }',
      '  }',
      '  typeof FG_FXS_POPUP === "undefined" ? "ERR|FX Search popup files not found" : "OK|" + FG_FXS_POPUP.' + action + '();',
      '} catch (e) {',
      '  "ERR|" + e.toString() + " (line " + e.line + ")";',
      '}'
    ].join("\n");
  }

  function parseReply(res) {
    res = typeof res === "string" ? res : "";
    var sep = res.indexOf("|");
    if (sep < 0) return { ok: false, msg: res || "No reply from host" };
    return { ok: res.substring(0, sep) === "OK", msg: res.substring(sep + 1) };
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS, SCOPES: SCOPES, SCOPE_LABEL: SCOPE_LABEL, COMMANDS: COMMANDS,
    emptyData: emptyData, normalizeData: normalizeData, parseData: parseData,
    recordUse: recordUse, toggleFavorite: toggleFavorite, setAlias: setAlias, aliasesOf: aliasesOf,
    normAlias: normAlias, buildItems: buildItems, byId: byId, search: search, resolveTarget: resolveTarget,
    segments: segments, nextScope: nextScope, applyCall: applyCall, saveCall: saveCall,
    parseReply: parseReply, lit: lit, splitWords: splitWords, snapshot: snapshot,
    popupScript: popupScript, POPUP_VERSION: "1.1.1"
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FXCore;
