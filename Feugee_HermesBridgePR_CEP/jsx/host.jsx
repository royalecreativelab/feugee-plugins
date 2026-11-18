// host.jsx - Hermes Bridge PR v1 (Premiere Pro ExtendScript, ES3).
// ASCII only. No JSON object in this engine - serialize by hand.
// Every hbX() returns a JSON string {ok:true,data} / {ok:false,error}.
// Premiere has no undo groups: every DOM change is its own undo step.

var HB_TICKS = 254016000000;

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
    try { if (v.seconds !== undefined && v.ticks !== undefined) return hbRound(v.seconds); } catch (e) {}
    return String(v);
}

function hbOk(data) { return hbJson({ ok: true, data: data }); }
function hbErr(e) {
    return hbJson({ ok: false, error: (e && e.toString ? e.toString() : String(e)) + (e && e.line ? " (line " + e.line + ")" : "") });
}

function hbSec(t) {
    try { return hbRound(t.seconds); } catch (e) { return null; }
}

function hbFps(seq) {
    var tb = Number(seq.timebase);
    if (!tb) return null;
    return hbRound(HB_TICKS / tb);
}

function hbSeqEnd(seq) {
    try { return hbRound(Number(seq.end) / HB_TICKS); } catch (e) { return null; }
}

function hbInOut(seq) {
    var r = { "in": null, out: null };
    try { r["in"] = hbSec(seq.getInPointAsTime()); r.out = hbSec(seq.getOutPointAsTime()); return r; } catch (e) {}
    try { r["in"] = hbRound(Number(seq.getInPoint())); r.out = hbRound(Number(seq.getOutPoint())); } catch (e2) {}
    return r;
}

function hbProjectOpen() {
    if (!app.project || !app.project.path) throw new Error("no Premiere project open");
    return app.project;
}

// Sequence by name / sequenceID / index; empty = active sequence.
function hbSeq(ref) {
    var p = hbProjectOpen(), i, s;
    if (ref === undefined || ref === null || ref === "") {
        s = p.activeSequence;
        if (s) return s;
        throw new Error("no active sequence - open a sequence in the timeline");
    }
    for (i = 0; i < p.sequences.numSequences; i++) {
        s = p.sequences[i];
        if (s.name === String(ref) || String(s.sequenceID) === String(ref)) return s;
    }
    throw new Error("sequence not found: " + ref);
}

// "V1" -> videoTracks[0], "A3" -> audioTracks[2]
function hbTrack(seq, ref) {
    var m = String(ref).match(/^([VvAa])\s*(\d+)$/);
    if (!m) throw new Error("track must look like V1 or A2, got: " + ref);
    var coll = (m[1].toUpperCase() === "V") ? seq.videoTracks : seq.audioTracks;
    var idx = Number(m[2]) - 1;
    if (idx < 0 || idx >= coll.numTracks) throw new Error("track " + ref + " does not exist (" + coll.numTracks + " " + (m[1].toUpperCase() === "V" ? "video" : "audio") + " tracks)");
    return coll[idx];
}

function hbMediaPath(pi) {
    try { if (pi) return pi.getMediaPath() || ""; } catch (e) {}
    return "";
}

function hbClipRow(clip, i, label) {
    var row = { track: label, i: i, name: clip.name, start: hbSec(clip.start), end: hbSec(clip.end),
        "in": hbSec(clip.inPoint), out: hbSec(clip.outPoint) };
    try { if (clip.disabled) row.off = true; } catch (e) {}
    try { if (clip.isSelected()) row.sel = true; } catch (e2) {}
    try { var sp = clip.getSpeed(); if (sp !== 1) row.speed = hbRound(sp); } catch (e3) {}
    try { if (clip.isMGT()) row.mogrt = true; } catch (e4) {}
    try { if (clip.isAdjustmentLayer()) row.adjustment = true; } catch (e5) {}
    try {
        if (clip.projectItem) {
            if (clip.projectItem.isSequence && clip.projectItem.isSequence()) row.nest = true;
            var mp = hbMediaPath(clip.projectItem);
            if (mp) row.media = mp;
            if (clip.projectItem.isOffline && clip.projectItem.isOffline()) row.offline = true;
        }
    } catch (e6) {}
    return row;
}

function hbTrackRow(t, label) {
    var r = { track: label, name: t.name, clips: t.clips.numItems };
    try { if (t.isMuted()) r.muted = true; } catch (e) {}
    try { if (t.isLocked()) r.locked = true; } catch (e2) {}
    try { if (t.transitions && t.transitions.numItems) r.transitions = t.transitions.numItems; } catch (e3) {}
    return r;
}

