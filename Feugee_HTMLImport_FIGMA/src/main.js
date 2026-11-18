/* =========================================================
   FEUGEE HTML IMPORT - main.js (plugin controller, sandbox side)
   Owns: window, persistence, selection state, building + placing.
   ========================================================= */
(function () {
  "use strict";

  var PD_KEY = "feugee.htmlimport";
  var UI_W = 380, UI_H = 680;

  figma.showUI(__html__, { width: UI_W, height: UI_H, title: "Feugee HTML Import", themeColors: true });

  function post(msg) { figma.ui.postMessage(msg); }

  function selectionInfo() {
    var sel = figma.currentPage.selection;
    if (sel.length !== 1) return { type: "selection", source: null };
    var raw = "";
    try { raw = sel[0].getPluginData(PD_KEY); } catch (e) {}
    if (!raw) return { type: "selection", source: null, name: sel[0].name };
    try { return { type: "selection", source: JSON.parse(raw), name: sel[0].name, id: sel[0].id }; }
    catch (e) { return { type: "selection", source: null }; }
  }

  figma.on("selectionchange", function () { post(selectionInfo()); });

  // place new imports to the right of everything on the page, top-aligned
  function freeSpot() {
    var kids = figma.currentPage.children, maxX = null, minY = null;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (!("x" in k)) continue;
      var r = k.x + k.width;
      if (maxX === null || r > maxX) maxX = r;
      if (minY === null || k.y < minY) minY = k.y;
    }
    if (maxX === null) {
      var c = figma.viewport.center;
      return { x: Math.round(c.x), y: Math.round(c.y) };
    }
    return { x: Math.round(maxX + 200), y: Math.round(minY || 0) };
  }

  async function runBuild(msg) {
    var docs = msg.docs || [];
    var assets = msg.assets || {};
    var spot = freeSpot();
    var replaced = null;
    if (msg.replaceId) {
      replaced = await figma.getNodeByIdAsync(msg.replaceId);
      if (replaced && "x" in replaced) spot = { x: replaced.x, y: replaced.y };
    }
    var roots = [], all = [];
    var x = spot.x;
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var st = await FeugeeBuild.build(d, assets, {
        x: x, y: spot.y,
        name: d.title + " \u00b7 " + d.label,
        onProgress: function (done, total, label) {
          post({ type: "progress", index: i, count: docs.length, done: done, total: total, label: label });
        }
      });
      var root = st.root;
      delete st.root;
      try {
        root.setPluginData(PD_KEY, JSON.stringify(msg.source ? Object.assign({}, msg.source, { viewport: d.label }) : {}));
        root.setRelaunchData({ reimport: "Re-import " + (msg.source && msg.source.label ? msg.source.label : "this page") });
      } catch (e) {}
      x += root.width + 120;
      roots.push(root);
      st.label = d.label;
      all.push(st);
    }
    if (replaced && !replaced.removed) { try { replaced.remove(); } catch (e) {} }
    figma.currentPage.selection = roots;
    figma.viewport.scrollAndZoomIntoView(roots);
    post({ type: "done", stats: all });
    figma.notify("Feugee: imported " + roots.length + " frame" + (roots.length > 1 ? "s" : ""), { timeout: 2500 });
  }

  figma.ui.onmessage = async function (msg) {
    if (!msg || !msg.type) return;
    try {
      if (msg.type === "init") {
        var theme = await figma.clientStorage.getAsync("feugee.theme");
        var settings = await figma.clientStorage.getAsync("feugee.htmlimport.settings");
        var size = await figma.clientStorage.getAsync("feugee.htmlimport.size");
        if (size && size.w && size.h) figma.ui.resize(size.w, size.h);
        post({ type: "init", theme: theme || null, settings: settings || null, command: figma.command || "" });
        post(selectionInfo());
        figma.listAvailableFontsAsync().then(function (list) {
          var fams = {};
          list.forEach(function (f) { fams[f.fontName.family] = 1; });
          post({ type: "fonts", families: Object.keys(fams) });
        }, function () {});
      } else if (msg.type === "theme") {
        await figma.clientStorage.setAsync("feugee.theme", msg.theme);
      } else if (msg.type === "settings") {
        await figma.clientStorage.setAsync("feugee.htmlimport.settings", msg.settings);
      } else if (msg.type === "resize") {
        var w = Math.max(300, Math.min(1400, Math.round(msg.w))), h = Math.max(360, Math.min(1400, Math.round(msg.h)));
        figma.ui.resize(w, h);
        if (msg.save) await figma.clientStorage.setAsync("feugee.htmlimport.size", { w: w, h: h });
      } else if (msg.type === "build") {
        await runBuild(msg);
      } else if (msg.type === "open") {
        figma.openExternal(msg.url);
      } else if (msg.type === "notify") {
        figma.notify(String(msg.text || ""), { error: !!msg.error, timeout: 3000 });
      } else if (msg.type === "focus") {
        var n = await figma.getNodeByIdAsync(msg.id);
        if (n) { figma.currentPage.selection = [n]; figma.viewport.scrollAndZoomIntoView([n]); }
      }
    } catch (e) {
      post({ type: "error", message: e && e.message ? e.message : String(e) });
    }
  };
})();
