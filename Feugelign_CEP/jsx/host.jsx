/**
 * FEUGEE STUDIO - FEUGELIGN  |  HOST SCRIPT (ExtendScript)
 * Version: 1.0.0 (CEP)
 * Author: Muhammad Rijal Nurjaman (Feugee Studio)
 *
 * This file has NO UI. The UI lives in index.html (CEP panel).
 * The panel calls the fg*() entry points through evalScript() and receives
 * a string of the form "OK|message" or "ERR|message".
 *
 * What happens here: parenting-aware 2D & 3D align + distribute, covering
 * rotation, cameras and depth. After Effects exposes no matrix API, so each
 * layer's transform matrix is assembled by hand from its transform properties.
 *
 * After Effects space convention: X right, Y DOWN, Z into the screen.
 * Matriks disimpan row-major (16 angka), baris terakhir selalu 0,0,0,1.
 */

/* ---------------------------------------------------------------------------
   NAMESPACE - do not remove.

   Every CEP extension loaded in one After Effects instance shares ONE global
   ExtendScript scope. Two plugins declaring `fgWrap` overwrite each other and
   the panel that loaded first silently calls the other plugin's function.
   That is exactly what happened between Knowledge Nuke and Feugelign.

   So the whole host lives inside this IIFE and exposes a single global object.
   The body below is left at its original indentation on purpose, so it stays
   diffable against earlier versions.
   --------------------------------------------------------------------------- */