function hbSeqInfo(seq) {
    var io = hbInOut(seq);
    return {
        id: String(seq.sequenceID), name: seq.name,
        width: seq.frameSizeHorizontal, height: seq.frameSizeVertical,
        fps: hbFps(seq), duration: hbSeqEnd(seq),
        playhead: hbSec(seq.getPlayerPosition()),
        "in": io["in"], out: io.out,
        videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks,
        markers: seq.markers.numMarkers
    };
}

function hbSelection(seq, cap) {
    var out = [], sel, i, j, k, c, coll, kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]];
    try { sel = seq.getSelection(); } catch (e) { return out; }
    if (!sel || !sel.length) return out;
    // map selected items back to track + index (getSelection gives no track)
    for (k = 0; k < kinds.length; k++) {
        coll = kinds[k][1];
        for (i = 0; i < coll.numTracks; i++) {
            for (j = 0; j < coll[i].clips.numItems; j++) {
                c = coll[i].clips[j];
                if (out.length < cap && hbIsSel(c)) out.push(hbClipRow(c, j, kinds[k][0] + (i + 1)));
            }
        }
    }
    return out;
}

function hbIsSel(c) {
    try { return c.isSelected(); } catch (e) { return false; }
}

// ---- panel UI helpers --------------------------------------------------

function hbSeqMeta() {
    try {
        if (!app.project || !app.project.path) return "No project open";
        var s = app.project.activeSequence;
        if (!s) return "No sequence open";
        var n = 0;
        try { n = s.getSelection().length; } catch (e) {}
        return s.name + "  " + s.frameSizeHorizontal + "x" + s.frameSizeVertical + " @" + hbFps(s) +
               "  |  V" + s.videoTracks.numTracks + " A" + s.audioTracks.numTracks + "  |  " + n + " selected";
    } catch (e2) { return "No sequence open"; }
}

function hbPing() { return "PONG " + app.version; }

function hbProjectPath() {
    try { return hbOk({ path: app.project ? String(app.project.path || "") : "" }); } catch (e) { return hbErr(e); }
}

// First clip on a track that covers time ph (seconds), or null.
// Loops live in helpers without try/continue/break: ExtendScript can die
// silently on those inside try blocks.
function hbClipAt(t, ph) {
    var j, c;
    for (j = 0; j < t.clips.numItems; j++) {
        c = t.clips[j];
        if (c.start.seconds <= ph && c.end.seconds > ph) return j;
    }
    return -1;
}

// Compact context sent with every prompt: sequence, playhead clips, selection.
function hbContext(maxSel) {
    try {
        var seq = hbSeq(null), info = hbSeqInfo(seq), ph = info.playhead, tracks = [], under = [];
        var kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]], k, i, j, t;
        for (k = 0; k < kinds.length; k++) {
            for (i = 0; i < kinds[k][1].numTracks; i++) {
                t = kinds[k][1][i];
                tracks.push(hbTrackRow(t, kinds[k][0] + (i + 1)));
                j = hbClipAt(t, ph);
                if (j >= 0) under.push(hbClipRow(t.clips[j], j, kinds[k][0] + (i + 1)));
            }
        }
        return hbOk({ project: app.project.path, sequence: info, tracks: tracks, underPlayhead: under, selected: hbSelection(seq, maxSel || 20) });
    } catch (e) { return hbErr(e); }
}

// ---- MCP tools ----------------------------------------------------------

function hbGetSequence(seqRef, maxClips, trackRef) {
    try {
        var seq = hbSeq(seqRef), cap = maxClips || 80, clips = [], tracks = [], listed = 0, total = 0;
        var kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]], k, i, j, t, label;
        for (k = 0; k < kinds.length; k++) {
            for (i = 0; i < kinds[k][1].numTracks; i++) {
                t = kinds[k][1][i];
                label = kinds[k][0] + (i + 1);
                tracks.push(hbTrackRow(t, label));
                if (!trackRef || String(trackRef).toUpperCase() === label) {
                    total += t.clips.numItems;
                    for (j = 0; j < t.clips.numItems && listed < cap; j++) {
                        clips.push(hbClipRow(t.clips[j], j, label));
                        listed++;
                    }
                }
            }
        }
        return hbOk({ project: app.project.path, sequence: hbSeqInfo(seq), tracks: tracks, clips: clips,
            clipsListed: listed, clipsTotal: total, truncated: total > listed });
    } catch (e) { return hbErr(e); }
}

