/**
 * FEUGEE STUDIO - SIDEQUEST  |  HOST SCRIPT (ExtendScript)
 * Version: 1.0.0 (CEP)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * This file has NO UI. The UI lives in index.html (CEP panel).
 * The panel calls the fg*() entry points through evalScript() and receives
 * a string of the form "OK|message" or "ERR|message".
 *
 * Built from the Knowledge Nuke reference implementation. The helper block
 * marked "SHARED HELPERS" and modules 03 / 04 are carried over unchanged so
 * they stay diffable against that plugin; modules 01 / 02 are new.
 */

/* ---------------------------------------------------------------------------
   NAMESPACE - do not remove.

   Every CEP extension loaded in one After Effects instance shares ONE global
   ExtendScript scope. Two plugins declaring `fgWrap` overwrite each other and
   the panel that loaded first silently calls the other plugin's function.
   That is exactly what happened between Knowledge Nuke and Feugelign.

   So the whole host lives inside this IIFE and exposes a single global object.
   --------------------------------------------------------------------------- */

var FG_SQ = (function () {

// Stand-in for the old ScriptUI statictext: core functions still write to .text.
var FG_STATUS = { text: "" };

// ==========================================
// GUARD - runs before the core, so a bad selection never opens a modal alert
// ==========================================
function fgGuard(needLayers) {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return "ERR|Open or activate a Composition first";
    if (needLayers) {
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) return "ERR|Select at least 1 layer in the timeline";
    }
    return null;
}

function fgWrap(fn) {
    var bad = fgGuard(true);
    if (bad) return bad;
    FG_STATUS.text = "";
    try {
        fn();
    } catch (e) {
        return "ERR|" + e.toString();
    }
    if (!FG_STATUS.text) return "OK|Done";
    return "OK|" + String(FG_STATUS.text).replace(/^[\s]+/, "");
}

// ==========================================================
// SHARED HELPERS - carried over from Knowledge Nuke, unchanged
// ==========================================================
function getActiveComp() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) {
        alert("Please open or activate a Composition first.");
        return null;
    }
    return comp;
}

function getSelectedLayers(comp) {
    if (!comp) return [];
    var layers = comp.selectedLayers;
    if (!layers || layers.length === 0) {
        alert("Please select at least 1 layer in the timeline.");
        return [];
    }
    return layers;
}

// Bulletproof Temporal Ease applicator (handles Spatial 1-scalar and multi-dim)
function applyTemporalEaseSafe(prop, keyIndex, inEase, outEase) {
    try {
        prop.setTemporalEaseAtKey(keyIndex, [inEase], [outEase]);
        return;
    } catch(e1) {}
    try {
        prop.setTemporalEaseAtKey(keyIndex, [inEase, inEase], [outEase, outEase]);
        return;
    } catch(e2) {}
    try {
        prop.setTemporalEaseAtKey(keyIndex, [inEase, inEase, inEase], [outEase, outEase, outEase]);
        return;
    } catch(e3) {}
}

// Bulletproof Spatial Tangents applicator (auto adapts to 2D or 3D)
function applySpatialTangentsSafe(prop, keyIndex, inTan, outTan) {
    var targetDims = 2;
    try {
        var val = prop.keyValue(keyIndex);
        if (val instanceof Array) targetDims = val.length;
    } catch(eVal) {
        try {
            if (prop.value instanceof Array) targetDims = prop.value.length;
        } catch(eVal2) {}
    }

    function formatTan(t, dims) {
        var x = (t && t.length > 0) ? t[0] : 0;
        var y = (t && t.length > 1) ? t[1] : 0;
        var z = (t && t.length > 2) ? t[2] : 0;
        if (dims === 3) return [x, y, z];
        return [x, y];
    }

    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, targetDims), formatTan(outTan, targetDims));
        return;
    } catch(e1) {}
    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, 3), formatTan(outTan, 3));
        return;
    } catch(e2) {}
    try {
        prop.setSpatialTangentsAtKey(keyIndex, formatTan(inTan, 2), formatTan(outTan, 2));
        return;
    } catch(e3) {}
}

// ==========================================================
// LAYER SPACE - lifted verbatim from Feugelign's host.jsx
//
// After Effects' ExtendScript DOM has NO toComp() / fromComp(): those are
// EXPRESSION functions, not scripting API. A layer's transform matrix has to
// be composed by hand and walked up the parent chain. Feugelign already
// solved this, so its block is carried over unchanged rather than rewritten.
// ==========================================================
function m4id() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

function m4mul(a, b) {
    var o = [];
    for (var r = 0; r < 4; r++) {
        for (var c = 0; c < 4; c++) {
            o[r * 4 + c] = a[r * 4]     * b[c]
                         + a[r * 4 + 1] * b[4 + c]
                         + a[r * 4 + 2] * b[8 + c]
                         + a[r * 4 + 3] * b[12 + c];
        }
    }
    return o;
}

