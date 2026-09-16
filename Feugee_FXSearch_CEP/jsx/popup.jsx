/**
 * FEUGEE STUDIO - FX SEARCH  |  NATIVE POPUP (ScriptUI)
 *
 * Why this is ScriptUI and not CEP (the Feugee standard says CEP):
 * a CEP window cannot be hidden, only closed, so every open boots a fresh
 * Chromium - measured 1.2-1.5 s on AE 26.5 (process +354 ms, renderer
 * +807 ms, then page). This window is built once in the main ExtendScript
 * engine (alive for the whole session) and only shown / hidden after that.
 * The reasons behind the CEP rule (wheel scroll, responsive grid, CSS
 * animation) do not apply to a fixed-size, keyboard-driven popup.
 *
 * Loaded by FXCore.popupScript() - from the launcher (Ctrl+Space), the hub
 * (warm-up) or the panel (Open Search). It adds exactly one global,
 * FG_FXS_POPUP; js/fxcore.js is evaluated privately inside init().
 * Keep this file ASCII-only - non-ASCII glyphs are \u escapes.
 */

var FG_FXS_POPUP = (function () {

var VERSION = "1.1.1";
var W = 640;
var ROWS = 10;
var ROW_H = 30;

var FX = null;        // js/fxcore.js, evaluated privately in init()

var S = {
    root: "", win: null, field: null, list: null, target: null, scopes: null, foot: null,
    detail: null, count: null,
    items: [], map: {}, stamp: "", data: null, ctx: null,
    scope: "all", results: [], active: 0, top: 0,
    status: "", statusKind: "", shownAt: 0, busy: false,
    alt: false, shift: false, scopeHits: [],
    stripe: null, disposing: false, draws: 0, log: []
};

// ring buffer of recent events - read with FG_FXS_POPUP.state().log when a
// bug only shows up by hand (keyboard input cannot be scripted on macOS)
function trace(msg) {
    S.log.push(now() % 100000 + " " + msg);
    if (S.log.length > 40) S.log.shift();
}

// ==========================================================
// ES3 GUARDS  (AE 26.5 has these; older engines may not)
// ==========================================================
function polyfill() {
    var AP = Array.prototype;
    if (!AP.indexOf) AP.indexOf = function (v, from) {
        for (var i = from || 0; i < this.length; i++) if (this[i] === v) return i;
        return -1;
    };
    if (!AP.filter) AP.filter = function (fn) {
        var out = [];
        for (var i = 0; i < this.length; i++) if (fn(this[i], i)) out.push(this[i]);
        return out;
    };
    if (!AP.map) AP.map = function (fn) {
        var out = [];
        for (var i = 0; i < this.length; i++) out.push(fn(this[i], i));
        return out;
    };
    if (!AP.forEach) AP.forEach = function (fn) {
        for (var i = 0; i < this.length; i++) fn(this[i], i);
    };
}

// ==========================================================
// LOOK  -  tokens copied from panel.css (dark)
// ==========================================================
function hex(h, a) {
    return [parseInt(h.substr(1, 2), 16) / 255, parseInt(h.substr(3, 2), 16) / 255,
            parseInt(h.substr(5, 2), 16) / 255, a === undefined ? 1 : a];
}

var C = {
    bg: hex("#161619"), card: hex("#1e1e22"), tile: hex("#26262c"), tileHover: hex("#33333b"),
    stroke: hex("#34343d"), strokeSoft: hex("#2a2a31"),
    text: hex("#f1f1f4"), dim: hex("#b9b9c4"), muted: hex("#7b7b88"),
    orange: hex("#f2631c"), orangeDim: hex("#f2631c", 0.18), orangeMid: hex("#f2631c", 0.38),
    blue: hex("#60b4e2"), blueDim: hex("#60b4e2", 0.18),
    danger: hex("#e05a49"), dangerDim: hex("#e05a49", 0.18)
};

var F = {};
function makeFonts() {
    F.field = ScriptUI.newFont("dialog", "REGULAR", 15);
    F.name = ScriptUI.newFont("dialog", "REGULAR", 12);
    F.nameB = ScriptUI.newFont("dialog", "BOLD", 12);
    F.badge = ScriptUI.newFont("dialog", "BOLD", 8);
    F.small = ScriptUI.newFont("dialog", "REGULAR", 10);
    F.label = ScriptUI.newFont("dialog", "BOLD", 9);
    F.main = ScriptUI.newFont("dialog", "BOLD", 11);
    try { F.mono = ScriptUI.newFont("Menlo", "REGULAR", 9); } catch (e) { F.mono = F.small; }
}

var GLYPH = {
    enter: "\u21B5", shift: "\u21E7", opt: "\u2325", cmd: "\u2318", tab: "\u21E5",
    dot: "\u00B7", star: "\u2605", check: "\u2713", arrow: "\u2192", dash: "\u2014", ell: "\u2026"
};

function now() { return new Date().getTime(); }

// ---------- drawing helpers ----------
function fill(g, x, y, w, h, color) {
    g.newPath();
    g.rectPath(x, y, w, h);
    g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, color));
}

