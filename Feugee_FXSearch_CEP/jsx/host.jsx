/**
 * FEUGEE STUDIO - FX SEARCH  |  HOST SCRIPT (ExtendScript)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * This file has NO UI. Three extensions talk to it:
 *   hub.html      invisible, auto-starts, installs the launcher, warms the popup
 *   popup.jsx     the Ctrl+Space popup - native ScriptUI, kept alive in the main engine
 *   index.html    the library panel (favorites, aliases, overrides, snapshots)
 * Every entry point returns "OK|message" or "ERR|message".
 *
 * Keep this file ASCII-only: CEP evaluates ScriptPath without a declared
 * encoding, so non-ASCII literals are written as \u escapes.
 */

/* ---------------------------------------------------------------------------
   NAMESPACE - do not remove. Every CEP extension in one After Effects instance
   shares ONE global ExtendScript scope, so the host exposes a single object.
   --------------------------------------------------------------------------- */

var FG_FXS = (function () {

var VERSION = "1.1.1";
var BUNDLE_ID = "com.feugee.fxsearch";
var EVENT_DATA = "com.feugee.fxsearch.data";
var LAUNCHER_NAME = "Feugee FX Search.jsx";
var ARROW = "\u2192";
var OPT = "\u2325";

// The panel re-evaluates this file when it opens (ScriptPath / Reload button).
// Carry the index over from the previous instance so that does not cost a
// fresh preset scan - it is data, not code, and Rebuild index still forces it.
var cache = (typeof FG_FXS !== "undefined" && FG_FXS && FG_FXS._cache) ? FG_FXS._cache() : null;
var plug = null;
var audioFx = null;   // matchName -> true, built on first apply

// ==========================================================
// SMALL HELPERS  (ES3: no Array#indexOf / filter / map, no trim)
// ==========================================================
function jstr(s) {
    return '"' + String(s)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) {
            var h = c.charCodeAt(0).toString(16);
            while (h.length < 4) h = "0" + h;
            return "\\u" + h;
        }) + '"';
}

function isMac() { return $.os.toLowerCase().indexOf("mac") >= 0; }

function readText(file) {
    if (!file || !file.exists) return "";
    file.encoding = "UTF-8";
    if (!file.open("r")) return "";
    var t = file.read();
    file.close();
    return t;
}

function writeText(file, text) {
    file.encoding = "UTF-8";
    file.lineFeed = "Unix";
    if (!file.open("w")) return false;
    var ok = file.write(text);
    file.close();
    return ok;
}

function ensureFolder(path) {
    var f = new Folder(path);
    if (!f.exists) f.create();
    return f;
}

function dataFolder() { return ensureFolder(Folder.userData.fsName + "/Feugee"); }
function dataFile() { return new File(dataFolder().fsName + "/fxsearch.json"); }
function snapFolder() { return ensureFolder(Folder.myDocuments.fsName + "/Feugee Snapshots"); }

function activeComp() {
    var item = app.project ? app.project.activeItem : null;
    return (item instanceof CompItem) ? item : null;
}

function copyLayers(coll) {
    var out = [];
    if (!coll) return out;
    for (var i = 0; i < coll.length; i++) out.push(coll[i]);
    return out;
}

function deselectLayers(comp) {
    var sel = copyLayers(comp.selectedLayers);
    for (var i = 0; i < sel.length; i++) sel[i].selected = false;
}

function dispatch(type, data) {
    try {
        if (!plug) plug = new ExternalObject("lib:PlugPlugExternalObject");
        var ev = new CSXSEvent();
        ev.type = type;
        ev.data = data || "";
        ev.dispatch();
        return true;
    } catch (e) {
        return false;
    }
}

// Preset folders live in the data file; parse it without trusting JSON exists.
function presetFoldersFromData() {
    var text = readText(dataFile());
    if (!text) return [];
    try {
        if (typeof JSON !== "undefined") {
            var d = JSON.parse(text);
            var out = [];
            if (d && d.presetFolders && d.presetFolders.length) {
                for (var i = 0; i < d.presetFolders.length; i++) {
                    if (typeof d.presetFolders[i] === "string") out.push(d.presetFolders[i]);
                }
            }
            return out;
        }
    } catch (e) {}
    var m = text.match(/"presetFolders"\s*:\s*\[([^\]]*)\]/);
    if (!m) return [];
    var list = [];
    var re = /"((?:[^"\\]|\\.)*)"/g;
    var s;
    while ((s = re.exec(m[1])) !== null) list.push(s[1].replace(/\\(.)/g, "$1"));
    return list;
}