function m4T(x, y, z) { return [1,0,0,x, 0,1,0,y, 0,0,1,z, 0,0,0,1]; }
function m4S(x, y, z) { return [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1]; }

function m4RX(d) { var a = d * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
    return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1]; }
function m4RY(d) { var a = d * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
    return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]; }
function m4RZ(d) { var a = d * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
    return [c,-s,0,0, s,c,0,0, 0,0,1,0, 0,0,0,1]; }

/* transform titik (w = 1) */
function m4pt(m, p) {
    return [ m[0]*p[0] + m[1]*p[1] + m[2]*p[2]  + m[3],
             m[4]*p[0] + m[5]*p[1] + m[6]*p[2]  + m[7],
             m[8]*p[0] + m[9]*p[1] + m[10]*p[2] + m[11] ];
}

/* transform arah (w = 0) - translasi diabaikan */
function m4vec(m, p) {
    return [ m[0]*p[0] + m[1]*p[1] + m[2]*p[2],
             m[4]*p[0] + m[5]*p[1] + m[6]*p[2],
             m[8]*p[0] + m[9]*p[1] + m[10]*p[2] ];
}

/* invers affine: bagian 3x3 dibalik, translasi ikut dibalik */
function m4inv(m) {
    var a = m[0],  b = m[1],  c = m[2],
        d = m[4],  e = m[5],  f = m[6],
        g = m[8],  h = m[9],  i = m[10];

    var det = a * (e*i - f*h) - b * (d*i - f*g) + c * (d*h - e*g);
    if (Math.abs(det) < 1e-12) det = (det < 0 ? -1e-12 : 1e-12);
    var q = 1 / det;

    var r0 =  (e*i - f*h) * q, r1 = -(b*i - c*h) * q, r2 =  (b*f - c*e) * q;
    var r3 = -(d*i - f*g) * q, r4 =  (a*i - c*g) * q, r5 = -(a*f - c*d) * q;
    var r6 =  (d*h - e*g) * q, r7 = -(a*h - b*g) * q, r8 =  (a*e - b*d) * q;

    var tx = m[3], ty = m[7], tz = m[11];
    return [ r0, r1, r2, -(r0*tx + r1*ty + r2*tz),
             r3, r4, r5, -(r3*tx + r4*ty + r5*tz),
             r6, r7, r8, -(r6*tx + r7*ty + r8*tz),
             0, 0, 0, 1 ];
}

function v3sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function v3cross(a, b) {
    return [ a[1]*b[2] - a[2]*b[1],
             a[2]*b[0] - a[0]*b[2],
             a[0]*b[1] - a[1]*b[0] ];
}
function v3norm(a) {
    var l = Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]);
    if (l < 1e-9) return [0, 0, 1];
    return [a[0]/l, a[1]/l, a[2]/l];
}

// ==========================================================
// BACA PROPERTI TRANSFORM
// ==========================================================
function fgTG(layer) { return layer.property("ADBE Transform Group"); }

function fgCamOrLight(layer) {
    return (layer instanceof CameraLayer) || (layer instanceof LightLayer);
}

/* normalise every value to [x, y, z] */
function fgVec3(v, padZ) {
    var z = (padZ === undefined) ? 0 : padZ;
    if (v === null || v === undefined) return [0, 0, z];
    if (typeof v === "number") return [v, 0, z];
    return [ v[0],
             (v.length > 1) ? v[1] : 0,
             (v.length > 2) ? v[2] : z ];
}

/* Position can be split per dimension (Separate Dimensions). When it is,
   the parent's "ADBE Position" property must not be read directly. */
function fgPosSeparated(layer) {
    try {
        var p = fgTG(layer).property("ADBE Position");
        return p && p.dimensionsSeparated === true;
    } catch (e) { return false; }
}

function fgReadPos(layer, t) {
    var tg = fgTG(layer);
    if (fgPosSeparated(layer)) {
        var x = tg.property("ADBE Position_0").valueAtTime(t, false);
        var y = tg.property("ADBE Position_1").valueAtTime(t, false);
        var z = 0;
        if (layer.threeDLayer) {
            var zp = tg.property("ADBE Position_2");
            if (zp) z = zp.valueAtTime(t, false);
        }
        return [x, y, z];
    }
    return fgVec3(tg.property("ADBE Position").valueAtTime(t, false), 0);
}

/* If the property is keyframed, AE rejects setValue, so write at the CTI.
   Otherwise a plain setValue is fine. */
function fgSetVal(prop, t, val) {
    if (prop.numKeys > 0) prop.setValueAtTime(t, val);
    else prop.setValue(val);
}

function fgWritePos(layer, t, v) {
    var tg = fgTG(layer);
    if (fgPosSeparated(layer)) {
        fgSetVal(tg.property("ADBE Position_0"), t, v[0]);
        fgSetVal(tg.property("ADBE Position_1"), t, v[1]);
        if (layer.threeDLayer) {
            var zp = tg.property("ADBE Position_2");
            if (zp) fgSetVal(zp, t, v[2]);
        }
        return;
    }
    fgSetVal(tg.property("ADBE Position"), t,
             layer.threeDLayer ? [v[0], v[1], v[2]] : [v[0], v[1]]);
}

