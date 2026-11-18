// MCP server unit test over real HTTP: auth, tools/list, isError policy, backup, cap, export_frame.
const vm = require("vm"), fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert"), http = require("http");
const EXT = process.argv[2] || path.join(__dirname, "..", "..", "Feugee_HermesBridgePR_CEP");
global.window = undefined;
require(path.join(EXT, "js", "mcp.js"));
const S = global.PproMcpServer;
const { makeContext } = require("./ppro-fake.js");
const { ctx } = makeContext();
vm.runInContext(fs.readFileSync(path.join(EXT, "jsx", "host.jsx"), "utf8"), ctx);
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "pprmcp-"));
const proj = path.join(tmp, "EP004.prproj"); fs.writeFileSync(proj, "<xml/>");
ctx.app.project.path = proj;
let silent = false;
const evalHost = (expr, cb) => { if (silent) return; setTimeout(() => cb(String(vm.runInContext(expr, ctx))), 2); };
const srv = new S({ evalHost, frameDir: path.join(tmp, "frames"), backupDir: path.join(tmp, "bk"), keepBackups: 2, maxTurnCalls: 6 });

function post(body, token) {
  return new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: srv.port, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + (token || srv.token) } }, (resp) => {
      let b = ""; resp.on("data", d => b += d); resp.on("end", () => res({ status: resp.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on("error", rej); r.end(data);
  });
}
const call = (name, args) => post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args || {} } }).then(r => r.body.result);

(async () => {
  await srv.start();
  assert.strictEqual((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "bad")).status, 401);
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.strictEqual(init.body.result.serverInfo.name, "premiere-pro");
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepStrictEqual(list.body.result.tools.map(t => t.name), ["get_sequence", "get_clip", "get_markers", "find_gaps", "get_project", "run_script", "export_frame"]);
  assert.strictEqual((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  srv.newTurn();
  let r = await call("run_script", { code: "undefinedThing.x" });
  assert.strictEqual(r.isError, false, "script errors must not trip the Hermes breaker");
  assert.ok(/^SCRIPT ERROR/.test(r.content[0].text));
  r = await call("get_clip", { track: "V9", index: 0 });
  assert.strictEqual(r.isError, false);
  r = await call("run_script", { code: "'ok'" });
  assert.ok(/^ok\n\[backup .prproj sebelum script: /.test(r.content[0].text) === false, "backup only noted once per turn - first script errored but did the backup");
  assert.strictEqual(fs.readdirSync(path.join(tmp, "bk")).length, 1, "one backup per turn");
  srv.newTurn(); await new Promise(r => setTimeout(r, 1100));
  r = await call("run_script", { code: "return 'n=' + app.project.activeSequence.markers.numMarkers;" });
  assert.ok(/^n=4\n\[backup .prproj sebelum script: .*EP004_\d{8}-\d{6}\.prproj\]$/.test(r.content[0].text), r.content[0].text);
  srv.newTurn(); await new Promise(r => setTimeout(r, 1100));
  await call("run_script", { code: "1" });
  assert.strictEqual(fs.readdirSync(path.join(tmp, "bk")).length, 2, "pruned to keepBackups");

  r = await call("find_gaps", {});
  assert.strictEqual(JSON.parse(r.content[0].text).gaps.length, 2);
  r = await call("export_frame", { time: 65 });
  const fr = JSON.parse(r.content[0].text);
  assert.ok(fs.existsSync(fr.path), "frame file exists: " + fr.path);

  // no per-turn cap
  srv.newTurn();
  for (let i = 0; i < 6; i++) await call("get_markers", {});
  r = await call("get_markers", {});
  assert.ok(!r.isError && !/^LIMIT/.test(r.content[0].text), "7th call in a turn is not capped");

  // Premiere busy -> infra error IS isError
  srv.newTurn(); silent = true;
  const busy = new S({ evalHost, frameDir: tmp }); busy.host = function (e) { return Promise.resolve(JSON.stringify({ ok: false, infra: true, error: "Premiere Pro did not answer" })); };
  srv.host = busy.host;
  r = await call("get_markers", {});
  assert.strictEqual(r.isError, true);
  srv.stop();
  console.log("ALL MCP TESTS PASSED");
  process.exit(0);
})().catch(e => { console.error("FAIL", e); process.exit(1); });