// ==========================================================
// INDEX
// Rows: [kind, name, category, key, obsolete]  kind "f" effect / "p" preset
// ==========================================================
function scanEffects(rows) {
    var fx = app.effects;
    var n = 0;
    for (var i = 0; i < fx.length; i++) {
        var e = fx[i];
        // Blank category = internal effects AE hides from its own Effects menu
        if (!e.category || !e.displayName) continue;
        var obsolete = /obsolete/i.test(e.category);
        var cat = e.category.replace(/^_+/, "");
        rows.push('["f",' + jstr(e.displayName) + ',' + jstr(cat) + ',' + jstr(e.matchName) + ',' + (obsolete ? 1 : 0) + ']');
        n++;
    }
    return n;
}

function presetRoots(custom) {
    var roots = [];
    var seen = {};
    function add(folder, label) {
        if (!folder || !folder.exists) return;
        var key = folder.fsName.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        roots.push({ folder: folder, label: label });
    }

    // macOS: <AE>/Presets next to the .app   Windows: Support Files/Presets
    add(new Folder(Folder.appPackage.parent.fsName + "/Presets"), "");
    add(new Folder(Folder.appPackage.fsName + "/Presets"), "");

    var year = String(Folder.appPackage.fsName).match(/After Effects (\d{4})/);
    var adobeDocs = new Folder(Folder.myDocuments.fsName + "/Adobe");
    if (adobeDocs.exists) {
        var subs = adobeDocs.getFiles();
        for (var i = 0; i < subs.length; i++) {
            if (!(subs[i] instanceof Folder)) continue;
            var nm = subs[i].displayName;
            if (!/^After Effects/.test(nm)) continue;
            if (year && nm.indexOf(year[1]) < 0) continue;
            add(new Folder(subs[i].fsName + "/User Presets"), "User Presets");
        }
    }
    for (var c = 0; c < custom.length; c++) {
        var cf = new Folder(custom[c]);
        add(cf, cf.displayName);
    }
    return roots;
}

function scanPresetFolder(folder, rel, rows, depth, budget) {
    if (depth > 8 || budget.left <= 0) return;
    var list = folder.getFiles();
    for (var i = 0; i < list.length && budget.left > 0; i++) {
        var f = list[i];
        var nm = f.displayName;
        if (f instanceof Folder) {
            // "(instructional)"-style folders are AE's own hidden support folders
            if (nm.charAt(0) === "." || nm.charAt(0) === "(") continue;
            scanPresetFolder(f, rel ? rel + " / " + nm : nm, rows, depth + 1, budget);
        } else if (/\.ffx$/i.test(nm)) {
            budget.left--;
            rows.push('["p",' + jstr(nm.replace(/\.ffx$/i, "")) + ',' + jstr(rel || "Presets") + ',' + jstr(f.fsName) + ',0]');
        }
    }
}

function getIndex(force) {
    var folders = presetFoldersFromData();
    var folderKey = folders.join("\n");
    if (cache && !force && cache.folders === folderKey) return cache;

    var rows = [];
    var nfx = scanEffects(rows);
    var before = rows.length;
    var roots = presetRoots(folders);
    var budget = { left: 8000 };
    for (var r = 0; r < roots.length; r++) {
        scanPresetFolder(roots[r].folder, roots[r].label, rows, 0, budget);
    }
    var nps = rows.length - before;
    cache = {
        stamp: [app.version, nfx, nps, folderKey.length, rows.join("").length].join("|"),
        rows: "[" + rows.join(",") + "]",
        nfx: nfx,
        nps: nps,
        folders: folderKey
    };
    return cache;
}

// ==========================================================
// CONTEXT - what Enter would hit right now
// ==========================================================
function contextJson() {
    var comp = activeComp();
    if (!comp) return '{"comp":null,"sel":0,"fxable":0,"names":[]}';
    var sel = copyLayers(comp.selectedLayers);
    var fxable = 0;
    var names = [];
    for (var i = 0; i < sel.length; i++) {
        if (sel[i].property("ADBE Effect Parade")) fxable++;
        if (names.length < 3) names.push(jstr(sel[i].name));
    }
    return '{"comp":' + jstr(comp.name) + ',"sel":' + sel.length + ',"fxable":' + fxable +
           ',"names":[' + names.join(",") + ']}';
}