function fgScaleBy(layer, t, k) {
    var p = fgTG(layer).property("ADBE Scale");
    var v = p.valueAtTime(t, false);
    var nv = [];
    for (var i = 0; i < v.length; i++) nv[i] = v[i] * k;
    fgSetVal(p, t, nv);
}

/* posisi terkunci ekspresi -> perubahan kita bakal ditimpa saat render */
function fgPosLocked(layer) {
    try {
        var p = fgTG(layer).property("ADBE Position");
        if (fgPosSeparated(layer)) {
            var a = fgTG(layer).property("ADBE Position_0");
            var b = fgTG(layer).property("ADBE Position_1");
            return (a && a.expressionEnabled) || (b && b.expressionEnabled);
        }
        return p && p.expressionEnabled === true;
    } catch (e) { return false; }
}

// ==========================================================
// MATRIX LAYER
// After Effects composes the transform in this order:
//   T(position) . Rz . Ry . Rx . Orientation . S(scale) . T(-anchorPoint)
// Orientation itself is composed Rz.Ry.Rx to stay consistent with rotation.
// ==========================================================
function fgLocalMatrix(layer, t) {
    var tg = fgTG(layer);
    var is3 = (layer.threeDLayer === true) || fgCamOrLight(layer);
    var M;

    if (fgCamOrLight(layer)) {
        var cpos = fgVec3(tg.property("ADBE Position").valueAtTime(t, false), 0);
        M = m4T(cpos[0], cpos[1], cpos[2]);

        if (layer.autoOrient === AutoOrientType.CAMERA_OR_POINT_OF_INTEREST) {
            var poi = fgVec3(tg.property("ADBE Anchor Point").valueAtTime(t, false), 0);
            M = m4mul(M, fgLookAt(cpos, poi));
        }
        M = m4mul(M, fgRotMatrix(tg, true, t));
        return M;
    }

    var ap  = fgVec3(tg.property("ADBE Anchor Point").valueAtTime(t, false), 0);
    var pos = fgReadPos(layer, t);
    var sc  = fgVec3(tg.property("ADBE Scale").valueAtTime(t, false), 100);

    M = m4T(pos[0], pos[1], pos[2]);
    M = m4mul(M, fgRotMatrix(tg, is3, t));
    M = m4mul(M, m4S(sc[0] / 100, sc[1] / 100, (is3 ? sc[2] : 100) / 100));
    M = m4mul(M, m4T(-ap[0], -ap[1], -ap[2]));
    return M;
}

function fgRotMatrix(tg, is3, t) {
    if (!is3) {
        return m4RZ(tg.property("ADBE Rotate Z").valueAtTime(t, false));
    }
    var rz = tg.property("ADBE Rotate Z").valueAtTime(t, false);
    var ry = tg.property("ADBE Rotate Y").valueAtTime(t, false);
    var rx = tg.property("ADBE Rotate X").valueAtTime(t, false);

    var R = m4mul(m4mul(m4RZ(rz), m4RY(ry)), m4RX(rx));

    var op = tg.property("ADBE Orientation");
    if (op) {
        var o = fgVec3(op.valueAtTime(t, false), 0);
        R = m4mul(R, m4mul(m4mul(m4RZ(o[2]), m4RY(o[1])), m4RX(o[0])));
    }
    return R;
}

/* camera basis: +Z faces the target, +Y down the screen, +X right */
function fgLookAt(from, to) {
    var f = v3norm(v3sub(to, from));
    var down = [0, 1, 0];
    if (Math.abs(f[0]) < 1e-6 && Math.abs(f[2]) < 1e-6) down = [0, 0, 1];
    var r = v3norm(v3cross(down, f));
    var u = v3cross(f, r);
    return [ r[0], u[0], f[0], 0,
             r[1], u[1], f[1], 0,
             r[2], u[2], f[2], 0,
             0,    0,    0,    1 ];
}

function fgWorldMatrix(layer, t) {
    var M = fgLocalMatrix(layer, t);
    var p = layer.parent, guard = 0;
    while (p && guard++ < 64) {
        M = m4mul(fgLocalMatrix(p, t), M);
        p = p.parent;
    }
    return M;
}

function fgParentWorld(layer, t) {
    if (!layer.parent) return m4id();
    return fgWorldMatrix(layer.parent, t);
}

/* Camera space. With no camera, After Effects uses a default view equal to a
   50mm lens on 36mm film -> distance = comp width * 50/36. */
function fgViewPair(comp, t) {
    var cam = comp.activeCamera;
    var CW;
    if (cam) {
        CW = fgWorldMatrix(cam, t);
    } else {
        CW = m4T(comp.width / 2, comp.height / 2, -(comp.width * 50 / 36));
    }
    return { Wm: m4inv(CW), Winv: CW, hasCam: (cam ? true : false) };
}