function outline(g, x, y, w, h, color) {
    g.newPath();
    g.rectPath(x + 0.5, y + 0.5, w - 1, h - 1);
    g.strokePath(g.newPen(g.PenType.SOLID_COLOR, color, 1));
}

function measure(g, s, font) { return s ? g.measureString(s, font)[0] : 0; }

function draw(g, s, x, y, font, color) {
    if (!s) return 0;
    g.drawString(s, g.newPen(g.PenType.SOLID_COLOR, color, 1), x, y, font);
    return measure(g, s, font);
}

// longest prefix of s that fits maxW with an ellipsis
function fitLength(g, s, font, maxW) {
    if (measure(g, s, font) <= maxW) return s.length;
    var lo = 0, hi = s.length;
    while (lo < hi) {
        var mid = Math.ceil((lo + hi) / 2);
        if (measure(g, s.substring(0, mid) + GLYPH.ell, font) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function drawFit(g, s, x, y, font, color, maxW) {
    var n = fitLength(g, s, font, maxW);
    return draw(g, n < s.length ? s.substring(0, n) + GLYPH.ell : s, x, y, font, color);
}

// Repaint a custom-drawn element. Measured on AE 26.5:
//   - reassigning the background brush invalidates it (+1 onDraw) and never
//     touches visibility
//   - hide()/show() also redraws, but a native Escape landing between the two
//     left every custom element hidden - blank popup, reported by Rijal
//   - notify("onDraw") aborts the whole script silently
var CLEAR = [0, 0, 0, 0];
function repaint(el) {
    if (!el || !S.win || !S.win.visible) return;
    try {
        el.graphics.backgroundColor = el.graphics.newBrush(el.graphics.BrushType.SOLID_COLOR, CLEAR);
        S.draws++;
    } catch (e) {
        trace("repaint failed: " + e);
    }
}

function customElements() {
    return [S.stripe, S.scopes, S.target, S.list, S.foot];
}

// never trust the previous session of the window: whatever interrupted it,
// every custom element is visible and redrawn when the popup opens
function heal() {
    var els = customElements();
    for (var i = 0; i < els.length; i++) {
        if (els[i] && !els[i].visible) {
            trace("heal: element " + i + " was hidden");
            els[i].visible = true;
        }
    }
}

// ==========================================================
// DATA
// ==========================================================
function lit(s) { return FX.lit(s); }

function boot() {
    var res = FG_FXS.boot(S.stamp);
    if (res.indexOf("OK|") !== 0) { setStatus(res.replace(/^ERR\|/, ""), "err"); return; }
    var d = JSON.parse(res.substring(3));
    S.ctx = d.ctx;
    S.data = FX.parseData(d.data);
    if (d.rows) {
        S.items = FX.buildItems(d.rows);
        S.map = FX.byId(S.items);
        S.stamp = d.stamp;
    }
    S.nfx = d.nfx;
    S.nps = d.nps;
}

function refreshContext() {
    var res = FG_FXS.context();
    if (res.indexOf("OK|") === 0) S.ctx = JSON.parse(res.substring(3));
}

function saveData() {
    FG_FXS.saveData(encodeURIComponent(JSON.stringify(S.data)));
}

function info(msg) {
    try { clearOutput(); writeLn("FX Search: " + msg); } catch (e) {}
}

// ==========================================================
// SEARCH + SELECTION
// ==========================================================
function runSearch() {
    S.query = S.field.text;
    S.results = FX.search(S.items, S.field.text, { scope: S.scope, data: S.data, map: S.map, limit: 80 });
    S.active = 0;
    S.top = 0;
    renderAll();
}

function renderAll() {
    var q = S.field.text.replace(/^\s+|\s+$/g, "");
    S.count.text = q ? S.results.length + (S.results.length >= 80 ? "+" : "") + " found"
                     : (S.nfx || 0) + " effects " + GLYPH.dot + " " + (S.nps || 0) + " presets";
    updateDetail();
    repaint(S.scopes);
    repaint(S.target);
    repaint(S.list);
    repaint(S.foot);
}

function setActive(i) {
    var n = S.results.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    if (i === S.active) return;
    S.active = i;
    if (S.active < S.top) S.top = S.active;
    if (S.active >= S.top + ROWS) S.top = S.active - ROWS + 1;
    updateDetail();
    repaint(S.list);
    repaint(S.target);
}

function move(d) {
    var n = S.results.length;
    if (!n) return;
    var i = S.active + d;
    if (Math.abs(d) === 1) i = (i + n) % n;      // arrows wrap, paging clamps
    setActive(i);
}

function setScope(scope) {
    S.scope = scope;
    runSearch();
}

function updateDetail() {
    var r = S.results[S.active];
    if (!r) { S.detail.text = ""; return; }
    var it = r.item;
    if (it.kind === "fx") {
        var t = FX.resolveTarget(it, S.data, S.map);
        S.detail.text = it.key + (t !== it ? "    override " + GLYPH.arrow + " " + t.name : "");
    } else if (it.kind === "preset") {
        S.detail.text = it.key;
    } else {
        S.detail.text = "command " + GLYPH.dot + " " + it.key;
    }
}

function setStatus(msg, kind) {
    S.status = msg || "";
    S.statusKind = kind || "";
    repaint(S.foot);
}

// ==========================================================
// ACTIONS
// ==========================================================
function applyAt(i, mode, keepOpen) {
    var r = S.results[i];
    if (!r || S.busy) return;
    var it = r.item;
    if (it.kind === "cmd") { runCommand(it.key, keepOpen); return; }

    var target = FX.resolveTarget(it, S.data, S.map);
    var st = S.data.settings;
    var opts = (st.noSelection === "adjustment" ? "A" : "") + (st.insertBelowSelected ? "B" : "");

    S.busy = true;
    var res;
    try { res = FG_FXS.apply(target.kind, target.key, mode, opts, it.name); }
    catch (e) { res = "ERR|" + e.toString(); }
    S.busy = false;

    var rep = FX.parseReply(res);
    if (!rep.ok) {
        setStatus(rep.msg, "err");
        refreshContext();
        repaint(S.target);
        return;
    }
    FX.recordUse(S.data, it.id);
    saveData();
    if (keepOpen || st.keepOpen) {
        S.field.text = "";
        refreshContext();
        S.results = FX.search(S.items, "", { scope: S.scope, data: S.data, map: S.map, limit: 80 });
        S.active = 0;
        S.top = 0;
        S.status = GLYPH.check + " " + rep.msg;
        S.statusKind = "ok";
        renderAll();
        S.field.active = true;
    } else {
        info(rep.msg);
        hide();
    }
}

function runCommand(key, keepOpen) {
    if (key === "library") {
        hide();
        var id = app.findMenuCommandId("Feugee FX Search");
        if (id) app.executeCommand(id);
        return;
    }
    if (key === "snapshot" || key === "snapshot-copy") {
        var copy = key === "snapshot-copy";
        var res = FG_FXS.snapshot();
        var rep = FX.parseReply(res);
        if (!rep.ok) { setStatus(rep.msg, "err"); return; }
        // the frame renders after this script returns, so the check is scheduled
        app.scheduleTask('if (typeof FG_FXS !== "undefined") FG_FXS.snapshotWatch(' + lit(rep.msg) + "," + copy + ",80)", 200, false);
        info("rendering snapshot" + GLYPH.ell);
        if (!keepOpen) hide(); else setStatus("Rendering snapshot" + GLYPH.ell, "");
        return;
    }
    if (key === "reindex") {
        var r2 = FX.parseReply(FG_FXS.reindex());
        S.stamp = "";
        boot();
        S.status = (r2.ok ? GLYPH.check + " " : "") + r2.msg;
        S.statusKind = r2.ok ? "ok" : "err";
        runSearch();
    }
}

function toggleFavorite() {
    var r = S.results[S.active];
    if (!r || r.item.kind === "cmd") return;
    var on = FX.toggleFavorite(S.data, r.item.id);
    saveData();
    S.status = (on ? GLYPH.star + " Starred " : "Unstarred ") + r.item.name;
    S.statusKind = on ? "ok" : "";
    renderAll();
}

function editAlias() {
    var r = S.results[S.active];
    if (!r || r.item.kind === "cmd") return;
    var id = r.item.id;
    var current = FX.aliasesOf(S.data, id)[0] || "";
    S.busy = true;
    var v = prompt("Alias for " + r.item.name + "  (empty removes it)", current, "Feugee FX Search");
    S.busy = false;
    S.field.active = true;
    if (v === null) return;
    var old = FX.aliasesOf(S.data, id);
    for (var i = 0; i < old.length; i++) delete S.data.aliases[old[i]];
    var alias = FX.normAlias(v);
    if (alias) FX.setAlias(S.data, alias, id);
    saveData();
    setStatus(alias ? "Alias \"" + alias + "\" " + GLYPH.arrow + " " + r.item.name : "Alias removed", "ok");
    repaint(S.list);
}

// ==========================================================
// DRAWING
// ==========================================================
function targetInfo() {
    var r = S.results[S.active];
    var ctx = S.ctx;
    var st = S.data.settings;
    if (r && r.item.kind === "cmd") return { kind: "cmd", verb: "RUN", main: r.item.name, side: ctx && ctx.comp ? ctx.comp : "" };
    if (!ctx || !ctx.comp) return { kind: "warn", verb: "NO COMP", main: "Open a composition first", side: "" };

    var stay = (S.shift || st.keepOpen) ? "  " + GLYPH.dot + "  stays open" : "";
    if (S.alt || (ctx.sel === 0 && st.noSelection === "adjustment")) {
        return { kind: "adj", verb: "NEW", main: "Adjustment layer " + (ctx.sel ? "above " + names(ctx) : "on top of " + ctx.comp),
                 side: (S.alt ? GLYPH.opt + " held" : "no layer selected") + stay };
    }
    if (ctx.sel === 0) {
        return { kind: "warn", verb: "NO LAYER", main: "Select layers in " + ctx.comp + "  " + GLYPH.dash + "  or " + GLYPH.opt + GLYPH.enter + " for an adjustment layer", side: "" };
    }
    var skip = ctx.sel - ctx.fxable;
    return { kind: "ok", verb: ctx.sel === 1 ? "APPLY TO" : "APPLY TO " + ctx.sel, main: names(ctx),
             side: (skip > 0 ? skip + " can't take effects" : ctx.comp) + stay };
}

function names(ctx) {
    var more = ctx.sel - Math.min(ctx.sel, ctx.names.length);
    return ctx.names.join(", ") + (more > 0 ? "  +" + more + " more" : "");
}

function drawStripe() {
    var g = this.graphics, w = this.size[0];
    fill(g, 0, 0, Math.round(w * 0.62), 2, C.orange);
    fill(g, Math.round(w * 0.62), 0, w - Math.round(w * 0.62), 2, C.blue);
}

var SCOPE_ORDER = ["all", "fx", "preset", "fav", "cmd"];
function drawScopes() {
    var g = this.graphics, w = this.size[0], h = this.size[1];
    var x = 16;
    S.scopeHits = [];
    for (var i = 0; i < SCOPE_ORDER.length; i++) {
        var key = SCOPE_ORDER[i];
        var label = FX.SCOPE_LABEL[key];
        var on = key === S.scope;
        var lw = measure(g, label, F.label);
        draw(g, label, x, 5, F.label, on ? C.text : C.muted);
        if (on) fill(g, x, h - 3, lw, 2, C.orange);
        S.scopeHits.push([x - 6, x + lw + 6, key]);
        x += lw + 18;
    }
    var hint = GLYPH.tab + " scope";
    draw(g, hint, w - 16 - measure(g, hint, F.small), 5, F.small, C.muted);
    fill(g, 0, h - 1, w, 1, C.strokeSoft);
}

function drawTarget() {
    var g = this.graphics, w = this.size[0];
    var t = targetInfo();
    var bgc = C.card, acc = C.muted, border = C.strokeSoft;
    if (t.kind === "ok") { bgc = C.orangeDim; acc = C.orange; border = C.orangeMid; }
    else if (t.kind === "adj") { bgc = C.blueDim; acc = C.blue; border = C.blue; }
    else if (t.kind === "warn") { bgc = C.dangerDim; acc = C.danger; border = C.danger; }
    else if (t.kind === "cmd") { acc = C.dim; }

    var x0 = 12, y0 = 6, bw = w - 24, bh = 26;
    fill(g, x0, y0, bw, bh, bgc);
    outline(g, x0, y0, bw, bh, border);
    fill(g, x0 + 10, y0 + 10, 6, 6, acc);
    var x = x0 + 24;
    x += draw(g, t.verb, x, y0 + 7, F.label, acc) + 10;
    var sideW = t.side ? Math.min(measure(g, t.side, F.small), 200) : 0;
    if (t.side) drawFit(g, t.side, x0 + bw - 10 - sideW, y0 + 7, F.small, C.muted, 200);
    drawFit(g, t.main, x, y0 + 6, F.main, C.text, x0 + bw - 20 - sideW - x);
}

function drawList() {
    var g = this.graphics, w = this.size[0], h = this.size[1];
    if (!S.results.length) {
        var q = S.field.text.replace(/^\s+|\s+$/g, "");
        // no chained ternaries anywhere in this file: ExtendScript parses
        // a ? b : c ? d : e as (a ? b : c) ? d : e
        var msg = "Type to search";
        if (!S.items.length) msg = "Building the effect index" + GLYPH.ell;
        else if (q) msg = "Nothing matches \"" + q + "\"" + (S.scope !== "all" ? "  -  Tab to widen the scope" : "");
        else if (S.scope === "fav") msg = "No favorites yet  -  highlight a result and press " + GLYPH.cmd + "S";
        draw(g, msg, 24, 18, F.name, C.muted);
        return;
    }
    for (var r = 0; r < ROWS; r++) {
        var i = S.top + r;
        var res = S.results[i];
        if (!res) break;
        var it = res.item;
        var y = 2 + r * ROW_H;
        var on = i === S.active;
        var acc = C.orange, badge = "FX", badgeBg = C.orangeDim;
        if (it.kind === "preset") { acc = C.blue; badge = "PRESET"; badgeBg = C.blueDim; }
        if (it.kind === "cmd") { acc = C.dim; badge = "CMD"; badgeBg = C.tile; }

        if (on) {
            fill(g, 8, y, w - 16, ROW_H - 2, C.tile);
            fill(g, 10, y + 7, 3, ROW_H - 16, acc);
        }

        fill(g, 20, y + 7, 40, 14, badgeBg);
        draw(g, badge, 20 + (40 - measure(g, badge, F.badge)) / 2, y + 8, F.badge, acc);

        // right column, drawn first so the name knows how much room is left
        var right = w - 18;
        var nth = i < 9 ? GLYPH.cmd + (i + 1) : "";
        if (nth) draw(g, nth, right - measure(g, nth, F.small), y + 8, F.small, C.muted);
        right -= 30;

        var fav = S.data.favorites.indexOf(it.id) >= 0;
        if (fav) draw(g, GLYPH.star, right - 10, y + 7, F.name, C.orange);
        right -= 18;

        var cat = res.section === "RECENT" ? "recent" : it.cat;
        var catW = Math.min(measure(g, cat, F.small), 170);
        drawFit(g, cat, right - catW, y + 8, F.small, C.muted, 170);
        right -= catW + 14;

        var x = 72;
        var aliases = FX.aliasesOf(S.data, it.id);
        var font = on ? F.nameB : F.name;
        var base = on ? C.text : C.dim;
        var tail = it.obsolete ? "  obsolete" : "";
        var aliasW = aliases.length ? measure(g, aliases[0], F.mono) + 10 : 0;
        var over = it.kind === "fx" && S.data.overrides[it.id] ? "  " + GLYPH.arrow + " PRESET" : "";
        var maxName = right - x - aliasW - (tail || over ? 70 : 0);

        var n = fitLength(g, it.name, font, maxName);
        var segs = FX.segments(it.name.substring(0, n), res.pos);
        for (var s = 0; s < segs.length; s++) {
            x += draw(g, segs[s].t, x, y + 7, font, segs[s].hit ? acc : base);
        }
        if (n < it.name.length) x += draw(g, GLYPH.ell, x, y + 7, font, base);
        if (tail) x += draw(g, tail, x, y + 9, F.small, C.muted);
        if (over) x += draw(g, over, x, y + 9, F.badge, C.blue);
        if (aliases.length) {
            x += 8;
            var aw = measure(g, aliases[0], F.mono);
            outline(g, x, y + 7, aw + 8, 15, C.stroke);
            draw(g, aliases[0], x + 4, y + 9, F.mono, C.dim);
        }
    }
    // scroll position
    var n2 = S.results.length;
    if (n2 > ROWS) {
        var track = ROWS * ROW_H;
        var th = Math.max(18, Math.round(track * ROWS / n2));
        var ty = Math.round((track - th) * S.top / (n2 - ROWS));
        fill(g, w - 5, 2 + ty, 3, th, C.stroke);
    }
}

function drawFoot() {
    var g = this.graphics, w = this.size[0], h = this.size[1];
    fill(g, 0, 0, w, h, C.card);
    fill(g, 0, 0, w, 1, C.strokeSoft);

    var statusW = 0;
    if (S.status) {
        var col = C.dim;
        if (S.statusKind === "err") col = C.danger;
        if (S.statusKind === "ok") col = C.orange;
        statusW = Math.min(measure(g, S.status, F.small), S.statusKind === "err" ? w - 40 : 300);
        drawFit(g, S.status, w - 16 - statusW, 9, F.small, col, statusW);
    }

    var hints = [[GLYPH.enter, "apply"], [GLYPH.shift + GLYPH.enter, "stack"], [GLYPH.opt + GLYPH.enter, "adjustment"],
                 [GLYPH.cmd + "S", "star"], [GLYPH.cmd + "K", "alias"], ["esc", "close"]];
    var x = 16;
    var limit = w - 32 - statusW;
    for (var i = 0; i < hints.length; i++) {
        var kw = measure(g, hints[i][0], F.small) + 10;
        var lw = measure(g, hints[i][1], F.small);
        if (x + kw + 5 + lw > limit) break;
        fill(g, x, 7, kw, 16, C.tile);
        outline(g, x, 7, kw, 16, C.stroke);
        draw(g, hints[i][0], x + 5, 9, F.small, C.dim);
        x += kw + 5;
        x += draw(g, hints[i][1], x, 9, F.small, C.muted) + 13;
    }
}

// ==========================================================
// WINDOW
// ==========================================================
function build() {
    makeFonts();
    var win = new Window("palette", "Feugee FX Search", undefined, { closeButton: true, resizeable: false, borderless: true });
    win.orientation = "column";
    win.alignChildren = ["fill", "top"];
    win.spacing = 0;
    win.margins = 0;
    win.graphics.backgroundColor = win.graphics.newBrush(win.graphics.BrushType.SOLID_COLOR, C.bg);

    S.stripe = win.add("group");
    S.stripe.preferredSize = [W, 2];
    S.stripe.onDraw = drawStripe;

    var head = win.add("group");
    head.margins = [16, 12, 16, 8];
    head.spacing = 12;
    head.alignChildren = ["left", "center"];
    S.field = head.add("edittext", undefined, "");
    S.field.preferredSize = [W - 32 - 12 - 130, 28];
    try { S.field.graphics.font = F.field; } catch (e) {}
    S.count = head.add("statictext", undefined, "");
    S.count.preferredSize = [130, 16];
    S.count.justify = "right";
    S.count.graphics.font = F.small;
    S.count.graphics.foregroundColor = S.count.graphics.newPen(S.count.graphics.PenType.SOLID_COLOR, C.muted, 1);

    S.scopes = win.add("group");
    S.scopes.preferredSize = [W, 24];
    S.scopes.onDraw = drawScopes;

    S.target = win.add("group");
    S.target.preferredSize = [W, 36];
    S.target.onDraw = drawTarget;

    S.list = win.add("group");
    S.list.preferredSize = [W, ROWS * ROW_H + 6];
    S.list.onDraw = drawList;

    var detailWrap = win.add("group");
    detailWrap.margins = [16, 2, 16, 4];
    S.detail = detailWrap.add("statictext", undefined, "");
    S.detail.preferredSize = [W - 32, 14];
    S.detail.graphics.font = F.mono;
    S.detail.graphics.foregroundColor = S.detail.graphics.newPen(S.detail.graphics.PenType.SOLID_COLOR, C.muted, 1);

    S.foot = win.add("group");
    S.foot.preferredSize = [W, 30];
    S.foot.onDraw = drawFoot;

    // ---------- keyboard ----------
    S.field.onChanging = function () { runSearch(); };
    // macOS text fields can change the text without onChanging (native
    // cancel on Escape); resync whenever the field reports an edit
    S.field.onChange = function () {
        if (S.field.text !== S.query) { trace("onChange resync"); runSearch(); }
    };
    S.field.addEventListener("keydown", function (e) {
        var k = e.keyName;
        trace("key " + k + (e.altKey ? "+alt" : "") + (e.shiftKey ? "+shift" : "") + ((e.metaKey || e.ctrlKey) ? "+mod" : ""));
        var mod = e.metaKey || e.ctrlKey;
        if (k === "Down") { move(1); e.preventDefault(); return; }
        if (k === "Up") { move(-1); e.preventDefault(); return; }
        if (k === "PageDown" || k === "Page_Down") { move(ROWS); e.preventDefault(); return; }
        if (k === "PageUp" || k === "Page_Up") { move(-ROWS); e.preventDefault(); return; }
        if (k === "Enter" || k === "Return") {
            e.preventDefault();
            applyAt(S.active, e.altKey ? "adj" : "sel", e.shiftKey);
            return;
        }
        if (k === "Tab") {
            e.preventDefault();
            setScope(FX.nextScope(S.scope, e.shiftKey ? -1 : 1));
            return;
        }
        if (k === "Escape") {
            // one press closes; the query is reset on the next open
            e.preventDefault();
            hide();
            return;
        }
        if (mod && (k === "S" || k === "s")) { e.preventDefault(); toggleFavorite(); return; }
        if (mod && (k === "K" || k === "k")) { e.preventDefault(); editAlias(); return; }
        if (mod && /^[1-9]$/.test(k)) {
            e.preventDefault();
            applyAt(Number(k) - 1, e.altKey ? "adj" : "sel", e.shiftKey);
            return;
        }
        var alt = !!e.altKey, shift = !!e.shiftKey;
        if (alt !== S.alt || shift !== S.shift) { S.alt = alt; S.shift = shift; repaint(S.target); }
    });
    S.field.addEventListener("keyup", function (e) {
        var alt = !!e.altKey, shift = !!e.shiftKey;
        if (alt !== S.alt || shift !== S.shift) { S.alt = alt; S.shift = shift; repaint(S.target); }
    });

    // ---------- mouse ----------
    S.list.addEventListener("mousedown", function (e) {
        var i = S.top + Math.floor((e.clientY - 2) / ROW_H);
        if (i < 0 || i >= S.results.length) return;
        applyAt(i, e.altKey ? "adj" : "sel", e.shiftKey);
    });
    S.list.addEventListener("mousemove", function (e) {
        var i = S.top + Math.floor((e.clientY - 2) / ROW_H);
        if (i >= 0 && i < S.results.length && i !== S.active) setActive(i);
    });
    S.scopes.addEventListener("mousedown", function (e) {
        for (var i = 0; i < S.scopeHits.length; i++) {
            if (e.clientX >= S.scopeHits[i][0] && e.clientX <= S.scopeHits[i][1]) { setScope(S.scopeHits[i][2]); break; }
        }
        S.field.active = true;
    });

    // Escape while focus sits on the list or scope strip
    win.addEventListener("keydown", function (e) {
        if (e.keyName === "Escape" && e.target !== S.field) { trace("win Escape"); e.preventDefault(); hide(); }
    });
    // any native close (Escape on some macOS builds, the close button)
    // becomes our hide, so the window object and its state stay valid
    win.onClose = function () {
        if (S.disposing) return true;
        trace("native close -> hide");
        hide();
        return false;
    };

    // ---------- focus ----------
    win.onActivate = function () {
        refreshContext();
        repaint(S.target);
    };
    win.onDeactivate = function () {
        trace("deactivate");
        S.alt = S.shift = false;
        if (S.busy || !S.data || !S.data.settings.closeOnBlur) return;
        if (now() - S.shownAt < 500) return;     // macOS can blink focus while showing
        hide();
    };

    win.layout.layout(true);
    win.center();
    S.win = win;
    S.builtAt = now();
}

// ==========================================================
// PUBLIC
// ==========================================================
function init(root) {
    S.root = root;
    polyfill();
    if (typeof JSON === "undefined") throw new Error("FX Search needs After Effects 2020 or newer");
    // Evaluated here, not with $.evalFile at top level, so FXCore stays out
    // of the main engine that every Feugee panel shares.
    var f = new File(root + "/js/fxcore.js");
    f.encoding = "UTF-8";
    if (!f.open("r")) throw new Error("Cannot read " + f.fsName);
    var src = f.read();
    f.close();
    FX = eval(src + "\n;FXCore");
}

function warm() {
    if (!S.data) S.data = FX.emptyData();
    boot();
    if (!S.win) build();
    return S.items.length + " items";
}

function show() {
    var t0 = now();
    if (!S.data) S.data = FX.emptyData();
    if (!S.win) build();
    boot();
    S.status = "";
    S.statusKind = "";
    S.alt = S.shift = false;
    S.field.text = "";
    S.results = FX.search(S.items, "", { scope: S.scope, data: S.data, map: S.map, limit: 80 });
    S.active = 0;
    S.top = 0;
    S.query = "";
    S.shownAt = now();
    S.win.show();
    heal();
    renderAll();
    S.field.active = true;
    trace("show");
    S.lastShowMs = now() - t0;
    S.shows = (S.shows || 0) + 1;
    return "shown";
}

function hide() {
    if (S.win && S.win.visible) {
        trace("hide");
        S.win.hide();
    }
}

// an older version is being replaced: close its window instead of leaking it
function dispose() {
    if (S.win) {
        S.disposing = true;
        try { S.win.close(); } catch (e) {}
        S.win = null;
        S.disposing = false;
    }
    return "disposed";
}

function state() {
    return { version: VERSION, built: !!S.win, visible: !!(S.win && S.win.visible), items: S.items.length,
             results: S.results.length, active: S.active, lastShowMs: S.lastShowMs, shows: S.shows || 0,
             builtAt: S.builtAt, stamp: S.stamp, query: S.win ? S.field.text : "", draws: S.draws,
             hidden: hiddenElements(), log: S.log.slice(0) };
}

function hiddenElements() {
    var out = [];
    var els = customElements();
    for (var i = 0; i < els.length; i++) if (els[i] && !els[i].visible) out.push(i);
    return out;
}

// test hook: type a query and press keys through the real handlers
// (native macOS text behaviour is not reproduced - that still needs a hand)
function simulate(text, keys) {
    if (!S.win || !S.win.visible) return "not visible";
    S.field.text = text;
    runSearch();
    for (var i = 0; i < (keys || []).length; i++) {
        var ev = ScriptUI.events.createEvent("KeyboardEvent");
        ev.initKeyboardEvent("keydown", true, true, S.field, keys[i], 0, "");
        S.field.dispatchEvent(ev);
    }
    return state();
}

// test hook: run a query without touching the window
function query(q, scope) {
    return FX.search(S.items, q, { scope: scope || "all", data: S.data || FX.emptyData(), map: S.map, limit: 80 });
}

return { version: VERSION, init: init, warm: warm, show: show, hide: hide, dispose: dispose, state: state,
         query: query, simulate: simulate };

})();
