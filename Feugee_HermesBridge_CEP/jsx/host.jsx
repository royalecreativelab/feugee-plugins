// host.jsx - Hermes Bridge v2 (ExtendScript, ES3).
// ASCII only. AE's ExtendScript has NO JSON object - serialize by hand.
// Every hbX() returns a JSON string. Mutating calls run in one undo group.

function hbStr(s) {
    s = String(s);
    var out = "", c, code, i, h;
    for (i = 0; i < s.length; i++) {
        c = s.charAt(i);
        code = s.charCodeAt(i);
        if (c === "\\") out += "\\\\";
        else if (c === "\"") out += "\\\"";
        else if (c === "\n") out += "\\n";
        else if (c === "\r") out += "\\r";
        else if (c === "\t") out += "\\t";
        else if (code < 32 || code > 126) {
            h = code.toString(16);
            while (h.length < 4) h = "0" + h;
            out += "\\u" + h;
        } else out += c;
    }
    return "\"" + out + "\"";
}

function hbJson(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v, i, a, k;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return hbStr(v);
    if (v instanceof Array) {
        a = [];
        for (i = 0; i < v.length; i++) a.push(hbJson(v[i]));
        return "[" + a.join(",") + "]";
    }
    a = [];
    for (k in v) {
        if (v.hasOwnProperty(k)) a.push(hbStr(k) + ":" + hbJson(v[k]));
    }
    return "{" + a.join(",") + "}";
}

function hbRound(n) { return Math.round(n * 1000) / 1000; }

function hbVal(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return hbRound(v);
    if (typeof v === "boolean" || typeof v === "string") return v;
    if (v instanceof Array) {
        var a = [], i;
        for (i = 0; i < v.length; i++) a.push(hbVal(v[i]));
        return a;
    }
    try { if (v.text !== undefined) return String(v.text); } catch (e) {}
    try { if (v.vertices !== undefined) return "[path " + v.vertices.length + " pts]"; } catch (e2) {}
    return String(v);
}

function hbLayerType(l) {
    try {
        if (l instanceof CameraLayer) return "camera";
        if (l instanceof LightLayer) return "light";
        if (l instanceof ShapeLayer) return "shape";
        if (l instanceof TextLayer) return "text";
        if (l instanceof AVLayer) {
            if (l.nullLayer) return "null";
            if (l.adjustmentLayer) return "adjustment";
            if (l.source instanceof CompItem) return "precomp";
            if (l.source && l.source.mainSource instanceof SolidSource) return "solid";
            return "footage";
        }
    } catch (e) {}
    return "layer";
}

function hbComp(ref) {
    var p = app.project, i, it;
    if (!p) throw new Error("no project open");
    if (ref === undefined || ref === null || ref === "") {
        it = p.activeItem;
        if (it && it instanceof CompItem) return it;
        throw new Error("no active comp - open a composition in the timeline");
    }
    for (i = 1; i <= p.numItems; i++) {
        it = p.item(i);
        if (it instanceof CompItem && (it.name === String(ref) || it.id === Number(ref))) return it;
    }
    throw new Error("comp not found: " + ref);
}

function hbOk(data) { return hbJson({ ok: true, data: data }); }
function hbErr(e) {
    return hbJson({ ok: false, error: (e && e.toString ? e.toString() : String(e)) + (e && e.line ? " (line " + e.line + ")" : "") });
}

// ---- panel UI helpers --------------------------------------------------

// Short status line for the panel meta.
function hbCompMeta() {
    try {
        var c = app.project ? app.project.activeItem : null;
        if (!(c && c instanceof CompItem)) return "No composition open";
        return c.name + "  " + c.width + "x" + c.height + " @" + hbRound(c.frameRate) +
               "  |  " + c.selectedLayers.length + " selected / " + c.numLayers;
    } catch (e) { return "No composition open"; }
}

function hbPing() { return "PONG " + app.version; }

// ---- MCP tools ----------------------------------------------------------