// ==========================================================
// BOUNDING BOX
// ==========================================================
function fgExtrusion(layer, t) {
    if (!layer.threeDLayer) return 0;
    try {
        var g = layer.property("ADBE Extrsn Options");
        if (!g) return 0;
        var p = g.property("ADBE Extrsn Depth");
        if (!p) return 0;
        var d = p.valueAtTime(t, false);
        return (d && isFinite(d)) ? d : 0;
    } catch (e) { return 0; }
}

/* layer corner points, still in layer space */
function fgCorners(layer, t) {
    if (fgCamOrLight(layer)) return [[0, 0, 0]];

    var r = null;
    try { r = layer.sourceRectAtTime(t, false); } catch (e) { r = null; }
    if (!r || !isFinite(r.width) || !isFinite(r.height)) return [[0, 0, 0]];

    var x0 = r.left, x1 = r.left + r.width;
    var y0 = r.top,  y1 = r.top  + r.height;

    var d = fgExtrusion(layer, t);
    var zs = (d > 0) ? [-d / 2, d / 2] : [0];

    var out = [];
    for (var i = 0; i < zs.length; i++) {
        out.push([x0, y0, zs[i]]);
        out.push([x1, y0, zs[i]]);
        out.push([x1, y1, zs[i]]);
        out.push([x0, y1, zs[i]]);
    }
    return out;
}

// ==========================================================
// SIDEQUEST HELPERS
// ==========================================================

// Easy Ease (F9) = speed 0, influence 33.33% - the AE default graph.
function easeF9() { return new KeyframeEase(0, 33.3333); }

// Force Bezier interpolation, then stamp F9 on every key we just created.
function easeKeysF9(prop, times) {
    for (var i = 0; i < times.length; i++) {
        var idx = prop.nearestKeyIndex(times[i]);
        try {
            prop.setInterpolationTypeAtKey(
                idx,
                KeyframeInterpolationType.BEZIER,
                KeyframeInterpolationType.BEZIER
            );
        } catch (eType) {}
        applyTemporalEaseSafe(prop, idx, easeF9(), easeF9());
    }
}

// Cameras and lights have no scale and no meaningful off-frame position.
function isAnimatableLayer(layer) {
    if (layer instanceof CameraLayer) return false;
    if (layer instanceof LightLayer) return false;
    return true;
}

// Where the overshoot key sits, in frames, clamped so it can never collide
// with the first or the last key.
function midFrame(d, ratio) {
    var m = Math.round(d * ratio);
    if (m < 1) m = 1;
    if (m > d - 1) m = d - 1;
    return m;
}

// Shrink the requested duration so the animation always fits inside the layer.
function fitFrames(d, spanSec, frameDur, capRatio) {
    var avail = Math.round(spanSec / frameDur);
    /* capRatio is only passed by the combined IN+OUT action, which has to fit
       two animations inside one layer. Floor, never round: at an odd span,
       rounding up gives each side one frame too many and the two runs of
       keyframes overlap - the out pass would then read its resting position
       off the middle of the in curve. Omitted, this is the old function. */
    if (capRatio && capRatio < 1) avail = Math.floor(avail * capRatio);
    if (d > avail) d = avail;
    return d;
}

/* Comp-space bounding box of the layer, corners pushed through its own world
   matrix, so a rotated or parented layer reports the box the viewer sees. */
function compBounds(layer, W, t) {
    var pts = fgCorners(layer, t);
    if (!pts || pts.length < 4) return null;

    var minX = null, minY = null, maxX = null, maxY = null;
    for (var i = 0; i < pts.length; i++) {
        var p = m4pt(W, pts[i]);
        if (minX === null || p[0] < minX) minX = p[0];
        if (maxX === null || p[0] > maxX) maxX = p[0];
        if (minY === null || p[1] < minY) minY = p[1];
        if (maxY === null || p[1] > maxY) maxY = p[1];
    }
    return { left: minX, top: minY, right: maxX, bottom: maxY };
}

/* A child's Position lives in its PARENT's coordinate space, so a comp-space
   target has to be pushed back through the parent's world matrix before it
   can be written. */
function compToParent(layer, pt, t) {
    if (!layer.parent) return [pt[0], pt[1], pt[2]];
    return m4pt(m4inv(fgParentWorld(layer, t)), pt);
}

/* AE reports Position with two or three components depending on the layer -
   a 2D text layer still reports three - so write back what it actually
   reports instead of guessing from threeDLayer. */
function fgPropDims(prop, t) {
    try {
        var v = prop.valueAtTime(t, false);
        return (v instanceof Array) ? v.length : 1;
    } catch (e) { return 2; }
}

function fgPutOne(prop, t, val, asKey) {
    if (asKey || prop.numKeys > 0) prop.setValueAtTime(t, val);
    else prop.setValue(val);
}

