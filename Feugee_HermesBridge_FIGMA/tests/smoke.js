#!/usr/bin/env node
/* End-to-end smoke test without Figma: stdio proxy -> relay -> fake plugin client.
   1. tools/list returns the 6 tools
   2. with no plugin connected, a call returns the "open the plugin" error
   3. a fake plugin polls, answers use_figma + get_screenshot; proxy returns them
   4. the sandbox serializer (src/main.js) is exercised in a vm with a figma mock */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const proxy = spawn(process.execPath, [path.join(__dirname, "..", "bin", "hb-figma-mcp.js")], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "", nextId = 1; const waiters = {};
proxy.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); if (waiters[m.id]) { waiters[m.id](m); delete waiters[m.id]; } }
});
const rpc = (method, params) => new Promise((res) => { const id = nextId++; waiters[id] = res; proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const RELAY = "http://127.0.0.1:3846";
const CLIENT = "smoke-" + Date.now();
const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function fakePlugin(stopAfter) {
  let handled = 0;
  while (handled < stopAfter) {
    const r = await fetch(RELAY + "/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: CLIENT, info: { fileKey: "SMOKE123", fileName: "Smoke file", page: "Page 1" } }) });
    const j = await r.json();
    for (const job of j.jobs || []) {
      const reply = { id: job.id, tool: job.tool, ok: true, ms: 3, file: "Smoke file" };
      if (job.tool === "use_figma") reply.resultJson = JSON.stringify({ echo: job.args.code.length });
      if (job.tool === "get_screenshot") { reply.result = { width: 1, height: 1 }; reply.shot = { data: PNG1, format: "PNG", name: "smoke" }; }
      await fetch(RELAY + "/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reply) });
      handled++;
    }
  }
  await fetch(RELAY + "/bye", { method: "POST", body: JSON.stringify({ client: CLIENT }) });
}

(async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.serverInfo.name, "figma-bridge");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["use_figma", "get_screenshot", "place_image", "import_svg", "list_fonts", "get_status"]);
  console.log("ok  tools/list", names.length);
  await rpc("tools/call", { name: "get_status", arguments: {} }); // waits for the relay to be up

  const health = await (await fetch(RELAY + "/health")).json();
  const others = health.clients.filter((c) => !String(c.client).startsWith("smoke-"));
  if (!others.length) {
    const closed = await rpc("tools/call", { name: "use_figma", arguments: { code: "return 1" } });
    assert.ok(closed.result.isError && /Hermes Bridge/.test(closed.result.content[0].text));
    console.log("ok  closed plugin -> clear error");
  } else console.log("skip closed-plugin check (a real plugin is connected)");

  const fp = fakePlugin(2);
  const r1 = await rpc("tools/call", { name: "use_figma", arguments: { code: "return 42", fileKey: "SMOKE123" } });
  assert.ok(!r1.result.isError, r1.result.content[0].text);
  assert.deepEqual(JSON.parse(r1.result.content[0].text.split("\n")[0]), { echo: 9 });
  console.log("ok  use_figma round trip");
  const r2 = await rpc("tools/call", { name: "get_screenshot", arguments: { nodeId: "1-2", fileKey: "SMOKE123" } });
  const shot = JSON.parse(r2.result.content[0].text.split("\n")[0]);
  assert.ok(fs.existsSync(shot.path) && shot.bytes > 0); fs.unlinkSync(shot.path);
  console.log("ok  get_screenshot file written", shot.bytes, "bytes");
  await fp;
  const st = await rpc("tools/call", { name: "get_status", arguments: {} });
  console.log("ok  get_status", st.result.content[0].text.slice(0, 120));

  // sandbox serializer under a figma mock
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const mixed = Symbol("mixed"); let posted = [];
  const node = { id: "1:2", name: "Frame", type: "FRAME", parent: null };
  const figma = { mixed, showUI() {}, on() {}, root: { name: "Mock" }, currentPage: { name: "P", id: "0:1" }, currentUser: { name: "R" }, editorType: "figma",
    ui: { postMessage: (m) => posted.push(m), onmessage: null }, commitUndo() {}, notify() {} };
  const ctx = vm.createContext({ figma, __html__: "", console });
  vm.runInContext(src, ctx);
  posted = [];
  await figma.ui.onmessage({ type: "job", job: { id: "x", tool: "use_figma", args: { code: "const n = arguments[0]; return { node: " + JSON.stringify(node) + ", m: figma.mixed, list: [1,2] }" } } });
  const rep = posted.find((p) => p.type === "result");
  assert.ok(rep.ok, rep.error);
  assert.deepEqual(JSON.parse(rep.resultJson), { node: { id: "1:2", name: "Frame", type: "FRAME" }, m: "mixed", list: [1, 2] });
  posted = [];
  await figma.ui.onmessage({ type: "job", job: { id: "y", tool: "use_figma", args: { code: "throw new Error('boom')" } } });
  assert.ok(!posted[0].ok && /boom/.test(posted[0].error));
  console.log("ok  sandbox exec + serializer + error path");

  proxy.stdin.end();
  console.log("ALL PASS");
})().catch((e) => { console.error("FAIL", e); proxy.kill(); process.exit(1); });