function hbParamRow(p) {
    var r = { name: p.displayName };
    try { r.value = hbVal(p.getValue()); } catch (e) { r.value = "(unreadable)"; }
    try {
        if (p.isTimeVarying()) {
            var keys = p.getKeys();
            r.keys = keys ? keys.length : 0;
        }
    } catch (e2) {}
    return r;
}

// Built-in components every clip has. Unless all_props, only their keyframed
// params are listed (Motion is always listed: it is what reframes touch).
var HB_INTRINSIC = { "Opacity": 1, "Time Remapping": 1, "Volume": 1, "Channel Volume": 1, "Panner": 1 };

function hbComponents(coll, allProps, out) {
    var i, j, comp, row, p, quiet;
    for (i = 0; i < coll.numItems; i++) {
        comp = coll[i];
        quiet = !allProps && HB_INTRINSIC[comp.displayName] === 1;
        row = { name: comp.displayName, match: comp.matchName, props: [] };
        for (j = 0; j < comp.properties.numItems; j++) {
            p = hbParamRow(comp.properties[j]);
            if (!quiet || p.keys) row.props.push(p);
        }
        if (quiet && !row.props.length) row.props = "(static - pass all_props)";
        out.push(row);
    }
}

function hbClipByName(t, name) {
    var i;
    for (i = 0; i < t.clips.numItems; i++) if (t.clips[i].name === name) return i;
    return -1;
}

function hbGetClip(seqRef, trackRef, index, name, allProps) {
    try {
        var seq = hbSeq(seqRef), t = hbTrack(seq, trackRef), clip = null, i, idx = -1;
        if (index !== null && index !== undefined && index !== "") {
            idx = Number(index);
            if (idx < 0 || idx >= t.clips.numItems) throw new Error("clip index " + idx + " out of range on " + trackRef + " (0.." + (t.clips.numItems - 1) + ")");
        } else if (name) {
            idx = hbClipByName(t, String(name));
            if (idx < 0) throw new Error("no clip named " + name + " on " + trackRef);
        } else throw new Error("pass index (0-based) or name");
        clip = t.clips[idx];
        var row = hbClipRow(clip, idx, String(trackRef).toUpperCase()), comps = [];
        hbComponents(clip.components, !!allProps, comps);
        row.components = comps;
        try {
            if (clip.isMGT()) {
                var mg = clip.getMGTComponent(), params = [];
                for (i = 0; i < mg.properties.numItems; i++) params.push(hbParamRow(mg.properties[i]));
                row.mogrtParams = params;
            }
        } catch (e) {}
        try {
            var linked = clip.getLinkedItems(), names = [];
            for (i = 0; linked && i < linked.numItems; i++) names.push(linked[i].name);
            if (names.length) row.linked = names;
        } catch (e2) {}
        return hbOk(row);
    } catch (e3) { return hbErr(e3); }
}

function hbItemType(it) {
    try { if (it.type === ProjectItemType.BIN) return "bin"; } catch (e) {}
    try { if (it.isSequence()) return "sequence"; } catch (e2) {}
    try { if (it.type === ProjectItemType.FILE) return "file"; } catch (e3) {}
    return "clip";
}

function hbWalkBin(bin, pathStr, out, state) {
    var i, it, row;
    for (i = 0; i < bin.children.numItems; i++) {
        if (out.length >= state.cap) { state.truncated = true; return; }
        it = bin.children[i];
        row = { name: it.name, type: hbItemType(it), bin: pathStr };
        if (row.type === "bin") {
            out.push(row);
            hbWalkBin(it, pathStr + "/" + it.name, out, state);
        } else {
            var mp = hbMediaPath(it);
            if (mp) row.media = mp;
            try { if (it.isOffline()) { row.offline = true; state.offline++; } } catch (e) {}
            out.push(row);
        }
    }
}

function hbProject(maxItems) {
    try {
        var p = hbProjectOpen(), seqs = [], i, s, items = [], st = { cap: maxItems || 200, truncated: false, offline: 0 };
        for (i = 0; i < p.sequences.numSequences; i++) {
            s = p.sequences[i];
            seqs.push({ id: String(s.sequenceID), name: s.name, width: s.frameSizeHorizontal, height: s.frameSizeVertical,
                fps: hbFps(s), duration: hbSeqEnd(s) });
        }
        hbWalkBin(p.rootItem, "", items, st);
        return hbOk({ path: p.path, name: p.name, active: p.activeSequence ? p.activeSequence.name : null,
            sequences: seqs, items: items, offline: st.offline, truncated: st.truncated });
    } catch (e) { return hbErr(e); }
}