// ==========================================================
// APPLY
// ==========================================================
function makeAdjustment(comp, layers, label) {
    var adj = comp.layers.addSolid([1, 1, 1], label + " Adjustment", comp.width, comp.height,
                                   comp.pixelAspect, comp.duration);
    adj.adjustmentLayer = true;
    if (layers.length) {
        var top = layers[0];
        var inP = layers[0].inPoint;
        var outP = layers[0].outPoint;
        for (var i = 1; i < layers.length; i++) {
            if (layers[i].index < top.index) top = layers[i];
            if (layers[i].inPoint < inP) inP = layers[i].inPoint;
            if (layers[i].outPoint > outP) outP = layers[i].outPoint;
        }
        adj.moveBefore(top);
        inP = Math.max(0, inP);
        outP = Math.min(comp.duration, outP);
        if (outP > inP) {
            adj.inPoint = inP;
            adj.outPoint = outP;
        }
    }
    return adj;
}

// Scripting lets an audio effect onto a solid; the Effect menu does not.
// Follow the menu.
function isAudioEffect(matchName) {
    if (!audioFx) {
        audioFx = {};
        var fx = app.effects;
        for (var i = 0; i < fx.length; i++) {
            if (fx[i].category === "Audio") audioFx[fx[i].matchName] = true;
        }
    }
    return audioFx[matchName] === true;
}

function applyEffect(targets, matchName, belowSelected) {
    var r = { done: 0, cant: 0, locked: 0, name: "" };
    var audio = isAudioEffect(matchName);
    for (var i = 0; i < targets.length; i++) {
        var layer = targets[i];
        var parade = layer.property("ADBE Effect Parade");
        if (!parade || !parade.canAddProperty(matchName) || (audio && !layer.hasAudio)) { r.cant++; continue; }
        if (layer.locked) { r.locked++; continue; }

        var anchor = 0;
        if (belowSelected) {
            for (var j = 1; j <= parade.numProperties; j++) {
                if (parade.property(j).selected) anchor = j;
            }
        }
        var eff = parade.addProperty(matchName);
        r.name = eff.name;
        var idx = eff.propertyIndex;
        if (anchor > 0 && anchor + 1 < idx) {
            eff.moveTo(anchor + 1);     // invalidates `eff`
            idx = anchor + 1;
        }
        if (belowSelected) {
            // Hand the selection to the new effect, so the next stacked
            // effect (Shift+Enter) lands under this one.
            for (var k = 1; k <= parade.numProperties; k++) {
                var p = parade.property(k);
                if (k !== idx && p.selected) p.selected = false;
            }
            parade.property(idx).selected = true;
        }
        r.done++;
    }
    return r;
}

// applyPreset follows the layer selection, so each layer gets selected alone.
function applyPresetFile(comp, targets, file) {
    var r = { done: 0, cant: 0, locked: 0, name: file.displayName.replace(/\.ffx$/i, "") };
    for (var i = 0; i < targets.length; i++) {
        var layer = targets[i];
        if (layer.locked) { r.locked++; continue; }
        deselectLayers(comp);
        layer.selected = true;
        try {
            layer.applyPreset(file);
            r.done++;
        } catch (e) {
            r.cant++;
        }
    }
    return r;
}

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

/**
 * kind  "fx" | "preset"
 * key   effect matchName, or absolute .ffx path
 * mode  "sel" = every selected layer, "adj" = a new adjustment layer
 * opts  "A" no selection falls back to an adjustment layer
 *       "B" insert below the selected effect
 */