function fgPutPos(layer, t, v, asKey) {
    var tg = fgTG(layer);
    if (fgPosSeparated(layer)) {
        fgPutOne(tg.property("ADBE Position_0"), t, v[0], asKey);
        fgPutOne(tg.property("ADBE Position_1"), t, v[1], asKey);
        return;
    }
    var p = tg.property("ADBE Position");
    var dims = fgPropDims(p, t);
    fgPutOne(p, t, (dims === 3) ? [v[0], v[1], v[2]] : [v[0], v[1]], asKey);
}

/* Three position keyframes, then a straight motion path and F9 on each. */
function fgKeyPos(layer, times, pts) {
    var i;
    for (i = 0; i < times.length; i++) fgPutPos(layer, times[i], pts[i], true);

    var tg = fgTG(layer);
    if (fgPosSeparated(layer)) {
        easeKeysF9(tg.property("ADBE Position_0"), times);
        easeKeysF9(tg.property("ADBE Position_1"), times);
        return;
    }
    var p = tg.property("ADBE Position");
    for (i = 0; i < times.length; i++) {
        var ki = p.nearestKeyIndex(times[i]);
        try { p.setSpatialAutoBezierAtKey(ki, false); } catch (eA) {}
        try { p.setSpatialContinuousAtKey(ki, false); } catch (eB) {}
        applySpatialTangentsSafe(p, ki, [0, 0, 0], [0, 0, 0]);
    }
    easeKeysF9(p, times);
}

// How far the layer must travel to clear the frame, per side, in comp space.
function offFrameDelta(side, box, comp, margin) {
    if (side === "left")   return [-(box.right + margin), 0];
    if (side === "right")  return [(comp.width - box.left) + margin, 0];
    if (side === "top")    return [0, -(box.bottom + margin)];
    return [0, (comp.height - box.top) + margin];   // bottom
}

/* Overshoot offset. It depends only on which side of the frame is involved,
   not on the direction of travel: coming FROM the left the layer slides a few
   pixels past its target to the right, going TO the left it backs up a few
   pixels to the right first. Same vector, both times. */
function overshootDelta(side, px) {
    if (side === "left")   return [px, 0];
    if (side === "right")  return [-px, 0];
    if (side === "top")    return [0, px];
    return [0, -px];                                 // bottom
}

function tail(skipped, expr) {
    var s = "";
    if (skipped > 0) s += " - " + skipped + " skipped (too short / not animatable)";
    if (expr > 0) s += " - " + expr + " driven by an expression, it will override at render";
    return s;
}