function hbMarkers(seqRef, maxN, offset) {
    try {
        var seq = hbSeq(seqRef), m = seq.markers.getFirstMarker(), out = [], n = 0, cap = maxN || 150, skip = offset || 0, row;
        while (m) {
            if (n >= skip && out.length < cap) {
                row = { n: n, start: hbSec(m.start), name: m.name };
                var e = hbSec(m.end);
                if (e !== null && e > row.start) row.end = e;
                if (m.comments) row.comments = m.comments;
                try { if (m.type && m.type !== "Comment") row.type = m.type; } catch (e1) {}
                try { row.color = m.getColorByIndex(); } catch (e2) {}
                out.push(row);
            }
            n++;
            m = seq.markers.getNextMarker(m);
        }
        return hbOk({ sequence: seq.name, fps: hbFps(seq), total: n, offset: skip, markers: out, truncated: n > skip + out.length });
    } catch (e3) { return hbErr(e3); }
}

// Models often write a top-level `return`. That is a SyntaxError, raised
// before anything runs, so retrying inside a function cannot double-apply.
function hbEval(code) {
    var res, err = null;
    try {
        hbProjectOpen();
        res = eval(code);
    } catch (e) {
        err = e;
    }
    if (err && err.name === "SyntaxError" && /return/i.test(String(err.message))) {
        err = null;
        try { res = eval("(function(){\n" + code + "\n})()"); } catch (e1) { err = e1; }
    }
    if (err) return hbJson({ ok: false, error: err.toString(), line: err.line || null });
    var out;
    if (res === undefined || res === null) out = null;
    else if (typeof res === "string" || typeof res === "number" || typeof res === "boolean") out = res;
    else { try { out = hbVal(res); } catch (e2) { out = String(res); } }
    return hbJson({ ok: true, result: out });
}

// Empty stretches per track: before the first clip, between clips and
// (tail=true) after the last clip up to the sequence end. Read-only.
function hbTrackGaps(t, label, fps, minSec, endSec, tail, out) {
    var j, c, s, e, cursor = 0, n = t.clips.numItems;
    for (j = 0; j < n; j++) {
        c = t.clips[j];
        s = c.start.seconds;
        e = c.end.seconds;
        if (s - cursor >= minSec) out.push({ track: label, start: hbRound(cursor), end: hbRound(s), sec: hbRound(s - cursor), frames: Math.round((s - cursor) * fps), after: j > 0 ? t.clips[j - 1].name : null });
        if (e > cursor) cursor = e;
    }
    if (tail && n && endSec - cursor >= minSec) out.push({ track: label, start: hbRound(cursor), end: hbRound(endSec), sec: hbRound(endSec - cursor), frames: Math.round((endSec - cursor) * fps), after: t.clips[n - 1].name, tail: true });
}

function hbGaps(seqRef, minFrames, trackRef, tail) {
    try {
        var seq = hbSeq(seqRef), fps = hbFps(seq) || 25, minSec = (minFrames || 1) / fps, endSec = hbSeqEnd(seq), out = [], empty = [];
        var kinds = [["V", seq.videoTracks], ["A", seq.audioTracks]], k, i, t, label;
        for (k = 0; k < kinds.length; k++) {
            for (i = 0; i < kinds[k][1].numTracks; i++) {
                t = kinds[k][1][i];
                label = kinds[k][0] + (i + 1);
                if (!trackRef || String(trackRef).toUpperCase() === label) {
                    if (t.clips.numItems) hbTrackGaps(t, label, fps, minSec, endSec, !!tail, out);
                    else empty.push(label);
                }
            }
        }
        return hbOk({ sequence: seq.name, fps: fps, duration: endSec, gaps: out, emptyTracks: empty });
    } catch (e) { return hbErr(e); }
}