var FG_ALIGN = (function () {

var FG_STATUS = { text: "" };
var FG_EPS = 1e-6;

// ==========================================================
// GUARD + PROTOKOL BALASAN
// ==========================================================
function fgMsg(e) {
    var s = (e && e.message) ? String(e.message) : String(e);
    return s.replace(/^Error:\s*/, "");
}

function fgWrap(undoName, minLayers, fn) {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return "ERR|Open or activate a Composition first";

    var sel = comp.selectedLayers;
    if (!sel || sel.length < minLayers) {
        return "ERR|Select at least " + minLayers + " layer(s) in the timeline";
    }

    FG_STATUS.text = "";
    var opened = false;
    try {
        app.beginUndoGroup(undoName);
        opened = true;
        fn(comp, sel);
    } catch (e) {
        if (opened) { try { app.endUndoGroup(); } catch (e2) {} }
        return "ERR|" + fgMsg(e);
    }
    try { app.endUndoGroup(); } catch (e3) {}

    return "OK|" + (FG_STATUS.text || "Selesai");
}

// ==========================================================
// MATRIX 4x4 (row-major, affine)
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

function fgBoundsIn(wpts, Wm) {
    var mn = [1e15, 1e15, 1e15], mx = [-1e15, -1e15, -1e15];
    for (var i = 0; i < wpts.length; i++) {
        var p = m4pt(Wm, wpts[i]);
        for (var a = 0; a < 3; a++) {
            if (p[a] < mn[a]) mn[a] = p[a];
            if (p[a] > mx[a]) mx[a] = p[a];
        }
    }
    return { min: mn, max: mx };
}

function fgPick(b, axis, mode) {
    if (mode === "min") return b.min[axis];
    if (mode === "max") return b.max[axis];
    return (b.min[axis] + b.max[axis]) / 2;
}

// ==========================================================
// RECORD PER LAYER
// ==========================================================
function fgRecords(layers, t) {
    var recs = [];
    for (var i = 0; i < layers.length; i++) {
        var L = layers[i];
        var W  = fgWorldMatrix(L, t);
        var PW = fgParentWorld(L, t);
        var pts = fgCorners(L, t);
        var wp = [];
        for (var k = 0; k < pts.length; k++) wp[k] = m4pt(W, pts[k]);

        recs.push({
            layer: L,
            index: L.index,
            name: L.name,
            world: W,
            parentWorld: PW,
            parentInv: m4inv(PW),
            pos: fgReadPos(L, t),
            wpts: wp,
            is3D: (L.threeDLayer === true),
            locked: fgPosLocked(L)
        });
    }
    return recs;
}

function fgFindRec(recs, idx) {
    for (var i = 0; i < recs.length; i++) if (recs[i].index === idx) return recs[i];
    return null;
}

// ==========================================================
// WORKING SPACE  (Align by)
//   world     -> koordinat dunia comp
//   view      -> camera space, movement parallel to the camera plane
//   viewworld -> measured in camera space, moved along world axes
//   parent    -> shared parent local space
// ==========================================================
function fgChain(layer) {
    var c = [], p = layer.parent, g = 0;
    while (p && g++ < 64) { c.push(p); p = p.parent; }
    return c;
}

function fgSharedParent(recs) {
    if (recs.length === 0) return null;
    var base = fgChain(recs[0].layer);
    for (var i = 0; i < base.length; i++) {
        var cand = base[i], ok = true;
        for (var j = 1; j < recs.length && ok; j++) {
            var ch = fgChain(recs[j].layer), found = false;
            for (var k = 0; k < ch.length; k++) {
                if (ch[k].index === cand.index) { found = true; break; }
            }
            ok = found;
        }
        if (ok) return cand;
    }
    return null;
}

function fgSpace(comp, recs, by, t) {
    if (by === "world") {
        return { Wm: m4id(), Winv: m4id(), basis: "space", label: "World" };
    }
    if (by === "view" || by === "viewworld") {
        var v = fgViewPair(comp, t);
        return {
            Wm: v.Wm,
            Winv: v.Winv,
            basis: (by === "viewworld") ? "world" : "space",
            hasCam: v.hasCam,
            label: (by === "viewworld") ? "View via World" : "View"
        };
    }
    if (by === "parent") {
        var sp = fgSharedParent(recs);
        if (!sp) throw new Error("Selected layers share no common parent - VIA PARENT needs one shared parent");
        var PW = fgWorldMatrix(sp, t);
        return { Wm: m4inv(PW), Winv: PW, basis: "space", label: "Parent " + sp.name };
    }
    throw new Error("Unknown space mode: " + by);
}

// ==========================================================
// GERAK
// ==========================================================
/* delta = distance to travel IN MEASUREMENT SPACE, along the given axis */
function fgMove(rec, delta, axis, space, t) {
    var dWorld;

    if (space.basis === "world") {
        /* target measured in camera space, but layers move along world axes.
           viewAxis(p + k*e) = viewAxis(p) + k * (Wm . e)[axis]  ->  k = delta / proyeksi */
        var e = [0, 0, 0]; e[axis] = 1;
        var proj = m4vec(space.Wm, e)[axis];
        if (Math.abs(proj) < 1e-9) return false;   // this world axis is perpendicular to the measurement axis
        var k = delta / proj;
        dWorld = [e[0] * k, e[1] * k, e[2] * k];
    } else {
        var dv = [0, 0, 0]; dv[axis] = delta;
        dWorld = m4vec(space.Winv, dv);
    }

    var wp = m4pt(rec.parentWorld, rec.pos);
    var np = m4pt(rec.parentInv, [wp[0] + dWorld[0], wp[1] + dWorld[1], wp[2] + dWorld[2]]);
    fgWritePos(rec.layer, t, np);
    return true;
}

/* Scale compensate: the layer moves along the camera depth axis, then scale
   and x/y are corrected by the distance ratio so on-screen size stays put. */
function fgMoveDepthComp(rec, delta, space, t) {
    var wp = m4pt(rec.parentWorld, rec.pos);
    var vp = m4pt(space.Wm, wp);
    var vz = vp[2];
    if (vz <= FG_EPS) return false;              // layer is behind or exactly at the camera
    var nz = vz + delta;
    if (nz <= FG_EPS) return false;

    var ratio = nz / vz;
    var nw = m4pt(space.Winv, [vp[0] * ratio, vp[1] * ratio, nz]);
    fgWritePos(rec.layer, t, m4pt(rec.parentInv, nw));
    fgScaleBy(rec.layer, t, ratio);
    return true;
}

// ==========================================================
// TARGET (Align to)
// ==========================================================
function fgTargetBounds(comp, recs, to, safe, keyIdx, Wm) {
    if (to === "comp") {
        var fx = 0, fy = 0;
        if (safe === "action") { fx = 0.05; fy = 0.05; }   // action safe 90%
        else if (safe === "title") { fx = 0.10; fy = 0.10; } // title safe 80%
        var ix = comp.width * fx, iy = comp.height * fy;
        return fgBoundsIn([
            [ix, iy, 0],
            [comp.width - ix, iy, 0],
            [comp.width - ix, comp.height - iy, 0],
            [ix, comp.height - iy, 0]
        ], Wm);
    }

    if (to === "key") {
        var kr = fgFindRec(recs, keyIdx);
        if (!kr) throw new Error("Key object is not in the selection - click the reference layer again");
        return fgBoundsIn(kr.wpts, Wm);
    }

    var all = [];
    for (var i = 0; i < recs.length; i++) all = all.concat(recs[i].wpts);
    return fgBoundsIn(all, Wm);
}

function fgAxisNum(axis) {
    if (axis === "x") return 0;
    if (axis === "y") return 1;
    return 2;
}

function fgOnly3D(recs) {
    var out = [];
    for (var i = 0; i < recs.length; i++) if (recs[i].is3D) out.push(recs[i]);
    return out;
}

function fgLockedNote(pool) {
    var n = 0;
    for (var i = 0; i < pool.length; i++) if (pool[i].locked) n++;
    return n ? (" - " + n + " layer posisinya dikunci ekspresi") : "";
}

// ==========================================================
// ENTRY POINT: ALIGN
// ==========================================================
function fgAlign(axis, mode, to, by, safe, scaleComp, keyIdx) {
    var axes = [];
    var isMulti = false;
    if (axis === "xy" || axis === "2d") {
        axes = [0, 1];
        isMulti = true;
    } else if (axis === "xyz" || axis === "3d") {
        axes = [0, 1, 2];
        isMulti = true;
    } else {
        axes = [fgAxisNum(axis)];
    }
    var need = (to === "comp") ? 1 : 2;

    var title = isMulti ? (axes.length === 3 ? "Feugelign - Center 3D" : "Feugelign - Center 2D")
                        : "Feugelign - Align";

    return fgWrap(title, need, function (comp, sel) {
        var t = comp.time;
        var recs = fgRecords(sel, t);
        var space = fgSpace(comp, recs, by, t);

        var pool = recs, skipped2D = 0;
        var hasZ = false;
        for (var k = 0; k < axes.length; k++) if (axes[k] === 2) hasZ = true;

        if (hasZ) {
            pool = fgOnly3D(recs);
            skipped2D = recs.length - pool.length;
            if (pool.length === 0) throw new Error("No 3D layers selected - depth needs the 3D switch on");
            if (to !== "comp" && pool.length < 2) throw new Error("Depth align needs at least 2 3D layers");
        }

        var scope = (to === "sel") ? pool : recs;
        var targetBounds = fgTargetBounds(comp, scope, to, safe, keyIdx, space.Wm);

        var movedAny = false, movedCount = 0, failedCount = 0;

        for (var axIdx = 0; axIdx < axes.length; axIdx++) {
            var a = axes[axIdx];
            var target = fgPick(targetBounds, a, mode);
            var useComp = (a === 2) && scaleComp && (by === "view");

            for (var i = 0; i < pool.length; i++) {
                var r = pool[i];
                if (to === "key" && r.index === keyIdx) continue;

                var cur = fgPick(fgBoundsIn(r.wpts, space.Wm), a, mode);
                var d = target - cur;
                if (Math.abs(d) < FG_EPS) continue;

                var ok = false;
                if (useComp) {
                    ok = fgMoveDepthComp(r, d, space, t);
                } else {
                    var dWorld;
                    if (space.basis === "world") {
                        var e = [0, 0, 0]; e[a] = 1;
                        var proj = m4vec(space.Wm, e)[a];
                        if (Math.abs(proj) >= 1e-9) {
                            var kv = d / proj;
                            dWorld = [e[0] * kv, e[1] * kv, e[2] * kv];
                        }
                    } else {
                        var dv = [0, 0, 0]; dv[a] = d;
                        dWorld = m4vec(space.Winv, dv);
                    }

                    if (dWorld) {
                        var wp = m4pt(r.parentWorld, r.pos);
                        var np = m4pt(r.parentInv, [wp[0] + dWorld[0], wp[1] + dWorld[1], wp[2] + dWorld[2]]);
                        fgWritePos(r.layer, t, np);
                        r.pos = np;
                        for (var pi = 0; pi < r.wpts.length; pi++) {
                            r.wpts[pi] = [r.wpts[pi][0] + dWorld[0], r.wpts[pi][1] + dWorld[1], r.wpts[pi][2] + dWorld[2]];
                        }
                        ok = true;
                    }
                }

                if (ok) {
                    movedCount++;
                    movedAny = true;
                } else {
                    failedCount++;
                }
            }
        }

        var labelText = isMulti ? (axes.length === 3 ? "3D centre" : "2D centre")
                                : fgAxisLabel(axes[0], mode);
        var msg = (movedAny ? pool.length : 0) + " layer(s) aligned " + labelText +
                  " ke " + fgToLabel(to, safe) + " (" + space.label + ")";
        if (scaleComp && hasZ) msg += " + scale comp";
        if (skipped2D) msg += " - " + skipped2D + " layer 2D dilewati";
        if (failedCount) msg += " - " + failedCount + " operation(s) could not move";
        msg += fgLockedNote(pool);
        FG_STATUS.text = msg;
    });
}

// No chained ternaries here: ExtendScript parses a ? b : c ? d : e as
// (a ? b : c) ? d : e, which turned "min" on Y into "bawah".
function fgAxisLabel(a, mode) {
    var ax = ["X", "Y", "Z"][a];
    var md = "tengah";
    if (mode === "min") {
        md = ["kiri", "atas", "belakang"][a];
    } else if (mode === "max") {
        md = ["kanan", "bawah", "depan"][a];
    }
    return ax + " " + md;
}

function fgToLabel(to, safe) {
    if (to === "comp") {
        if (safe === "action") return "action safe";
        if (safe === "title") return "title safe";
        return "comp";
    }
    return (to === "key") ? "key object" : "selection";
}

// ==========================================================
// ENTRY POINT: DISTRIBUTE
//   gap    -> equal distance between edges (the Figma way)
//   center -> equal distance between centres (the stock AE way)
// ==========================================================
function fgDistribute(axis, dmode, by, keyIdx) {
    var a = fgAxisNum(axis);

    return fgWrap("Feugelign - Distribute", 3, function (comp, sel) {
        var t = comp.time;
        var recs = fgRecords(sel, t);
        var space = fgSpace(comp, recs, by, t);

        var pool = recs, skipped2D = 0;
        if (a === 2) {
            pool = fgOnly3D(recs);
            skipped2D = recs.length - pool.length;
        }
        if (pool.length < 3) {
            throw new Error("Distribute needs at least 3" + (a === 2 ? " 3D" : "") + " layers");
        }

        var items = fgItems(pool, space, a);
        items.sort(fgSorter(dmode));

        var n = items.length, moved = 0;

        if (dmode === "center") {
            var c0 = fgCenter(items[0]), c1 = fgCenter(items[n - 1]);
            var step = (c1 - c0) / (n - 1);
            for (var i = 1; i < n - 1; i++) {
                var d = (c0 + step * i) - fgCenter(items[i]);
                if (Math.abs(d) > FG_EPS && fgMove(items[i].rec, d, a, space, t)) moved++;
            }
        } else {
            var lo = items[0].min, hi = items[n - 1].max, sum = 0;
            for (var k = 0; k < n; k++) sum += items[k].size;
            var gap = (hi - lo - sum) / (n - 1);
            var cursor = lo;
            for (var m = 0; m < n; m++) {
                if (m > 0 && m < n - 1) {
                    var dd = cursor - items[m].min;
                    if (Math.abs(dd) > FG_EPS && fgMove(items[m].rec, dd, a, space, t)) moved++;
                }
                cursor += items[m].size + gap;
            }
            FG_STATUS.text = moved + " layer didistribusi " + ["X", "Y", "Z"][a] +
                             ", edge gap " + fgRound(gap) + "px (" + space.label + ")" +
                             (skipped2D ? " - " + skipped2D + " layer 2D dilewati" : "") +
                             fgLockedNote(pool);
            return;
        }

        FG_STATUS.text = moved + " layer didistribusi " + ["X", "Y", "Z"][a] +
                         " rata titik tengah (" + space.label + ")" +
                         (skipped2D ? " - " + skipped2D + " layer 2D dilewati" : "") +
                         fgLockedNote(pool);
    });
}

/* Distribute by distance: the edge gap is typed in, anchored on the key object. */
function fgDistributeBy(axis, dist, by, keyIdx) {
    var a = fgAxisNum(axis);
    var gap = parseFloat(dist);
    if (isNaN(gap)) gap = 0;

    return fgWrap("Feugelign - Distribute spacing", 2, function (comp, sel) {
        var t = comp.time;
        var recs = fgRecords(sel, t);
        var space = fgSpace(comp, recs, by, t);

        var pool = recs, skipped2D = 0;
        if (a === 2) {
            pool = fgOnly3D(recs);
            skipped2D = recs.length - pool.length;
        }
        if (pool.length < 2) {
            throw new Error("Needs at least 2" + (a === 2 ? " 3D" : "") + " layers");
        }

        var items = fgItems(pool, space, a);
        items.sort(fgSorter("gap"));

        var anchor = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].rec.index === keyIdx) { anchor = i; break; }
        }

        var moved = 0, cursor;

        cursor = items[anchor].max;
        for (var f = anchor + 1; f < items.length; f++) {
            var tf = cursor + gap;
            var df = tf - items[f].min;
            if (Math.abs(df) > FG_EPS && fgMove(items[f].rec, df, a, space, t)) moved++;
            cursor = tf + items[f].size;
        }

        cursor = items[anchor].min;
        for (var b = anchor - 1; b >= 0; b--) {
            var tb = cursor - gap - items[b].size;
            var db = tb - items[b].min;
            if (Math.abs(db) > FG_EPS && fgMove(items[b].rec, db, a, space, t)) moved++;
            cursor = tb;
        }

        FG_STATUS.text = moved + " layer(s) spaced " + fgRound(gap) + "px on axis " +
                         ["X", "Y", "Z"][a] + ", jangkar " + items[anchor].rec.name +
                         " (" + space.label + ")" +
                         (skipped2D ? " - " + skipped2D + " layer 2D dilewati" : "") +
                         fgLockedNote(pool);
    });
}

