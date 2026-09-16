/**
 * Feugelord - After Effects side of the round trip.
 * Run after the Illustrator fixture was pushed as ARTBOARD (one comp "Fixture").
 * Checks the built shape layers against the fixture geometry, renders the comp
 * to fixture-ae.png for the pixel comparison, then removes what it checked.
 * Refuses to touch a project that has been saved to disk.
 */
(function () {
    var dir = Folder.userData.fsName + "/Feugee/feugelord-test/";
    var lines = [], fails = 0;
    function check(name, cond, extra) { if (!cond) fails++; lines.push((cond ? "PASS  " : "FAIL  ") + name + (extra ? "   [" + extra + "]" : "")); }
    function finish() {
        var f = new File(dir + "verify-ae.txt"); f.encoding = "UTF-8"; f.lineFeed = "Unix"; f.open("w");
        f.write(lines.join("\n") + "\n" + (fails ? fails + " FAILED" : "ALL PASSED") + "\n"); f.close();
        return fails ? "ERR|" + fails + " failed" : "OK|all passed";
    }
    if (app.project.file) { lines.push("SKIP  project is saved on disk - use File > New > New Project"); fails++; return finish(); }

    var comp = null;
    for (var i = app.project.numItems; i >= 1; i--) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === "Fixture") { comp = it; break; }
    }
    check("artboard push made comp \"Fixture\" 800x600", comp && comp.width === 800 && comp.height === 600, comp ? comp.width + "x" + comp.height : "missing");
    if (!comp) return finish();

    check("one shape layer per Illustrator layer", comp.numLayers === 1 && comp.layer(1).name === "Layer 1", comp.numLayers + " / " + (comp.numLayers ? comp.layer(1).name : ""));
    var root = comp.layer(1).property("ADBE Root Vectors Group");
    function child(parent, name) {
        for (var k = 1; k <= parent.numProperties; k++) if (parent.property(k).name === name) return parent.property(k);
        return null;
    }
    function innerOf(g) { return g.property("ADBE Vectors Group"); }
    function first(inner, match) {
        for (var k = 1; k <= inner.numProperties; k++) if (inner.property(k).matchName === match) return inner.property(k);
        return null;
    }
    var names = [];
    for (var n = 1; n <= root.numProperties; n++) names.push(root.property(n).name);
    check("stacking order matches Illustrator (top first)", names.join(",") === "wordmark,gray triangle,half group,donut,open curve,star bevel,ellipse,rect dashed,bg", names.join(","));

    var rect = child(root, "rect dashed");
    var ri = innerOf(rect);
    var shape = first(ri, "ADBE Vector Shape - Group").property("ADBE Vector Shape").value;
    var xs = [], ys = [];
    for (var v = 0; v < shape.vertices.length; v++) { xs.push(shape.vertices[v][0]); ys.push(shape.vertices[v][1]); }
    var layer = comp.layer(1);
    var ap = layer.transform.anchorPoint.value, pos = layer.transform.position.value;
    var ox = pos[0] - ap[0], oy = pos[1] - ap[1];
    check("rect in comp space 40,40..240,160", Math.min.apply(null, xs) + ox === 40 && Math.max.apply(null, xs) + ox === 240 &&
          Math.min.apply(null, ys) + oy === 40 && Math.max.apply(null, ys) + oy === 160, xs.join(",") + " / " + ys.join(","));
    var stroke = first(ri, "ADBE Vector Graphic - Stroke");
    check("stroke width 8, round cap, round join", stroke && stroke.property("ADBE Vector Stroke Width").value === 8 &&
          stroke.property("ADBE Vector Stroke Line Cap").value === 2 && stroke.property("ADBE Vector Stroke Line Join").value === 2);
    var dashes = stroke.property("ADBE Vector Stroke Dashes");
    check("dash 24 / gap 10", dashes.property("ADBE Vector Stroke Dash 1") && dashes.property("ADBE Vector Stroke Dash 1").value === 24 &&
          dashes.property("ADBE Vector Stroke Gap 1").value === 10);
    var fill = first(ri, "ADBE Vector Graphic - Fill");
    var fc = fill.property("ADBE Vector Fill Color").value;
    check("fill #f2631c", Math.round(fc[0] * 255) === 242 && Math.round(fc[1] * 255) === 99 && Math.round(fc[2] * 255) === 28, fc.toString());
    check("stroke listed above fill (draws on top)", stroke.propertyIndex < fill.propertyIndex);

    var donut = innerOf(child(root, "donut"));
    var paths = 0;
    for (var d = 1; d <= donut.numProperties; d++) if (donut.property(d).matchName === "ADBE Vector Shape - Group") paths++;
    check("donut: 2 paths, even-odd fill", paths === 2 && first(donut, "ADBE Vector Graphic - Fill").property("ADBE Vector Fill Rule").value === 2);

    var half = child(root, "half group");
    check("group opacity 50", half.property("ADBE Vector Transform Group").property("ADBE Vector Group Opacity").value === 50);
    check("nested group kept", !!child(innerOf(half), "nested"));
    check("star bevel join", first(innerOf(child(root, "star bevel")), "ADBE Vector Graphic - Stroke").property("ADBE Vector Stroke Line Join").value === 3);
    var oc = first(innerOf(child(root, "open curve")), "ADBE Vector Shape - Group").property("ADBE Vector Shape").value;
    check("open curve stays open with its handles", !oc.closed && oc.inTangents[1][0] === -60 && oc.inTangents[1][1] === -40 && oc.outTangents[1][0] === 60);
    check("no hidden item", !child(root, "hidden"));

    comp.openInViewer();
    comp.time = 0;
    var png = new File(dir + "fixture-ae.png");
    if (png.exists) png.remove();
    comp.saveFrameToPng(0, png);
    lines.push("INFO  render queued to fixture-ae.png (written after this script returns)");
    return finish();
})();