function apply(kind, key, mode, opts, label) {
    var comp = activeComp();
    if (!comp) return "ERR|Open a composition first";
    if (kind !== "fx" && kind !== "preset") return "ERR|Unknown item type";
    opts = String(opts || "");
    label = String(label || key);

    var layers = copyLayers(comp.selectedLayers);
    var useAdj = mode === "adj" || (layers.length === 0 && opts.indexOf("A") >= 0);
    if (!useAdj && layers.length === 0) {
        return "ERR|Select a layer first - or " + OPT + " Enter for a new adjustment layer";
    }

    var file = null;
    if (kind === "preset") {
        file = new File(key);
        if (!file.exists) {
            return "ERR|Preset file not found: " + String(key).split(/[\\\/]/).pop() + " - rebuild the index";
        }
    }

    var r = null;
    var adj = null;
    var err = "";
    app.beginUndoGroup("Feugee FX Search: " + label);
    try {
        var targets = layers;
        if (useAdj) {
            adj = makeAdjustment(comp, layers, label);
            targets = [adj];
        }
        if (kind === "fx") {
            r = applyEffect(targets, key, opts.indexOf("B") >= 0);
        } else {
            r = applyPresetFile(comp, targets, file);
        }

        if (r.done === 0 && adj) {
            adj.remove();
            adj = null;
        }

        // Only presets and adjustment layers disturb the layer selection.
        // Touching it after a plain effect would also clear the effect
        // selection that Insert-below relies on.
        if (adj || kind === "preset") {
            deselectLayers(comp);
            if (adj) {
                adj.selected = true;
            } else {
                for (var s = 0; s < layers.length; s++) {
                    try { layers[s].selected = true; } catch (e1) {}
                }
            }
        }
    } catch (e) {
        err = e.toString();
    }
    app.endUndoGroup();

    if (err) return "ERR|" + err;
    var name = r.name || label;
    if (r.done === 0) {
        if (r.locked && !r.cant) return "ERR|" + name + ": the selected layers are locked";
        return "ERR|" + name + " can't be applied to " + (layers.length === 1 ? "this layer" : "these layers");
    }
    if (adj) return "OK|" + name + " " + ARROW + " new adjustment layer";

    var msg = name + " " + ARROW + " " + (r.done === targets.length ? plural(r.done, "layer")
              : r.done + " of " + plural(targets.length, "layer"));
    var skipped = [];
    if (r.cant) skipped.push(r.cant + " can't take it");
    if (r.locked) skipped.push(r.locked + " locked");
    if (skipped.length) msg += " (" + skipped.join(", ") + ")";
    return "OK|" + msg;
}

// ==========================================================
// SNAPSHOT
// ==========================================================
function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