// Comp summary + layer table. maxLayers caps the list (default 60).
function hbGetComp(compRef, maxLayers) {
    try {
        var c = hbComp(compRef), i, l, n, layers = [], sel = [];
        n = Math.min(c.numLayers, maxLayers || 60);
        for (i = 1; i <= n; i++) {
            l = c.layer(i);
            var row = {
                i: l.index, name: l.name, type: hbLayerType(l), on: l.enabled,
                "in": hbRound(l.inPoint), out: hbRound(l.outPoint)
            };
            if (l.selected) row.sel = true;
            if (l.parent) row.parent = l.parent.index;
            if (l.threeDLayer) row.threeD = true;
            if (l.shy) row.shy = true;
            if (l.locked) row.locked = true;
            if (l.label) row.label = l.label;
            if (l instanceof AVLayer && l.source) {
                row.source = l.source.name;
                if (l.source instanceof CompItem) row.sourceId = l.source.id;
            }
            layers.push(row);
        }
        var sl = c.selectedLayers;
        for (i = 0; i < sl.length; i++) sel.push(sl[i].index);
        return hbOk({
            project: app.project.file ? app.project.file.fsName : "(unsaved)",
            comp: {
                id: c.id, name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect,
                fps: hbRound(c.frameRate), duration: hbRound(c.duration), time: hbRound(c.time),
                workStart: hbRound(c.workAreaStart), workEnd: hbRound(c.workAreaStart + c.workAreaDuration),
                bg: hbVal(c.bgColor), numLayers: c.numLayers
            },
            selected: sel,
            layers: layers,
            truncated: c.numLayers > n
        });
    } catch (e) { return hbErr(e); }
}

// Walk a property group, collecting animated / expressed / (optionally) all leaf props.
// NOTE: no `continue` inside try/catch in loops - ExtendScript can die silently on it.
function hbProp(group, i) {
    try { return group.property(i); } catch (e) { return null; }
}

function hbLeaf(p, path, out, opts) {
    var keep = opts.all;
    var info = { path: path, match: p.matchName };
    try {
        if (p.numKeys > 0) { keep = true; info.keys = p.numKeys; }
        if (p.canSetExpression && p.expression !== "") {
            keep = true;
            info.expr = p.expression.length > 400 ? p.expression.substr(0, 400) + "..." : p.expression;
            info.exprOn = p.expressionEnabled;
            if (p.expressionError) info.exprError = p.expressionError;
        }
        if (keep && p.propertyValueType !== PropertyValueType.NO_VALUE && p.propertyValueType !== PropertyValueType.CUSTOM_VALUE) {
            info.value = hbVal(p.value);
        }
    } catch (e) {}
    if (keep) out.push(info);
}

function hbWalk(group, pathPrefix, out, depth, opts) {
    if (depth > opts.maxDepth || out.length >= opts.maxProps) return;
    var i, p;
    for (i = 1; i <= group.numProperties; i++) {
        if (out.length >= opts.maxProps) return;
        p = hbProp(group, i);
        if (p) {
            if (p.propertyType === PropertyType.PROPERTY) hbLeaf(p, pathPrefix + "/" + p.name, out, opts);
            else if (p.numProperties > 0) hbWalk(p, pathPrefix + "/" + p.name, out, depth + 1, opts);
        }
    }
}

// Deep inspection of one layer: transform, effects, animated props, expressions (+errors).
function hbGetLayer(compRef, layerRef, allProps) {
    try {
        var c = hbComp(compRef), l = null, i;
        if (typeof layerRef === "number" || /^\d+$/.test(String(layerRef))) {
            if (Number(layerRef) < 1 || Number(layerRef) > c.numLayers) throw new Error("layer index " + layerRef + " out of range (comp has " + c.numLayers + " layers)");
            l = c.layer(Number(layerRef));
        } else l = c.layer(String(layerRef));
        if (!l) throw new Error("layer not found: " + layerRef);
        var tr = l.property("ADBE Transform Group"), t = {};
        var keys = ["ADBE Anchor Point", "ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"];
        var nm = ["anchor", "position", "scale", "rotation", "opacity"];
        for (i = 0; i < keys.length; i++) {
            try { t[nm[i]] = hbVal(tr.property(keys[i]).value); } catch (e) {}
        }
        var fx = [], eg = l.property("ADBE Effect Parade");
        if (eg) for (i = 1; i <= eg.numProperties; i++) fx.push({ i: i, name: eg.property(i).name, match: eg.property(i).matchName, on: eg.property(i).enabled });
        var props = [];
        hbWalk(l, "", props, 0, { maxDepth: 8, maxProps: allProps ? 250 : 120, all: !!allProps });
        return hbOk({
            i: l.index, name: l.name, type: hbLayerType(l), on: l.enabled, threeD: !!l.threeDLayer,
            parent: l.parent ? l.parent.index : 0, "in": hbRound(l.inPoint), out: hbRound(l.outPoint),
            startTime: hbRound(l.startTime), stretch: l.stretch, blend: l.blendingMode,
            transform: t, effects: fx, props: props
        });
    } catch (e) { return hbErr(e); }
}

