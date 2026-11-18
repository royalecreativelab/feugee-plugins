#!/usr/bin/env node
/* Compose a use_figma script: the real builder.js + one captured doc from
   tests/out/payload*.json. Lets the Figma half be verified in a real Figma
   file without installing the plugin. Output: tests/out/figma-run.js */
"use strict";
const fs = require("fs");
const path = require("path");

const which = process.argv[2] || "payload.json";
const docIndex = +(process.argv[3] || 0);
const xOff = +(process.argv[4] || 0);
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "out", which), "utf8"));
const doc = payload.docs[docIndex];

// assets this doc actually uses
const used = new Set();
(function walk(n) {
  (n.fills || []).forEach((p) => { if (p.k === "img") used.add(p.key); });
  if (n.img) used.add(n.img);
  (n.kids || []).forEach(walk);
})(doc.root);
const assets = {};
used.forEach((k) => { if (payload.assets[k]) assets[k] = payload.assets[k]; });

const builder = fs.readFileSync(path.join(__dirname, "..", "src", "builder.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((l) => l.replace(/^\s+/, "")).filter((l) => l && !/^\/\//.test(l)).join("\n");

// JSON allows whitespace between tokens: break long lines after commas outside
// strings so the script stays readable/copyable line by line
function wrapJson(s) {
  let out = "", inStr = false, esc = false, col = 0;
  for (const ch of s) {
    out += ch; col++;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "," && col > 160) { out += "\n"; col = 0; }
  }
  return out;
}
function wrapB64(raw) {
  const o = {};
  for (const k in raw) {
    o[k] = Object.assign({}, raw[k]);
  }
  let s = "{";
  Object.keys(o).forEach((k, i) => {
    const a = o[k];
    s += (i ? ",\n" : "\n") + JSON.stringify(k) + ": {";
    const parts = [];
    if (a.svg) parts.push('"svg": ' + JSON.stringify(a.svg));
    if (a.b64) parts.push('"b64": ' + (a.b64.match(/.{1,160}/g) || [""]).map((x) => JSON.stringify(x)).join("\n+ "));
    s += parts.join(", ") + "}";
  });
  return s + "\n}";
}

const code = builder + "\n" +
  "const DOC = " + wrapJson(JSON.stringify(doc)) + ";\n" +
  "const RAW = " + wrapB64(assets) + ";\n" +
  "const assets = {};\n" +
  "for (const k in RAW) { assets[k] = {}; if (RAW[k].svg) assets[k].svg = RAW[k].svg; if (RAW[k].b64) assets[k].bytes = figma.base64Decode(RAW[k].b64); }\n" +
  "const st = await FeugeeBuild.build(DOC, assets, { x: " + xOff + ", y: 0, name: DOC.title + ' \\u00b7 ' + DOC.label });\n" +
  "const root = st.root; delete st.root;\n" +
  "return { createdNodeIds: [root.id], stats: st, size: [root.width, root.height] };\n";

fs.writeFileSync(path.join(__dirname, "out", "figma-run.js"), code);
console.log("figma-run.js", code.length, "chars", code.length > 50000 ? "TOO LONG" : "ok");
