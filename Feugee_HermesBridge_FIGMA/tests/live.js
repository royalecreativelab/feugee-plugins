#!/usr/bin/env node
/* Live check against a real Figma Desktop with the plugin open.
   usage: node tests/live.js [fileKey]
   Creates a frame "_hermes bridge live test" with one LIVE Geist Serif text,
   exports it, and prints the screenshot path. Delete the frame afterwards. */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const proxy = spawn(process.execPath, [path.join(__dirname, "..", "bin", "hb-figma-mcp.js")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", n = 1; const w = {};
proxy.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); w[m.id] && w[m.id](m); } } });
const rpc = (method, params) => new Promise((r) => { const id = n++; w[id] = r; proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); const t = r.result.content[0].text; console.log("--", name, r.result.isError ? "ERROR" : "ok", "\n" + t.slice(0, 600)); return r.result; };
const fileKey = process.argv[2];
(async () => {
  await rpc("initialize", {});
  await call("get_status", {});
  await call("list_fonts", { query: "geist", fileKey });
  const r = await call("use_figma", { fileKey, description: "live test: Geist Serif text", code: `
    await figma.loadFontAsync({family:'Geist Serif', style:'Regular'});
    let f = figma.currentPage.findOne(n => n.name === '_hermes bridge live test'); if (f) f.remove();
    f = figma.createFrame(); f.name = '_hermes bridge live test'; f.resize(1200, 400); f.x = -2000; f.y = 0;
    f.fills = [{type:'SOLID', color:{r:.047,g:.043,b:.039}}];
    const t = figma.createText(); t.fontName = {family:'Geist Serif', style:'Regular'}; t.fontSize = 160; t.characters = 'Untold';
    t.fills = [{type:'SOLID', color:{r:.847,g:.835,b:.808}}]; t.x = 80; t.y = 80; f.appendChild(t);
    return { frame: f, text: t, font: t.fontName, editable: t.type === 'TEXT' };` });
  if (!r.isError) {
    const id = JSON.parse(r.content[0].text.split("\n")[0]).frame.id;
    await call("get_screenshot", { nodeId: id, maxDimension: 1200, fileKey });
  }
  proxy.stdin.end();
})();