// Every expression error in a comp (recurses into all layers; optionally precomps).
function hbExprErrors(compRef) {
    try {
        var c = hbComp(compRef), out = [], i, props;
        for (i = 1; i <= c.numLayers; i++) {
            props = [];
            hbWalk(c.layer(i), "", props, 0, { maxDepth: 10, maxProps: 400, all: false });
            for (var k = 0; k < props.length; k++) {
                if (props[k].exprError) out.push({ layer: i, name: c.layer(i).name, path: props[k].path, error: props[k].exprError, expr: props[k].expr });
            }
        }
        return hbOk({ comp: c.name, errors: out });
    } catch (e) { return hbErr(e); }
}

// Project tree: comps + footage + folders (capped).
function hbProject(maxItems) {
    try {
        var p = app.project, i, it, items = [], n = Math.min(p.numItems, maxItems || 200);
        for (i = 1; i <= n; i++) {
            it = p.item(i);
            var row = { id: it.id, name: it.name, parent: it.parentFolder && it.parentFolder !== p.rootFolder ? it.parentFolder.name : "" };
            if (it instanceof CompItem) {
                row.kind = "comp"; row.size = it.width + "x" + it.height; row.fps = hbRound(it.frameRate);
                row.duration = hbRound(it.duration); row.layers = it.numLayers;
            } else if (it instanceof FolderItem) row.kind = "folder";
            else if (it instanceof FootageItem) {
                row.kind = it.mainSource instanceof SolidSource ? "solid" : "footage";
                try { if (it.file) row.file = it.file.fsName; } catch (e) {}
                if (it.footageMissing) row.missing = true;
            } else row.kind = "item";
            items.push(row);
        }
        var act = p.activeItem;
        return hbOk({
            project: p.file ? p.file.fsName : "(unsaved)", dirty: p.dirty, numItems: p.numItems,
            active: act ? act.name : null, items: items, truncated: p.numItems > n
        });
    } catch (e) { return hbErr(e); }
}

// Run ExtendScript in one undo group. Returns {ok, result} or {ok:false, error, line}.
function hbEval(code, undoName) {
    var res, err = null;
    app.beginUndoGroup(undoName || "Hermes");
    try {
        res = eval(code);
    } catch (e) {
        err = e;
    }
    app.endUndoGroup();
    if (err) return hbJson({ ok: false, error: err.toString(), line: err.line || null });
    var out;
    if (res === undefined || res === null) out = null;
    else if (typeof res === "string" || typeof res === "number" || typeof res === "boolean") out = res;
    else { try { out = hbVal(res); } catch (e2) { out = String(res); } }
    return hbJson({ ok: true, result: out });
}

// Legacy entry used by the RUN IN AE button.
function hbRun(code) {
    var r = hbEval(code, "Hermes Bridge");
    return r;
}

// Render one frame to PNG (async on AE's side; caller polls for the file).
function hbSaveFrame(compRef, t, outPath, fullRes) {
    try {
        var c = hbComp(compRef);
        var time = (t === undefined || t === null || t === "") ? c.time : Number(t);
        var f = new File(outPath);
        if (f.exists) f.remove();
        var prev = c.resolutionFactor;
        if (fullRes) c.resolutionFactor = [1, 1];
        // restore the user's preview resolution even when the save throws
        try { c.saveFrameToPng(time, f); }
        finally { if (fullRes) c.resolutionFactor = prev; }
        return hbOk({ comp: c.name, time: hbRound(time), path: f.fsName, width: c.width, height: c.height, bg: hbVal(c.bgColor) });
    } catch (e) { return hbErr(e); }
}