// ==========================================
// 1. SCALE POP  (0% -> overshoot -> original scale, easy ease F9)
// ==========================================
function applyScalePop(isIn, durFrames, overPct, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee SideQuest Scale " + (isIn ? "In" : "Out"));
    var count = 0, skipped = 0, expr = 0;

    try {
        var fd = comp.frameDuration;
        var mult = overPct / 100;

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (!isAnimatableLayer(layer)) { skipped++; continue; }

            var sc = null;
            try { sc = layer.transform.scale; } catch (eSc) { sc = null; }
            if (!sc) { skipped++; continue; }

            // Fit the animation inside the layer, then place the three keys.
            var t0, t1, t2, tRest, d;

            if (isIn) {
                d = fitFrames(Math.round(durFrames), (layer.outPoint - fd) - layer.inPoint, fd);
                if (d < 2) { skipped++; continue; }
                t0 = layer.inPoint;
                t1 = t0 + midFrame(d, 0.75) * fd;
                t2 = t0 + d * fd;
                tRest = t2;
            } else {
                var tEnd = layer.outPoint - fd;          // last frame the layer is visible
                d = fitFrames(Math.round(durFrames), tEnd - layer.inPoint, fd);
                if (d < 2) { skipped++; continue; }
                t2 = tEnd;
                t0 = t2 - d * fd;
                t1 = t0 + midFrame(d, 0.25) * fd;
                tRest = t0;
            }

            if (sc.expressionEnabled) expr++;

            // Read the layer's real scale BEFORE any key is written - "100%" in
            // the brief means the scale the layer is already sitting at, which
            // is often not 100.
            var rest = sc.valueAtTime(tRest, false);
            if (!(rest instanceof Array)) rest = [rest];

            var zero = [], over = [];
            for (var k = 0; k < rest.length; k++) {
                zero.push(0);
                over.push(rest[k] * mult);
            }

            if (isIn) {
                sc.setValueAtTime(t0, zero);
                sc.setValueAtTime(t1, over);
                sc.setValueAtTime(t2, rest);
            } else {
                sc.setValueAtTime(t0, rest);
                sc.setValueAtTime(t1, over);
                sc.setValueAtTime(t2, zero);
            }

            easeKeysF9(sc, [t0, t1, t2]);
            count++;
        }

        if (statusLabel) {
            statusLabel.text = "Scale " + (isIn ? "IN" : "OUT") + " applied to " + count +
                " layer(s) (" + Math.round(durFrames) + "f, " + overPct + "%)" +
                tail(skipped, expr);
        }
    } catch(e) {
        throw new Error("Scale pop failed: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 2. POSITION POP  (off-frame -> overshoot -> original position, easy ease F9)
// ==========================================
function applyPositionPop(isIn, side, durFrames, overPx, statusLabel, capRatio, ownUndo) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    /* Undo groups do NOT nest in After Effects: the first endUndoGroup closes the
       OUTERMOST group, so the remaining ends have nothing to close and AE throws
       "Undo group mismatch, will attempt to fix" on every later Cmd+Z. When a
       caller (applyPositionBoth) has already opened a group, this one must not
       open its own. ownUndo defaults to true, so every existing call site and
       every launcher behaves exactly as before. */
    var manageUndo = (ownUndo !== false);
    if (manageUndo) app.beginUndoGroup("Feugee SideQuest Position " + (isIn ? "In " : "Out ") + side);
    var count = 0, skipped = 0, expr = 0;
    var MARGIN = 24;    // extra pixels so the layer clears the frame completely

    try {
        var fd = comp.frameDuration;

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (!isAnimatableLayer(layer)) { skipped++; continue; }

            var tg = null;
            try { tg = fgTG(layer); } catch (eTf) { tg = null; }
            if (!tg || !tg.property("ADBE Position")) { skipped++; continue; }

            var t0, t1, t2, tRest, d;

            if (isIn) {
                d = fitFrames(Math.round(durFrames), (layer.outPoint - fd) - layer.inPoint, fd, capRatio);
                if (d < 2) { skipped++; continue; }
                t0 = layer.inPoint;
                t1 = t0 + midFrame(d, 0.75) * fd;
                t2 = t0 + d * fd;
                tRest = t2;
            } else {
                var tEnd = layer.outPoint - fd;
                d = fitFrames(Math.round(durFrames), tEnd - layer.inPoint, fd, capRatio);
                if (d < 2) { skipped++; continue; }
                t2 = tEnd;
                t0 = t2 - d * fd;
                t1 = t0 + midFrame(d, 0.25) * fd;
                tRest = t0;
            }

            // resting position, already in the property's own (parent) space
            var rest = fgReadPos(layer, tRest);
            if (fgPosLocked(layer)) expr++;

            // the same point, and the layer's box, in comp space
            var W = fgWorldMatrix(layer, tRest);
            var ap = fgVec3(tg.property("ADBE Anchor Point").valueAtTime(tRest, false), 0);
            var restComp = m4pt(W, ap);

            var box = compBounds(layer, W, tRest);
            if (!box) {
                // No source rect (odd layer types): fall back to a box the
                // size of the comp, centred on the layer.
                box = {
                    left:   restComp[0] - comp.width / 2,
                    right:  restComp[0] + comp.width / 2,
                    top:    restComp[1] - comp.height / 2,
                    bottom: restComp[1] + comp.height / 2
                };
            }

            var off  = offFrameDelta(side, box, comp, MARGIN);
            var over = overshootDelta(side, overPx);

            // comp space -> parent space, where Position actually lives.
            // Depth is carried straight through, never altered.
            var offPt  = compToParent(layer, [restComp[0] + off[0],  restComp[1] + off[1],  restComp[2]], tRest);
            var overPt = compToParent(layer, [restComp[0] + over[0], restComp[1] + over[1], restComp[2]], tRest);

            var pts = isIn ? [offPt, overPt, rest] : [rest, overPt, offPt];
            fgKeyPos(layer, [t0, t1, t2], pts);

            count++;
        }

        if (statusLabel) {
            statusLabel.text = (isIn ? "Position IN from " : "Position OUT to ") + side.toUpperCase() +
                " applied to " + count + " layer(s) (" + Math.round(durFrames) + "f, " + overPx + "px overshoot)" +
                tail(skipped, expr);
        }

        return { count: count, skipped: skipped, expr: expr };
    } catch(e) {
        throw new Error("Position pop failed: " + e.toString());
    } finally {
        if (manageUndo) app.endUndoGroup();
    }
}

/* ------------------------------------------------------------------
   2b. POSITION POP  -  IN + OUT in one press

   One button per side instead of eight: the layer flies in from that side at
   its in-point and leaves through the same side at its out-point, so the exit
   reads as the entrance reversed. Nothing here re-implements the motion - it
   runs the tested applyPositionPop twice and only decides the timing budget.

   capRatio 0.5 is the whole trick: each pass may use at most half the layer,
   so the two runs of keyframes can touch but never overlap. Without it a short
   layer gets its out keys written on top of its in keys, and because the out
   pass reads its resting position with valueAtTime, it would read a value off
   the middle of the in curve and settle in the wrong place - silently, with a
   green status bar. That failure mode has bitten this plugin before.

   Both passes sit inside one undo group - opened HERE and nowhere else. AE undo
   groups do not nest: if the inner passes opened their own, the first
   endUndoGroup would close this outer one and AE would warn "Undo group
   mismatch, will attempt to fix" on every Cmd+Z from then on, for the rest of
   the session. That is why applyPositionPop is called with ownUndo=false.
   ------------------------------------------------------------------ */
