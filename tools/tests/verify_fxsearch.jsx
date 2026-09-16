/**
 * FX Search - live verification inside After Effects.
 *
 * Runs the real FG_FXS.apply() against a scratch comp and checks the result
 * with the AE API. Refuses to run in a project that has ever been saved, so it
 * can never touch real work, and removes every item it created afterwards -
 * whatever was already in the scratch project stays as it was. Writes its report next to the data file:
 *   ~/Library/Application Support/Feugee/fxsearch-verify.txt
 *
 *   File > New > New Project, then run it REPEATEDLY until the report ends in
 *   ALL PASSED / FAILED. saveFrameToPng only renders after a script returns,
 *   so the snapshot check needs later calls: while a state file exists, each
 *   run polls FG_FXS.snapshotStatus() once, then cleans up.
 *   osascript -e 'tell application "Adobe After Effects 2026" to DoScriptFile "<path>/verify_fxsearch.jsx"'
 */
(function () {
    var report = new File(Folder.userData.fsName + "/Feugee/fxsearch-verify.txt");
    var state = new File(Folder.userData.fsName + "/Feugee/fxsearch-verify.state");
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
        // if/else, not a chained ternary - ExtendScript read the old one as
        // (skipped ? "NOT RUN" : fails) ? ..., so a skipped run said "0 FAILED".
        var verdict = "ALL PASSED";
        if (skipped) verdict = "NOT RUN";
        else if (fails) verdict = fails + " FAILED";
        report.write(lines.join("\n") + "\n" + verdict + "\n");
        report.close();
    }

    function readAll(f) { f.encoding = "UTF-8"; f.open("r"); var t = f.read(); f.close(); return t; }
    function cleanup(existing) {
        var removed = 0;
        for (var pass = 0; pass < 2; pass++) {
            for (var k = app.project.numItems; k >= 1; k--) {
                var it = app.project.item(k);
                if (existing[it.id]) continue;
                if ((pass === 0) !== (it instanceof CompItem)) continue;
                if (it instanceof FolderItem && it.numItems > 0) continue;
                try { it.remove(); removed++; } catch (e2) {}
            }
        }
        return "cleanup: removed " + removed + " scratch items, " + app.project.numItems + " items left";
    }

    if (state.exists) {
        // FINISH PHASE: one poll per run
        var st = readAll(state).split("\n");      // path, tries, ids, report so far
        var path = st[0], tries = Number(st[1]) + 1, ids = st[2].split(","), prior = st.slice(3).join("\n");
        $.evalFile(new File(Folder.userData.fsName + "/Adobe/CEP/extensions/com.feugee.fxsearch/jsx/host.jsx"));
        var sres = FG_FXS.snapshotStatus(path, false);
        if (sres.indexOf("WAIT|") === 0 && tries < 60) {
            state.open("w"); state.write([path, tries, ids.join(","), prior].join("\n")); state.close();
            report.encoding = "UTF-8"; report.open("w"); report.write(prior + "\nPENDING snapshot poll " + tries + "\n"); report.close();
            return;
        }
        var existing2 = {};
        for (var q = 0; q < ids.length; q++) if (ids[q]) existing2[ids[q]] = true;
        lines = prior ? prior.split("\n") : [];
        fails = 0;
        for (var li = 0; li < lines.length; li++) if (lines[li].indexOf("FAIL") === 0 || lines[li].indexOf("CRASH") === 0) fails++;
        var snapFile = new File(path);
        check("snapshot rendered after the script returned", sres.indexOf("OK|Saved") === 0 && snapFile.exists && snapFile.length > 0,
              sres + " after " + tries + " polls, " + (snapFile.exists ? snapFile.length + " bytes" : "no file"));
        if (snapFile.exists) snapFile.remove();
        log(cleanup(existing2));
        state.remove();
        flush();
        return;
    }

    if (app.project.file) {
        skipped = true;
        log("SKIP  this project is saved on disk - open File > New > New Project first");
        flush();
        return;
    }

    var host = new File(Folder.userData.fsName + "/Adobe/CEP/extensions/com.feugee.fxsearch/jsx/host.jsx");
    $.evalFile(host);

    function fxNames(layer) {
        var p = layer.property("ADBE Effect Parade"), out = [];
        for (var i = 1; i <= p.numProperties; i++) out.push(p.property(i).matchName);
        return out.join(",");
    }
    function select(comp, layers) {
        for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        for (var j = 0; j < layers.length; j++) layers[j].selected = true;
    }

    var existing = {};
    for (var e0 = 1; e0 <= app.project.numItems; e0++) existing[app.project.item(e0).id] = true;

    try {
        var comp = app.project.items.addComp("FXS verify", 1920, 1080, 1, 10, 25);
        comp.openInViewer();
        var a = comp.layers.addSolid([1, 0, 0], "A", 1920, 1080, 1, 10);
        var b = comp.layers.addSolid([0, 1, 0], "B", 1920, 1080, 1, 10);
        b.inPoint = 2; b.outPoint = 6;
        var cam = comp.layers.addCamera("Cam", [960, 540]);
        var c = comp.layers.addSolid([0, 0, 1], "C", 1920, 1080, 1, 10);   // index 1 now
        // order top->bottom: C(1) Cam(2) B(3) A(4)

        // 1. multi-layer effect, camera skipped
        select(comp, [a, b, cam]);
        var r1 = FG_FXS.apply("fx", "ADBE Gaussian Blur 2", "sel", "", "Gaussian Blur");
        check("fx on 3 selected (1 camera)", r1.indexOf("OK|") === 0 && /2 of 3/.test(r1), r1);
        check("A got blur", fxNames(a) === "ADBE Gaussian Blur 2", fxNames(a));
        check("B got blur", fxNames(b) === "ADBE Gaussian Blur 2", fxNames(b));
        check("layer selection untouched", a.selected && b.selected && cam.selected);

        // 2. insert below the selected effect: A = [Blur, Fill], select Blur, add Tint
        select(comp, [a]);
        FG_FXS.apply("fx", "ADBE Fill", "sel", "", "Fill");
        var pa = a.property("ADBE Effect Parade");
        for (var i = 1; i <= pa.numProperties; i++) pa.property(i).selected = (i === 1);
        var r2 = FG_FXS.apply("fx", "ADBE Tint", "sel", "B", "Tint");
        check("insert below selected", fxNames(a) === "ADBE Gaussian Blur 2,ADBE Tint,ADBE Fill", fxNames(a) + " " + r2);
        check("new effect takes the effect selection", a.property("ADBE Effect Parade").property(2).selected &&
              !a.property("ADBE Effect Parade").property(1).selected);

        // 3. stacking keeps going below the previous one
        FG_FXS.apply("fx", "ADBE Glo2", "sel", "B", "Glow");
        check("stack lands under last added", fxNames(a) === "ADBE Gaussian Blur 2,ADBE Tint,ADBE Glo2,ADBE Fill", fxNames(a));

        // 4. adjustment layer above the top-most selected, spanning their time
        var n = comp.numLayers;
        select(comp, [a, b]);
        var r4 = FG_FXS.apply("fx", "ADBE Gaussian Blur 2", "adj", "", "Gaussian Blur");
        var adj = comp.selectedLayers.length === 1 ? comp.selectedLayers[0] : null;
        check("adj created", r4.indexOf("OK|") === 0 && comp.numLayers === n + 1 && adj && adj.adjustmentLayer, r4);
        check("adj sits right above B", adj && adj.index === b.index - 1, adj ? adj.index + " vs B " + b.index : "");
        check("adj spans A+B time", adj && adj.inPoint === 0 && Math.abs(adj.outPoint - 10) < 0.001,
              adj ? adj.inPoint + "-" + adj.outPoint : "");
        check("adj carries the effect", adj && fxNames(adj) === "ADBE Gaussian Blur 2");

        // 5. no selection
        select(comp, []);
        var r5 = FG_FXS.apply("fx", "ADBE Fill", "sel", "", "Fill");
        check("no selection without A = error", r5.indexOf("ERR|") === 0, r5);
        n = comp.numLayers;
        var r6 = FG_FXS.apply("fx", "ADBE Fill", "sel", "A", "Fill");
        check("no selection with A = adjustment layer", r6.indexOf("OK|") === 0 && comp.numLayers === n + 1, r6);

        // 6. locked layer
        c.locked = true;
        select(comp, [c]);
        var r7 = FG_FXS.apply("fx", "ADBE Fill", "sel", "", "Fill");
        check("locked layer reported", r7.indexOf("ERR|") === 0 && /locked/.test(r7), r7);
        c.locked = false;

        // 7. audio effect on a solid
        select(comp, [c]);
        var r8 = FG_FXS.apply("fx", "ADBE Aud Reverb", "sel", "", "Reverb");
        check("effect the layer can't take", r8.indexOf("ERR|") === 0, r8);

        // 8. preset on two layers, selection restored
        var presetFile = null;
        var pdir = new Folder(Folder.appPackage.parent.fsName + "/Presets/Image - Creative");
        var ffx = pdir.exists ? pdir.getFiles("*.ffx") : [];
        if (ffx.length) presetFile = ffx[0];
        if (presetFile) {
            var ca = a.property("ADBE Effect Parade").numProperties;
            var cc = c.property("ADBE Effect Parade").numProperties;
            select(comp, [a, c]);
            var r9 = FG_FXS.apply("preset", presetFile.fsName, "sel", "", presetFile.displayName);
            check("preset on 2 layers", r9.indexOf("OK|") === 0 && /2 layers/.test(r9), r9);
            check("both layers changed", a.property("ADBE Effect Parade").numProperties > ca &&
                  c.property("ADBE Effect Parade").numProperties > cc);
            check("selection restored after preset", a.selected && c.selected && comp.selectedLayers.length === 2);
        } else {
            log("SKIP  no preset found for the preset test");
        }

        // 9. missing preset
        var r10 = FG_FXS.apply("preset", "/nope/gone.ffx", "sel", "", "Gone");
        check("missing preset = error", r10.indexOf("ERR|") === 0, r10);

        // 10. snapshot - only starts here, finished by the next runs
        comp.time = 1;
        var r11 = FG_FXS.snapshot();
        check("snapshot render started", r11.indexOf("OK|/") === 0, r11);
        if (r11.indexOf("OK|") === 0) {
            var idList = [];
            for (var id in existing) idList.push(id);
            state.encoding = "UTF-8"; state.lineFeed = "Unix"; state.open("w");
            state.write([r11.substring(3), 0, idList.join(","), lines.join("\n")].join("\n"));
            state.close();
            report.encoding = "UTF-8"; report.open("w"); report.write(lines.join("\n") + "\nPENDING snapshot\n"); report.close();
            return;
        }
    } catch (e) {
        fails++;
        log("CRASH " + e.toString() + " line " + e.line);
    }

    log(cleanup(existing));
    flush();
})();