function copyImageToClipboard(file) {
    if (isMac()) {
        var scpt = new File(Folder.temp.fsName + "/feugee_fxs_clip.applescript");
        var path = file.fsName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        writeText(scpt, 'set the clipboard to (read (POSIX file "' + path + '") as \u00ABclass PNGf\u00BB)\n');
        system.callSystem('osascript "' + scpt.fsName + '"');
    } else {
        var p = file.fsName.replace(/'/g, "''");
        system.callSystem('powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms;' +
            ' Add-Type -AssemblyName System.Drawing;' +
            " [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('" + p + "'))\"");
    }
}

// saveFrameToPng renders AFTER the calling script returns - measured on
// AE 26.5: the file is absent for as long as the script keeps waiting, and
// present on the very next evalScript. So this is two calls: snapshot()
// starts the render, snapshotStatus() is polled by the panel until the file
// size stops changing.
function snapshot() {
    var comp = activeComp();
    if (!comp) return "ERR|Open a composition first";
    var now = new Date();
    var frame = Math.round(comp.time * comp.frameRate);
    var safe = comp.name.replace(/[\\\/:*?"<>|]+/g, "_").substring(0, 60);
    var stamp = now.getFullYear() + pad(now.getMonth() + 1, 2) + pad(now.getDate(), 2) + "-" +
                pad(now.getHours(), 2) + pad(now.getMinutes(), 2) + pad(now.getSeconds(), 2);
    var file = new File(snapFolder().fsName + "/" + safe + "_f" + pad(frame, 5) + "_" + stamp + ".png");

    try {
        comp.saveFrameToPng(comp.time, file);
    } catch (e) {
        return "ERR|Snapshot failed: " + e.toString();
    }
    return "OK|" + file.fsName;
}

// "WAIT|" while rendering, then "OK|message" once the file is complete.
// Stateless on purpose: the panel re-evaluates this file (ScriptPath, Reload),
// which would wipe any "last size seen" kept between calls. The render lands
// between script calls, so a file that holds its size across a short sleep
// inside one call is finished.
function snapshotStatus(path, copy) {
    var file = new File(path);
    if (!file.exists || file.length <= 0) return "WAIT|";
    var len = file.length;
    $.sleep(60);
    file = new File(path);
    if (file.length !== len) return "WAIT|";
    if (copy) {
        copyImageToClipboard(file);
        return "OK|Frame copied to clipboard";
    }
    return "OK|Saved " + file.displayName;
}

// Scheduled by the popup after snapshot(): keeps checking between script
// runs, reports in the Info panel because the popup is already hidden.
function snapshotWatch(path, copy, tries) {
    var r = snapshotStatus(path, copy);
    if (r.indexOf("WAIT|") === 0) {
        if (tries > 0) {
            app.scheduleTask('if (typeof FG_FXS !== "undefined") FG_FXS.snapshotWatch(' + jstr(path) + "," +
                             (copy ? "true" : "false") + "," + (tries - 1) + ")", 150, false);
        } else {
            infoLine("snapshot is still rendering - check the Feugee Snapshots folder");
        }
        return r;
    }
    infoLine(r.substring(r.indexOf("|") + 1));
    return r;
}

function infoLine(msg) {
    try { clearOutput(); writeLn("FX Search: " + msg); } catch (e) {}
}

function listSnapshots() {
    var folder = snapFolder();
    var files = folder.getFiles(function (f) { return f instanceof File && /\.(png|jpe?g)$/i.test(f.name); });
    var list = [];
    for (var i = 0; i < files.length; i++) list.push(files[i]);
    list.sort(function (a, b) { return b.modified.getTime() - a.modified.getTime(); });
    var out = [];
    for (var j = 0; j < list.length && j < 60; j++) {
        out.push('{"p":' + jstr(list[j].fsName) + ',"n":' + jstr(list[j].displayName) + ',"t":' + list[j].modified.getTime() + '}');
    }
    return "OK|{\"folder\":" + jstr(folder.fsName) + ",\"items\":[" + out.join(",") + "]}";
}

function reveal(path) {
    var f = new File(path);
    if (!f.exists) {
        var d = new Folder(path);
        if (!d.exists) return "ERR|Not found";
        d.execute();
        return "OK|Opened";
    }
    if (isMac()) system.callSystem('open -R "' + f.fsName.replace(/"/g, '\\"') + '"');
    else system.callSystem('explorer /select,"' + f.fsName + '"');
    return "OK|Revealed " + f.displayName;
}

function openSnapshots() { snapFolder().execute(); return "OK|Opened snapshot folder"; }

// ==========================================================
// PICKERS  (user-initiated native dialogs, never on a normal path)
// ==========================================================
function pickPreset() {
    var filter = isMac() ? function (f) { return f instanceof Folder || /\.ffx$/i.test(f.name); }
                         : "Animation Presets:*.ffx";
    var f = File.openDialog("Choose an animation preset (.ffx)", filter, false);
    return f ? "OK|" + f.fsName : "ERR|";
}

function pickFolder() {
    var f = Folder.selectDialog("Choose a folder with animation presets");
    return f ? "OK|" + f.fsName : "ERR|";
}

// ==========================================================
// DATA  (the panel/popup own the JSON; the host only stores it)
// ==========================================================
function loadData() { return "OK|" + readText(dataFile()); }

function saveData(encoded) {
    var text;
    try { text = decodeURIComponent(encoded); } catch (e) { return "ERR|Bad data payload"; }
    if (!writeText(dataFile(), text)) return "ERR|Could not write " + dataFile().fsName;
    dispatch(EVENT_DATA, String(new Date().getTime()));
    return "OK|Saved";
}

function boot(clientStamp) {
    var idx = getIndex(false);
    var parts = [
        '"ctx":' + contextJson(),
        '"data":' + jstr(readText(dataFile())),
        '"stamp":' + jstr(idx.stamp),
        '"nfx":' + idx.nfx,
        '"nps":' + idx.nps
    ];
    if (clientStamp !== idx.stamp) parts.push('"rows":' + idx.rows);
    return "OK|{" + parts.join(",") + "}";
}

function context() { return "OK|" + contextJson(); }

function reindex() {
    var idx = getIndex(true);
    return "OK|Indexed " + idx.nfx + " effects and " + idx.nps + " presets";
}

// ==========================================================
// SHORTCUT LAUNCHER
// File > Scripts items are real menu commands, so Edit > Keyboard Shortcuts
// can bind Ctrl+Space to this launcher. It loads and shows the native popup.
// ==========================================================
function prefsRoot() {
    if (isMac()) return new Folder(Folder.userData.parent.fsName + "/Preferences/Adobe/After Effects");
    return new Folder(Folder.userData.fsName + "/Adobe/After Effects");
}

function launcherSource(extPath) {
    var candidates = [];
    if (extPath) candidates.push(String(extPath).replace(/\\/g, "/"));
    candidates.push("USERDATA/Adobe/CEP/extensions/" + BUNDLE_ID);
    candidates.push(isMac() ? "/Library/Application Support/Adobe/CEP/extensions/" + BUNDLE_ID
                            : "C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/" + BUNDLE_ID);
    var lits = [];
    for (var i = 0; i < candidates.length; i++) lits.push(jstr(candidates[i]));
    var rootExpr = "(function () { var roots = [" + lits.join(", ") + "]; " +
        "for (var i = 0; i < roots.length; i++) { var r = roots[i].replace(\"USERDATA\", Folder.userData.fsName); " +
        "if (new File(r + \"/jsx/popup.jsx\").exists) return r; } return \"\"; })()";

    // No #targetengine and no function wrapper - see FXCore.popupScript().
    // The popup lives in the main engine next to the CEP panels, so the hub
    // can warm it and the panel can open it without going through the menu
    // (app.executeCommand on a File > Scripts item does nothing when called
    // from another script - measured).
    return [
        "// Feugee FX Search - shortcut launcher v" + VERSION + " (generated by the plugin, do not edit)",
        "// Bind a key in Edit > Keyboard Shortcuts: search for \"Feugee FX Search\".",
        popupSource(rootExpr, "show"),
        "if (typeof FG_FXS_POPUP === \"undefined\") { try { clearOutput(); writeLn(\"FX Search: popup files not found - reinstall the extension\"); } catch (e) {} }",
        ""
    ].join("\n");
}

// Mirror of FXCore.popupScript() for the launcher (the host has no FXCore).
// tools/tests/test-fxsearch.js checks the two stay identical.
function popupSource(rootExpr, action) {
    return [
        'try {',
        '  if (typeof FG_FXS_POPUP === "undefined" || FG_FXS_POPUP.version !== ' + jstr(VERSION) + ') {',
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

function versionFolders() {
    var root = prefsRoot();
    var out = [];
    if (!root.exists) return out;
    var subs = root.getFiles();
    for (var i = 0; i < subs.length; i++) {
        if (subs[i] instanceof Folder && /^\d+(\.\d+)*$/.test(subs[i].displayName)) out.push(subs[i]);
    }
    return out;
}

function currentVersion() {
    var m = String(app.version).match(/^(\d+\.\d+)/);
    return m ? m[1] : "";
}

function installLauncher(extPath) {
    var src = launcherSource(extPath);
    var cur = currentVersion();
    var written = [];
    var same = [];
    var folders = versionFolders();
    for (var i = 0; i < folders.length; i++) {
        var scripts = ensureFolder(folders[i].fsName + "/Scripts");
        var f = new File(scripts.fsName + "/" + LAUNCHER_NAME);
        if (readText(f) === src) { same.push(folders[i].displayName); continue; }
        if (writeText(f, src)) written.push(folders[i].displayName);
    }
    if (!written.length && !same.length) return "ERR|No After Effects preferences folder found";
    var needsRestart = false;
    for (var w = 0; w < written.length; w++) if (written[w] === cur) needsRestart = true;
    if (written.length) {
        return "OK|Launcher installed in AE " + written.join(", ") +
               (needsRestart ? " - restart AE once, then bind the shortcut" : "");
    }
    return "OK|Launcher ready in AE " + same.join(", ");
}

function launcherStatus() {
    var cur = currentVersion();
    var f = new File(prefsRoot().fsName + "/" + cur + "/Scripts/" + LAUNCHER_NAME);
    return "OK|{\"version\":" + jstr(cur) + ",\"installed\":" + (f.exists ? "true" : "false") + "}";
}

function ping() { return "OK|FX Search host v" + VERSION; }

return {
    ping: ping,
    snapshotWatch: snapshotWatch,
    boot: boot,
    context: context,
    reindex: reindex,
    apply: apply,
    loadData: loadData,
    saveData: saveData,
    snapshot: snapshot,
    snapshotStatus: snapshotStatus,
    listSnapshots: listSnapshots,
    openSnapshots: openSnapshots,
    reveal: reveal,
    pickPreset: pickPreset,
    pickFolder: pickFolder,
    installLauncher: installLauncher,
    launcherStatus: launcherStatus,
    _cache: function () { return cache; }
};

})();