function applyPositionBoth(side, durFrames, overPx, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee SideQuest Position In+Out " + side);
    try {
        // ownUndo=false: this function already holds the only group (see the note
        // in applyPositionPop - AE undo groups do not nest).
        var a = applyPositionPop(true,  side, durFrames, overPx, null, 0.5, false) || { count: 0, skipped: 0, expr: 0 };
        var b = applyPositionPop(false, side, durFrames, overPx, null, 0.5, false) || { count: 0, skipped: 0, expr: 0 };

        // A layer too short to hold both halves is skipped by both passes.
        var done = Math.min(a.count, b.count);
        var half = Math.max(a.count, b.count) - done;   // in but no out, or the reverse

        if (statusLabel) {
            statusLabel.text = "Position IN+OUT " + side.toUpperCase() +
                " applied to " + done + " layer(s) (" + Math.round(durFrames) + "f each way, " +
                overPx + "px overshoot)" +
                (half > 0 ? " - " + half + " got one half only" : "") +
                tail(a.skipped, a.expr);
        }
    } catch (e) {
        throw new Error("Position in+out failed: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 3. OVERLAP / STAGGER  - Knowledge Nuke logic, unchanged
// ==========================================
function applyOverlap(directionDown, stepFrames, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee SideQuest Overlap");
    try {
        var sorted = [];
        for (var i = 0; i < layers.length; i++) sorted.push(layers[i]);
        sorted.sort(function(a, b) { return a.index - b.index; });

        if (!directionDown) {
            sorted.reverse();
        }

        var baseStartTime = sorted[0].startTime;
        var offsetSec = stepFrames * comp.frameDuration;

        for (var j = 0; j < sorted.length; j++) {
            sorted[j].startTime = baseStartTime + (j * offsetSec);
        }

        if (statusLabel) statusLabel.text = "Overlap " + stepFrames + "f applied to " + sorted.length + " layer(s)";
    } catch(e) {
        throw new Error("Overlap failed: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// 4. AUTO NULL RIG  - Knowledge Nuke logic + the new nulls stay selected
// ==========================================
function createNullRig(autoParent, statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee SideQuest Auto Null Rig");
    var count = 0;
    var made = [];
    try {
        var curTime = comp.time;

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var centerInComp = null;

            try {
                var rect = layer.sourceRectAtTime(curTime, false);
                var localCenter = [rect.left + (rect.width / 2), rect.top + (rect.height / 2), 0];
                centerInComp = m4pt(fgWorldMatrix(layer, curTime), localCenter);
            } catch(eRect) {
                try {
                    centerInComp = m4pt(fgWorldMatrix(layer, curTime),
                        fgVec3(fgTG(layer).property("ADBE Anchor Point").valueAtTime(curTime, false), 0));
                } catch(eAP) {
                    centerInComp = fgReadPos(layer, curTime);
                }
            }

            var nullLayer = comp.layers.addNull();
            nullLayer.name = "Null_" + layer.name;
            nullLayer.label = 13;

            var nullHalfW = nullLayer.width / 2;
            var nullHalfH = nullLayer.height / 2;
            nullLayer.transform.anchorPoint.setValue([nullHalfW, nullHalfH]);

            if (layer.threeDLayer) {
                nullLayer.threeDLayer = true;
                var zVal = 0;
                try { zVal = layer.transform.position.value[2] || 0; } catch(e3d) {}
                nullLayer.transform.position.setValue([centerInComp[0], centerInComp[1], zVal]);
            } else {
                nullLayer.transform.position.setValue([centerInComp[0], centerInComp[1]]);
            }

            nullLayer.startTime = layer.startTime;
            nullLayer.inPoint = layer.inPoint;
            nullLayer.outPoint = layer.outPoint;

            nullLayer.moveBefore(layer);

            if (autoParent) {
                var oldParent = layer.parent;
                if (oldParent) {
                    nullLayer.parent = oldParent;
                }
                layer.parent = nullLayer;
            }

            made.push(nullLayer);
            count++;
        }

        // Hand the selection straight over to the new nulls, so the next click
        // (Scale In, Position In, ...) lands on the rig instead of the artwork.
        for (var d = 1; d <= comp.numLayers; d++) {
            try { comp.layer(d).selected = false; } catch (eDes) {}
        }
        for (var n = 0; n < made.length; n++) {
            try { made[n].selected = true; } catch (eSel) {}
        }

        if (statusLabel) {
            statusLabel.text = "Created " + count + " Null layer(s) at the asset visual centre - " +
                count + " null(s) now selected";
        }
    } catch(e) {
        throw new Error("Auto null rig failed: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

function centerAssetAnchorPoint(statusLabel) {
    var comp = getActiveComp();
    if (!comp) return;
    var layers = getSelectedLayers(comp);
    if (layers.length === 0) return;

    app.beginUndoGroup("Feugee SideQuest Center Anchor Point");
    var count = 0;
    try {
        var curTime = comp.time;
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var tf = layer.transform;
            if (!tf || !tf.anchorPoint || !tf.position) continue;

            var tg = fgTG(layer);
            var apProp = tg.property("ADBE Anchor Point");
            if (!apProp) continue;

            var rect = layer.sourceRectAtTime(curTime, false);

            var curV = apProp.valueAtTime(curTime, false);
            var curAP = fgVec3(curV, 0);
            var nx = rect.left + (rect.width / 2);
            var ny = rect.top + (rect.height / 2);
            var newAP = [nx, ny, curAP[2]];

            /* Where the asset's centre sits on screen RIGHT NOW - measured with
               the transform still untouched. Position is, by definition, the
               anchor expressed in the parent's space, so once the anchor moves
               to the centre, putting Position on that same screen point leaves
               the artwork exactly where it was. Measuring the OLD anchor here
               instead would slide the layer by the anchor offset. */
            var targetComp = m4pt(fgWorldMatrix(layer, curTime), newAP);

            fgPutOne(apProp, curTime,
                     (curV instanceof Array && curV.length > 2) ? [nx, ny, curV[2]] : [nx, ny],
                     false);

            fgPutPos(layer, curTime, compToParent(layer, targetComp, curTime), false);

            count++;
        }
        if (statusLabel) statusLabel.text = "Centred the anchor point of " + count + " layer(s)";
    } catch(e) {
        throw new Error("Center anchor failed: " + e.toString());
    } finally {
        app.endUndoGroup();
    }
}

// ==========================================
// PREFS  -  shared with the File > Scripts launchers
//
// The panel's number fields live in the browser, where a launcher script
// cannot see them. So the panel mirrors them into one small text file and the
// launchers read it - press the shortcut and you get the numbers you last set
// in the panel, not whatever was hard-coded.
//
// Plain key=value lines on purpose: ExtendScript has no JSON, and parsing this
// by hand beats eval()-ing a file.
// ==========================================
function fgPrefsFile() {
    var dir = new Folder(Folder.userData.fsName + "/Feugee");
    if (!dir.exists) dir.create();
    return new File(dir.fsName + "/sidequest.txt");
}

function fgPrefsSave(scaleDur, scaleOver, posDur, posOver, stepOff, autoParent) {
    try {
        var f = fgPrefsFile();
        f.encoding = "UTF-8";
        if (!f.open("w")) return "ERR|Could not write the settings file";
        f.write("scaleDur=" + scaleDur + "\n" +
                "scaleOver=" + scaleOver + "\n" +
                "posDur=" + posDur + "\n" +
                "posOver=" + posOver + "\n" +
                "stepOff=" + stepOff + "\n" +
                "autoParent=" + (autoParent ? 1 : 0) + "\n");
        f.close();
        return "OK|Settings saved";
    } catch (e) { return "ERR|" + e.toString(); }
}

function fgPrefsLoad() {
    try {
        var f = fgPrefsFile();
        if (!f.exists) return "OK|";
        f.encoding = "UTF-8";
        if (!f.open("r")) return "OK|";
        var raw = f.read();
        f.close();
        return "OK|" + String(raw).replace(/[\r\n]+/g, ";");
    } catch (e) { return "ERR|" + e.toString(); }
}

// ==========================================
// ENTRY POINTS  (called by the panel through evalScript)
// ==========================================
function fgScale(isIn, dur, over) {
    return fgWrap(function () { applyScalePop(isIn, dur, over, FG_STATUS); });
}
function fgPos(isIn, side, dur, over) {
    return fgWrap(function () { applyPositionPop(isIn, side, dur, over, FG_STATUS); });
}
function fgPosBoth(side, dur, over) {
    return fgWrap(function () { applyPositionBoth(side, dur, over, FG_STATUS); });
}
function fgOverlap(down, step) {
    return fgWrap(function () { applyOverlap(down, step, FG_STATUS); });
}
function fgNullRig(autoParent) {
    return fgWrap(function () { createNullRig(autoParent, FG_STATUS); });
}
function fgCenterAnchor() {
    return fgWrap(function () { centerAssetAnchorPoint(FG_STATUS); });
}

function fgPrefsWrite(a, b, c, d, e, f) { return fgPrefsSave(a, b, c, d, e, f); }
function fgPrefsRead() { return fgPrefsLoad(); }

// Called by the panel on boot to confirm the host script loaded.
function fgPing() {
    try { return "OK|Host ready - AE " + app.version.split("x")[0]; }
    catch (e) { return "OK|Host ready"; }
}

// ---- the only global this file creates ----
return {
    scale: fgScale,
    pos: fgPos,
    posBoth: fgPosBoth,
    overlap: fgOverlap,
    nullRig: fgNullRig,
    centerAnchor: fgCenterAnchor,
    prefsSave: fgPrefsWrite,
    prefsLoad: fgPrefsRead,
    ping: fgPing
};

})();