// ---- Envato / media import ----------------------------------------------

// Folder of the saved project (null when unsaved) - import_media copies next to it.
function hbProjectDir() {
    try {
        var f = app.project ? app.project.file : null;
        return hbOk({ path: f ? f.fsName : null, dir: f ? f.parent.fsName : null });
    } catch (e) { return hbErr(e); }
}

// "Envato/Pack name" -> FolderItem chain under the project root (created when missing).
function hbFolderPath(pathStr) {
    var parts = String(pathStr || "Envato").split("/"), parent = app.project.rootFolder, i, j, f, found, nm;
    for (i = 0; i < parts.length; i++) {
        nm = parts[i];
        if (!nm) continue;
        found = null;
        for (j = 1; j <= parent.numItems; j++) {
            f = parent.item(j);
            if (f instanceof FolderItem && f.name === nm) { found = f; break; }
        }
        if (!found) {
            found = app.project.items.addFolder(nm);
            found.parentFolder = parent;
        }
        parent = found;
    }
    return parent;
}

// Comps inside an imported template project folder (what the user edits/renders).
function hbCompsIn(folder, out, depth) {
    var i, it;
    if (depth > 6 || out.length >= 25) return;
    for (i = 1; i <= folder.numItems; i++) {
        it = folder.item(i);
        if (it instanceof CompItem) out.push({ id: it.id, name: it.name, size: it.width + "x" + it.height, duration: hbRound(it.duration), layers: it.numLayers });
        else if (it instanceof FolderItem) hbCompsIn(it, out, depth + 1);
        if (out.length >= 25) return;
    }
}

function hbImportOne(entry, folder, known, res) {
    var p = entry[0], seq = entry[1], f = new File(p), it, io, row;
    try {
        if (!f.exists) { res.failed.push({ path: p, error: "file not found" }); return; }
        if (known[f.fsName]) { it = known[f.fsName]; res.reused.push({ id: it.id, name: it.name }); return; }
        io = new ImportOptions(f);
        if (/\.(aep|aet)$/i.test(p)) io.importAs = ImportAsType.PROJECT;
        else if (seq) { io.sequence = true; io.forceAlphabetical = true; }
        it = app.project.importFile(io);
        if (!it) { res.failed.push({ path: p, error: "importFile returned nothing" }); return; }
        try { it.parentFolder = folder; } catch (e1) {}
        row = { id: it.id, name: it.name };
        if (it instanceof FolderItem) {
            row.kind = "template";
            row.comps = [];
            hbCompsIn(it, row.comps, 0);
        } else if (it instanceof CompItem) row.kind = "comp";
        else {
            row.kind = seq ? "sequence" : "footage";
            try { if (it.duration) row.duration = hbRound(it.duration); } catch (e2) {}
            try { if (it.width) row.size = it.width + "x" + it.height; } catch (e3) {}
        }
        res.imported.push(row);
    } catch (e) {
        res.failed.push({ path: p, error: e.toString() });
    }
}

// list = [[path, isSequence], ...]. One undo group, dialogs suppressed
// (a template with missing fonts would otherwise block on a modal alert).
function hbImportFiles(list, binPath) {
    var res = { imported: [], reused: [], failed: [] }, i, it, known = {}, folder;
    try {
        if (!app.project) throw new Error("no project open");
        for (i = 1; i <= app.project.numItems; i++) {
            it = app.project.item(i);
            try { if (it instanceof FootageItem && it.file) known[it.file.fsName] = it; } catch (e0) {}
        }
        app.beginUndoGroup("Hermes: Import " + (binPath || "Envato"));
        try { app.beginSuppressDialogs(); } catch (e1) {}
        try {
            folder = hbFolderPath(binPath || "Envato");
            for (i = 0; i < list.length; i++) hbImportOne(list[i], folder, known, res);
        } finally {
            try { app.endSuppressDialogs(false); } catch (e2) {}
            app.endUndoGroup();
        }
        res.folder = binPath || "Envato";
        res.folderId = folder.id;
        return hbOk(res);
    } catch (e) { return hbErr(e); }
}