// Export one frame through the QE DOM. Premiere appends ".png" to basePath.
// Only the active sequence can be exported; another one is opened first.
function hbExportFrame(seqRef, t, basePath) {
    try {
        var seq = hbSeq(seqRef), switched = false;
        var act = app.project.activeSequence;
        if (!act || String(act.sequenceID) !== String(seq.sequenceID)) { app.project.activeSequence = seq; switched = true; }
        app.enableQE();
        var qs = qe.project.getActiveSequence();
        if (!qs) throw new Error("QE could not see the active sequence");
        var old = seq.getPlayerPosition().ticks, moved = false;
        if (t !== null && t !== undefined && t !== "") {
            var tt = new Time();
            tt.seconds = Number(t);
            seq.setPlayerPosition(tt.ticks);
            moved = true;
        }
        var tc = qs.CTI.timecode, sec = hbSec(seq.getPlayerPosition());
        qs.exportFramePNG(tc, basePath);
        if (moved) seq.setPlayerPosition(old);
        return hbOk({ timecode: tc, time: sec, width: seq.frameSizeHorizontal, height: seq.frameSizeVertical,
            sequence: seq.name, switchedSequence: switched });
    } catch (e) { return hbErr(e); }
}

// ---- Envato / media import ----------------------------------------------

// Folder of the saved project (null when unsaved) - import_media copies next to it.
function hbProjectDir() {
    try {
        var p = app.project ? String(app.project.path || "") : "";
        if (!p) return hbOk({ path: null, dir: null });
        var f = new File(p);
        return hbOk({ path: f.fsName, dir: f.parent ? f.parent.fsName : null });
    } catch (e) { return hbErr(e); }
}

function hbChildBin(parent, name) {
    var i, c, kids = parent.children;
    for (i = 0; i < kids.numItems; i++) {
        c = kids[i];
        if (c && c.type === ProjectItemType.BIN && c.name === name) return c;
    }
    return null;
}

// "Envato/Pack name" -> bin chain under the root (created when missing).
function hbBinPath(pathStr) {
    var parts = String(pathStr || "Envato").split("/"), bin = app.project.rootItem, i, nm, next;
    for (i = 0; i < parts.length; i++) {
        nm = parts[i];
        if (!nm) continue;
        next = hbChildBin(bin, nm);
        if (!next) next = bin.createBin(nm);
        if (!next) throw new Error("could not create bin " + nm);
        bin = next;
    }
    return bin;
}

function hbIndexMedia(bin, known, depth) {
    var i, c, mp, kids = bin.children;
    if (depth > 12) return;
    for (i = 0; i < kids.numItems; i++) {
        c = kids[i];
        if (!c) continue;
        if (c.type === ProjectItemType.BIN) hbIndexMedia(c, known, depth + 1);
        else {
            mp = "";
            try { mp = c.getMediaPath(); } catch (e) {}
            if (mp) known[String(mp).toLowerCase()] = c;
        }
    }
}

function hbBinIds(bin) {
    var ids = {}, i, kids = bin.children;
    for (i = 0; i < kids.numItems; i++) if (kids[i]) ids[kids[i].nodeId] = true;
    return ids;
}

// list = [[path, isSequence], ...]. Plain files go in one importFiles call,
// each numbered-stills sequence in its own (the flag is per call).
function hbImportFiles(list, binPath) {
    var res = { imported: [], reused: [], failed: [] }, known = {}, plain = [], seqs = [], i, p, f, bin, before, kids, c, mp;
    try {
        hbProjectOpen();
        hbIndexMedia(app.project.rootItem, known, 0);
        for (i = 0; i < list.length; i++) {
            p = list[i][0];
            f = new File(p);
            if (!f.exists) { res.failed.push({ path: p, error: "file not found" }); }
            else if (known[String(f.fsName).toLowerCase()]) {
                c = known[String(f.fsName).toLowerCase()];
                res.reused.push({ name: c.name, nodeId: c.nodeId, path: f.fsName });
            } else if (list[i][1]) seqs.push(f.fsName);
            else plain.push(f.fsName);
        }
        bin = hbBinPath(binPath || "Envato");
        before = hbBinIds(bin);
        if (plain.length && !app.project.importFiles(plain, true, bin, false)) res.failed.push({ path: plain.length + " file", error: "importFiles returned false" });
        for (i = 0; i < seqs.length; i++) {
            if (!app.project.importFiles([seqs[i]], true, bin, true)) res.failed.push({ path: seqs[i], error: "sequence import returned false" });
        }
        kids = bin.children;
        for (i = 0; i < kids.numItems; i++) {
            c = kids[i];
            if (!c || before[c.nodeId]) continue;
            mp = "";
            try { mp = c.getMediaPath(); } catch (e2) {}
            res.imported.push({ name: c.name, nodeId: c.nodeId, path: mp });
        }
        res.bin = binPath || "Envato";
        return hbOk(res);
    } catch (e) { return hbErr(e); }
}
