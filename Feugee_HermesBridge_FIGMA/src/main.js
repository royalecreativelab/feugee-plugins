/* Feugee Hermes Bridge (Figma) - plugin sandbox.
   Receives jobs from the UI iframe (which long-polls the local relay) and runs
   them with the full desktop Plugin API: local fonts, createImage, exportAsync. */

var VERSION = "/*@VERSION*/";
var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

figma.showUI(__html__, { width: 340, height: 460, themeColors: true, title: "Feugee Hermes Bridge" });

function info() {
  var u = null;
  try { u = figma.currentUser; } catch (e) { u = null; } // needs "currentuser" permission; never fatal
  return {
    fileKey: figma.fileKey || null,
    fileName: figma.root.name,
    page: figma.currentPage ? figma.currentPage.name : null,
    pageId: figma.currentPage ? figma.currentPage.id : null,
    user: u ? u.name : null,
    editorType: figma.editorType,
    version: VERSION
  };
}
function pushInfo() { figma.ui.postMessage({ type: "info", info: info() }); }
figma.on("currentpagechange", pushInfo);
pushInfo();

// JSON-safe return values: nodes -> {id,name,type}, figma.mixed -> "mixed", bytes -> length.
function serialize(value) {
  var seen = [];
  var s = JSON.stringify(value === undefined ? null : value, function (k, v) {
    if (v === figma.mixed) return "mixed";
    if (typeof v === "symbol") return String(v);
    if (typeof v === "bigint") return Number(v);
    if (v instanceof Uint8Array) return "<" + v.length + " bytes>";
    if (v && typeof v === "object") {
      if (typeof v.id === "string" && typeof v.type === "string" && "parent" in v && k !== "") {
        return { id: v.id, name: v.name, type: v.type };
      }
      if (k === "" && typeof v.id === "string" && typeof v.type === "string" && "parent" in v) {
        return { id: v.id, name: v.name, type: v.type };
      }
      if (seen.indexOf(v) >= 0) return "<circular>";
      seen.push(v);
    }
    return v;
  });
  if (s && s.length > 200000) s = JSON.stringify({ truncated: true, length: s.length, head: s.slice(0, 200000) });
  return s === undefined ? "null" : s;
}

function compile(code) {
  try { return new AsyncFunction("figma", code); }
  catch (e1) {
    if (e1 instanceof SyntaxError) throw e1;
    // Some sandboxes block the Function constructor but allow eval.
    return eval("(async function (figma) {\n" + code + "\n})");
  }
}

async function nodeById(id) {
  var n = await figma.getNodeByIdAsync(String(id).replace("-", ":"));
  if (!n) throw new Error("node " + id + " tidak ditemukan di file ini");
  return n;
}

var HANDLERS = {
  use_figma: async function (a) {
    var fn = compile(String(a.code || ""));
    var out = await fn(figma);
    figma.commitUndo();
    return { json: serialize(out) };
  },

  get_screenshot: async function (a) {
    var n = await nodeById(a.nodeId);
    if (!("exportAsync" in n)) throw new Error("node " + a.nodeId + " tidak bisa di-export (" + n.type + ")");
    var fmt = a.format || "PNG";
    var opts = { format: fmt };
    var w = n.width || 1, h = n.height || 1;
    if (fmt === "PNG" || fmt === "JPG") {
      var max = Math.max(16, Math.min(Number(a.maxDimension) || 1600, 16384));
      opts.constraint = w >= h ? { type: "WIDTH", value: Math.round(Math.min(max, w * 4)) } : { type: "HEIGHT", value: Math.round(Math.min(max, h * 4)) };
    }
    var bytes = await n.exportAsync(opts);
    var scale = opts.constraint ? (opts.constraint.type === "WIDTH" ? opts.constraint.value / w : opts.constraint.value / h) : 1;
    return {
      result: { nodeId: n.id, name: n.name, format: fmt, width: Math.round(w * scale), height: Math.round(h * scale), original_width: Math.round(w), original_height: Math.round(h) },
      shot: { data: figma.base64Encode(bytes), format: fmt, name: n.name }
    };
  },

  place_image: async function (a) {
    var n = await nodeById(a.nodeId);
    if (!("fills" in n)) throw new Error("node " + a.nodeId + " tidak punya fills");
    var img = figma.createImage(figma.base64Decode(a.data));
    var size = await img.getSizeAsync();
    n.fills = [{ type: "IMAGE", imageHash: img.hash, scaleMode: a.scaleMode || "FILL" }];
    figma.commitUndo();
    return { result: { nodeId: n.id, imageHash: img.hash, imageWidth: size.width, imageHeight: size.height } };
  },

  import_svg: async function (a) {
    if (!a.svg) throw new Error("SVG kosong");
    var node = figma.createNodeFromSvg(a.svg);
    var parent = a.parentId ? await nodeById(a.parentId) : figma.currentPage;
    parent.appendChild(node);
    if (typeof a.x === "number") node.x = a.x;
    if (typeof a.y === "number") node.y = a.y;
    if (a.name) node.name = a.name;
    figma.commitUndo();
    return { result: { id: node.id, name: node.name, type: node.type, width: node.width, height: node.height } };
  },

  list_fonts: async function (a) {
    var q = String(a.query || "").toLowerCase();
    var fam = {};
    (await figma.listAvailableFontsAsync()).forEach(function (f) {
      var k = f.fontName.family;
      if (q && k.toLowerCase().indexOf(q) < 0) return;
      (fam[k] = fam[k] || []).push(f.fontName.style);
    });
    var keys = Object.keys(fam).sort();
    return { result: { count: keys.length, families: keys.slice(0, 300).map(function (k) { return { family: k, styles: fam[k] }; }) } };
  }
};

figma.ui.onmessage = async function (msg) {
  if (!msg) return;
  if (msg.type === "hello") return pushInfo();
  if (msg.type === "notify") return figma.notify(String(msg.text || ""), { timeout: 2500 });
  if (msg.type !== "job") return;
  var job = msg.job, t0 = Date.now();
  var reply = { type: "result", id: job.id, tool: job.tool, file: figma.root.name };
  try {
    var h = HANDLERS[job.tool];
    if (!h) throw new Error("tool tidak dikenal: " + job.tool);
    var r = await h(job.args || {});
    if (r.json !== undefined) reply.resultJson = r.json; else reply.result = r.result;
    if (r.shot) reply.shot = r.shot;
    reply.ok = true;
  } catch (e) {
    reply.ok = false;
    reply.error = (e && e.message ? e.message : String(e)) + (e && e.stack ? "\n" + String(e.stack).split("\n").slice(0, 4).join("\n") : "");
  }
  reply.ms = Date.now() - t0;
  figma.ui.postMessage(reply);
};

figma.on("close", function () { figma.ui.postMessage({ type: "closing" }); });
