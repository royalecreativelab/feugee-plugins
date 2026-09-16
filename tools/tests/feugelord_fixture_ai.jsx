/**
 * Feugelord - Illustrator fixture: one document holding every phase-1 case.
 * Saves feugelord-fixture.ai and the artboard as fixture-ai.png (ground truth)
 * into ~/Library/Application Support/Feugee/feugelord-test/.
 */
(function () {
    function rgb(r, g, b) { var c = new RGBColor(); c.red = r; c.green = g; c.blue = b; return c; }
    var dir = Folder.userData.fsName + "/Feugee/feugelord-test/";
    new Folder(dir).create();
    var doc = app.documents.add(DocumentColorSpace.RGB, 800, 600);
    doc.artboards[0].name = "Fixture";
    var L = doc.artboards[0].artboardRect[0], T = doc.artboards[0].artboardRect[1];
    function Y(y) { return T - y; }
    var bg = doc.pathItems.rectangle(Y(0), L, 800, 600); bg.filled = true; bg.fillColor = rgb(255, 255, 255); bg.stroked = false; bg.name = "bg";
    var r = doc.pathItems.rectangle(Y(40), L + 40, 200, 120); r.name = "rect dashed";
    r.filled = true; r.fillColor = rgb(242, 99, 28); r.stroked = true; r.strokeColor = rgb(20, 20, 20); r.strokeWidth = 8;
    r.strokeDashes = [24, 10]; r.strokeCap = StrokeCap.ROUNDENDCAP; r.strokeJoin = StrokeJoin.ROUNDENDJOIN;
    var e = doc.pathItems.ellipse(Y(40), L + 300, 160, 160); e.name = "ellipse"; e.filled = true; e.fillColor = rgb(96, 180, 226); e.stroked = false;
    var st = doc.pathItems.star(L + 600, Y(120), 80, 35, 5); st.name = "star bevel"; st.filled = false; st.stroked = true;
    st.strokeColor = rgb(40, 160, 90); st.strokeWidth = 10; st.strokeJoin = StrokeJoin.BEVELENDJOIN;
    var open = doc.pathItems.add(); open.name = "open curve";
    open.setEntirePath([[L + 60, Y(300)], [L + 200, Y(240)], [L + 340, Y(330)]]);
    open.pathPoints[1].leftDirection = [L + 140, Y(200)]; open.pathPoints[1].rightDirection = [L + 260, Y(280)];
    open.pathPoints[1].pointType = PointType.SMOOTH;
    open.filled = false; open.stroked = true; open.strokeColor = rgb(120, 60, 200); open.strokeWidth = 12; open.strokeCap = StrokeCap.ROUNDENDCAP;
    var cp = doc.compoundPathItems.add(); cp.name = "donut";
    var outer = cp.pathItems.ellipse(Y(220), L + 420, 180, 180);
    cp.pathItems.ellipse(Y(270), L + 470, 80, 80);
    outer.filled = true; outer.fillColor = rgb(230, 60, 60); outer.stroked = false; outer.evenodd = true;
    var cm = new CMYKColor(); cm.cyan = 0; cm.magenta = 50; cm.yellow = 100; cm.black = 0;
    var grp = doc.groupItems.add(); grp.name = "half group"; grp.opacity = 50;
    var g1 = grp.pathItems.rectangle(Y(420), L + 60, 120, 120); g1.filled = true; g1.fillColor = cm; g1.stroked = false; g1.name = "cmyk square";
    var sub = grp.groupItems.add(); sub.name = "nested";
    var g2 = sub.pathItems.rectangle(Y(460), L + 120, 120, 120); g2.filled = true; g2.fillColor = rgb(20, 20, 60); g2.stroked = false;
    var gray = new GrayColor(); gray.gray = 40;
    var tri = doc.pathItems.add(); tri.setEntirePath([[L + 360, Y(560)], [L + 460, Y(420)], [L + 560, Y(560)]]); tri.closed = true;
    tri.filled = true; tri.fillColor = gray; tri.stroked = false; tri.name = "gray triangle";
    var tf = doc.textFrames.add(); tf.contents = "Feugee"; tf.left = L + 600; tf.top = Y(420);
    tf.textRange.characterAttributes.size = 64; tf.textRange.characterAttributes.fillColor = rgb(242, 99, 28); tf.name = "wordmark";
    var hidden = doc.pathItems.rectangle(Y(500), L + 650, 50, 50); hidden.hidden = true; hidden.name = "hidden";
    doc.saveAs(new File(dir + "feugelord-fixture.ai"));
    var opt = new ExportOptionsPNG24(); opt.artBoardClipping = true; opt.antiAliasing = true; opt.transparency = false;
    doc.exportFile(new File(dir + "fixture-ai.png"), ExportType.PNG24, opt);
    return "OK|fixture: " + doc.pageItems.length + " page items";
})();
