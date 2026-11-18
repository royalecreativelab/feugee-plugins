#!/usr/bin/env node
/* CLI for the bridge (same path as the MCP tools): node bin/hb-call.js <tool> <args.json|-> [codefile.js]
   If a code file is given it becomes args.code. Prints the tool's text result. */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const [tool, argsSrc, codeFile] = process.argv.slice(2);
let args = argsSrc && argsSrc !== "-" ? JSON.parse(fs.existsSync(argsSrc) ? fs.readFileSync(argsSrc, "utf8") : argsSrc) : {};
if (codeFile) args.code = fs.readFileSync(codeFile, "utf8");
const p = spawn(process.execPath, [path.join(__dirname, "hb-figma-mcp.js")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
p.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === 2) { process.stdout.write(m.result.content[0].text + "\n"); process.exitCode = m.result.isError ? 1 : 0; p.stdin.end(); }
  }
});
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) + "\n");
