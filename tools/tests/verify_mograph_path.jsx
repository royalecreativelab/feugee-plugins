/**
 * Feugee Mograph PATH cloner - live verification inside After Effects.
 *
 * Loads the repo's host.jsx (not the installed copy), builds scratch comps and
 * checks where the clones land, in BOTH expression engines. Refuses to run in
 * a project that has been saved, and removes every item it created. Report:
 *   ~/Library/Application Support/Feugee/mograph-path-verify.txt
 *
 *   File > New > New Project, then:
 *   osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile "<path>/verify_mograph_path.jsx"'
 */
(function () {
    var dir = new Folder(Folder.userData.fsName + "/Feugee");
    if (!dir.exists) dir.create();
    var report = new File(dir.fsName + "/mograph-path-verify.txt");
    var lines = [];
    var fails = 0;
    var skipped = false;
    function log(s) { lines.push(s); }
    function check(name, cond, extra) {
        if (!cond) fails++;
        log((cond ? "PASS  " : "FAIL  ") + name + (extra ? "   [" + extra + "]" : ""));
    }
    function flush() {
        report.encoding = "UTF-8";
        report.lineFeed = "Unix";
        report.open("w");
        var verdict = "ALL PASSED";
        if (skipped) verdict = "NOT RUN";
        else if (fails) verdict = fails + " FAILED";
        report.write(lines.join("\n") + "\n" + verdict + "\n");
        report.close();
    }

    if (app.project.file) {
        skipped = true;
        log("SKIP  this project is saved on disk - open File > New > New Project first");
        flush();
        return;
    }

    $.evalFile(new File(new File($.fileName).parent.parent.parent.fsName + "/Feugee_Mograph_CEP/jsx/host.jsx"));

    var existing = {};
    for (var e0 = 1; e0 <= app.project.numItems; e0++) existing[app.project.item(e0).id] = true;
    var engine0 = app.project.expressionEngine;

    function select(comp, layers) {
        for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        for (var j = 0; j < layers.length; j++) layers[j].selected = true;
    }
    function shape(verts, closed) {
        var s = new Shape();
        s.vertices = verts;
        s.closed = !!closed;
        return s;
    }
    function ctrlOf(comp) {
        for (var i = 1; i <= comp.numLayers; i++) if (/^FGM\|path\|/.test(comp.layer(i).comment)) return comp.layer(i);
        return null;
    }
    function clones(comp, ctrl) {
        var id = ctrl.comment.split("|")[2], out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var p = comp.layer(i).property("ADBE Effect Parade");
            for (var k = 1; k <= p.numProperties; k++) if (p.property(k).name === "FGM Link " + id) { out.push(comp.layer(i)); break; }
        }
        return out;
    }
    function pos(l, t) { return l.property("ADBE Transform Group").property("ADBE Position").valueAtTime(t || 0, false); }
    function rot(l, t) { return l.property("ADBE Transform Group").property("ADBE Rotate Z").valueAtTime(t || 0, false); }
    function exprErr(layers) {
        for (var i = 0; i < layers.length; i++) {
            var p = layers[i].property("ADBE Transform Group").property("ADBE Position");
            if (p.expressionError) return layers[i].name + ": " + p.expressionError;
            if (!p.expressionEnabled) return layers[i].name + ": expression disabled";
        }
        return "";
    }
    function near(a, b) { return Math.abs(a - b) < 0.6; }
    function fmt(list) {
        var o = [];
        for (var i = 0; i < list.length; i++) o.push("[" + Math.round(list[i][0]) + "," + Math.round(list[i][1]) + "]");
        return o.join(" ");
    }
    function setCtrlPath(ctrl, s) {
        ctrl.property("ADBE Root Vectors Group").property("Path").property("ADBE Vectors Group").property(1).property("ADBE Vector Shape").setValue(s);
    }
    function fx(ctrl, name, v) { ctrl.property("ADBE Effect Parade").property(name).property(1).setValue(v); }
    function expectXY(label, layers, want, t) {
        var got = [], ok = layers.length === want.length;
        for (var i = 0; i < layers.length; i++) {
            var p = pos(layers[i], t);
            got.push(p);
            if (!want[i] || !near(p[0], want[i][0]) || !near(p[1], want[i][1])) ok = false;
        }
        check(label, ok, "got " + fmt(got) + " want " + fmt(want) + " " + exprErr(layers));
    }

    function suite(engine) {
        app.project.expressionEngine = engine;
        log("--- engine: " + engine);

        var comp = app.project.items.addComp("FGM path verify " + engine, 1000, 1000, 1, 4, 25);
        var dot = comp.layers.addSolid([1, 0.4, 0.1], "Dot", 40, 40, 1, 4);
        dot.property("ADBE Transform Group").property("ADBE Position").setValue([500, 500]);

        // 1. create: 5 clones, controller is a guide shape layer at the centroid
        comp.openInViewer();
        select(comp, [dot]);
        var r1 = FG_MOGRAPH.create("path", 5, "", 0, 0);
        quiet.openInViewer(); // never sample what the viewer is rendering
        var ctrl = ctrlOf(comp);
        check("create path cloner", r1.indexOf("OK|") === 0 && !!ctrl, r1);
        if (!ctrl) return;
        check("controller is a guide shape layer", ctrl.matchName === "ADBE Vector Layer" && ctrl.guideLayer);
        var kids = clones(comp, ctrl);
        check("5 clones linked", kids.length === 5, kids.length);
        check("default curve evaluates", exprErr(kids) === "", exprErr(kids));

        // 2. straight line -> evenly spaced, rotation 0
        setCtrlPath(ctrl, shape([[-400, 0], [400, 0]]));
        expectXY("straight line spacing", kids, [[100, 500], [300, 500], [500, 500], [700, 500], [900, 500]]);
        check("align to path on a horizontal line = 0 deg", near(rot(kids[1]), 0), rot(kids[1]));

        // 3. uneven vertices: still spaced by length, not by vertex
        setCtrlPath(ctrl, shape([[-400, 0], [-300, 0], [400, 0]]));
        expectXY("spacing follows length", kids, [[100, 500], [300, 500], [500, 500], [700, 500], [900, 500]]);

        // 4. vertical line -> 90 deg
        setCtrlPath(ctrl, shape([[0, -400], [0, 400]]));
        check("align to a downward path = 90 deg", near(rot(kids[2]), 90), rot(kids[2]));
        fx(ctrl, "Align to Path", 0);
        check("Align to Path off = 0 deg", near(rot(kids[2]), 0), rot(kids[2]));
        fx(ctrl, "Align to Path", 1);

        // 5. group transform is applied once
        setCtrlPath(ctrl, shape([[-400, 0], [400, 0]]));
        var gxf = ctrl.property("ADBE Root Vectors Group").property("Path").property("ADBE Vector Transform Group");
        gxf.property("ADBE Vector Position").setValue([0, 100]);
        gxf.property("ADBE Vector Rotation").setValue(90);
        expectXY("group position + rotation", kids, [[500, 200], [500, 400], [500, 600], [500, 800], [500, 1000]]);
        check("group rotation reaches clone rotation", near(rot(kids[0]), 90), rot(kids[0]));
        gxf.property("ADBE Vector Position").setValue([0, 0]);
        gxf.property("ADBE Vector Rotation").setValue(0);

        // 6. start / end / offset / loop
        fx(ctrl, "Start", 25); fx(ctrl, "End", 75);
        expectXY("start 25 end 75", kids, [[300, 500], [400, 500], [500, 500], [600, 500], [700, 500]]);
        fx(ctrl, "Start", 0); fx(ctrl, "End", 100);
        fx(ctrl, "Offset", 50);
        expectXY("offset 50 with loop wraps", kids, [[500, 500], [700, 500], [900, 500], [300, 500], [500, 500]]);
        fx(ctrl, "Loop Offset", 0);
        expectXY("offset 50 without loop clamps", kids, [[500, 500], [700, 500], [900, 500], [900, 500], [900, 500]]);
        fx(ctrl, "Loop Offset", 1); fx(ctrl, "Offset", 0);
        fx(ctrl, "Reverse Layer Order", 1);
        expectXY("reverse layer order", kids, [[900, 500], [700, 500], [500, 500], [300, 500], [100, 500]]);
        fx(ctrl, "Reverse Layer Order", 0);

        // 7. closed square: 4 clones do not stack on the start point
        var sq = shape([[-200, -200], [200, -200], [200, 200], [-200, 200]], true);
        setCtrlPath(ctrl, sq);
        // 5 clones on a closed 1600 px loop -> 320 px apart, the 5th not on the 1st
        expectXY("closed path spreads evenly", kids, [[300, 300], [620, 300], [700, 540], [540, 700], [300, 620]]);

        // 8. a newer path on top (what the Pen tool adds) takes over
        setCtrlPath(ctrl, shape([[-400, 0], [400, 0]]));
        var root = ctrl.property("ADBE Root Vectors Group");
        root.addProperty("ADBE Vector Group");
        var gi = root.numProperties;
        root.property(gi).name = "Shape 1";
        root.property(gi).property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");
        ctrl.property("ADBE Root Vectors Group").property(gi).property("ADBE Vectors Group").property(1)
            .property("ADBE Vector Shape").setValue(shape([[0, -400], [0, 400]]));
        ctrl.property("ADBE Root Vectors Group").property(gi).moveTo(1);
        expectXY("top path wins (pen tool)", kids, [[500, 100], [500, 300], [500, 500], [500, 700], [500, 900]]);

        // 9. animate the controller: clones follow in world space
        ctrl.property("ADBE Transform Group").property("ADBE Position").setValue([600, 500]);
        expectXY("controller move", kids, [[600, 100], [600, 300], [600, 500], [600, 700], [600, 900]]);

        // 10. a drawn path picked as the source; its layer is not cloned
        var comp2 = app.project.items.addComp("FGM path source " + engine, 1000, 1000, 1, 4, 25);
        comp2.openInViewer();
        var guide = comp2.layers.addShape();
        guide.name = "Guide";
        guide.property("ADBE Transform Group").property("ADBE Position").setValue([200, 300]);
        var gr = guide.property("ADBE Root Vectors Group");
        gr.addProperty("ADBE Vector Group");
        gr.property(1).property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");
        gr = guide.property("ADBE Root Vectors Group");
        gr.property(1).property("ADBE Vectors Group").property(1).property("ADBE Vector Shape").setValue(shape([[0, 0], [400, 0]]));
        guide.property("ADBE Root Vectors Group").property(1).property("ADBE Vector Transform Group").property("ADBE Vector Position").setValue([0, 50]);
        var box = comp2.layers.addSolid([0, 0.6, 1], "Box", 30, 30, 1, 4);
        select(comp2, [box]);
        guide.property("ADBE Root Vectors Group").property(1).property("ADBE Vectors Group").property(1).selected = true;
        var r10 = FG_MOGRAPH.create("path", 3, "", 0, 0);
        quiet.openInViewer();
        var ctrl2 = ctrlOf(comp2);
        check("create from a selected path", r10.indexOf("OK|") === 0 && !!ctrl2 && /copied from Guide/.test(r10), r10);
        if (ctrl2) {
            var kids2 = clones(comp2, ctrl2);
            check("3 clones", kids2.length === 3, kids2.length);
            var guideLinked = false;
            for (var g = 0; g < kids2.length; g++) if (kids2[g].name === "Guide") guideLinked = true;
            check("Guide has no link", !guideLinked);
            expectXY("clones sit on the drawn path", kids2, [[200, 350], [400, 350], [600, 350]]);
            // viewer back on comp2: bake parks it itself
            comp2.openInViewer();
            select(comp2, [ctrl2]);
            var rb = FG_MOGRAPH.bake(true);
            check("bake path rig", rb.indexOf("OK|") === 0, rb);
        }
        FG_MOGRAPH.scan();
    }

    var quiet = null;
    try {
        quiet = app.project.items.addComp("FGM verify quiet", 16, 16, 1, 1, 25);
        suite("javascript-1.0");
        suite("extendscript");
    } catch (err) {
        fails++;
        log("CRASH " + err.toString() + " line " + err.line);
    } finally {
        try { app.project.expressionEngine = engine0; } catch (e1) {}
        var removed = 0;
        for (var pass = 0; pass < 2; pass++) {
            for (var k = app.project.numItems; k >= 1; k--) {
                var it = app.project.item(k);
                if (existing[it.id]) continue;
                if ((pass === 0) !== (it instanceof CompItem)) continue;
                try { it.remove(); removed++; } catch (e2) {}
            }
        }
        log("cleanup: removed " + removed + " scratch items");
        flush();
    }
})();