function fgItems(pool, space, a) {
    var items = [];
    for (var i = 0; i < pool.length; i++) {
        var b = fgBoundsIn(pool[i].wpts, space.Wm);
        items.push({ rec: pool[i], min: b.min[a], max: b.max[a], size: b.max[a] - b.min[a] });
    }
    return items;
}

function fgCenter(it) { return (it.min + it.max) / 2; }

function fgSorter(dmode) {
    if (dmode === "center") {
        return function (p, q) { return fgCenter(p) - fgCenter(q); };
    }
    return function (p, q) { return p.min - q.min; };
}

function fgRound(v) { return Math.round(v * 10) / 10; }

// ==========================================================
// ENTRY POINT: SELECTION STATUS (polled by the panel)
// Reply: OK|<comp name>|<has camera 0/1>|idx:name:is3d;idx:name:is3d;...
// ==========================================================
function fgClean(s) { return String(s).replace(/[|;:]/g, " "); }

function fgSelection() {
    var comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return "ERR|Open or activate a Composition first";

    var sel = comp.selectedLayers;
    var parts = [];
    for (var i = 0; i < sel.length; i++) {
        parts.push(sel[i].index + ":" + fgClean(sel[i].name) + ":" + (sel[i].threeDLayer ? 1 : 0));
    }
    return "OK|" + fgClean(comp.name) + "|" + (comp.activeCamera ? 1 : 0) + "|" + parts.join(";");
}

// Dipanggil panel saat start, buat memastikan host script kebaca.
function fgPing() {
    try { return "OK|Host ready - AE " + app.version.split("x")[0]; }
    catch (e) { return "OK|Host ready"; }
}

// ---- the only global this file creates ----
return {
    align: fgAlign,
    distribute: fgDistribute,
    distributeBy: fgDistributeBy,
    selection: fgSelection,
    ping: fgPing
};

})();
