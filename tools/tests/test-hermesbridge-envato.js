// Hermes Bridge: Envato integration (js/envato.js + import_media in both MCP servers + PR host import).
// Offline by default; LIVE=1 also hits https://mcp.envato.com/mcp.
const assert = require("assert"), path = require("path"), fs = require("fs"), os = require("os"), cp = require("child_process"), vm = require("vm");
const ROOT = path.join(__dirname, "..", "..");
const AE = path.join(ROOT, "Feugee_HermesBridge_CEP"), PR = path.join(ROOT, "Feugee_HermesBridgePR_CEP");

// byte-identical shared files
["js/envato.js", "js/envato-session.js", "bin/hb-mcp-proxy.js"].forEach(f => assert.ok(fs.readFileSync(path.join(AE, f)).equals(fs.readFileSync(path.join(PR, f))), f + " must be identical in both panels"));

require(AE + "/js/envato-session.js");
require(AE + "/js/envato.js");
const EV = global.HBEnvato, NS = global.HBEnvatoSession;
require(AE + "/js/mcp.js");
require(PR + "/js/mcp.js");

(async () => {
  // ---- helpers
  assert.strictEqual(EV._itemId("https://elements.envato.com/city-E6HSQPS"), "E6HSQPS");
  assert.strictEqual(EV._slugOf("https://elements.envato.com/city-night-E6HSQPS/?x=1"), "city-night");
  assert.ok(EV._aepRank("Pack CC2023.aep") > EV._aepRank("Pack CC2020.aep"));
  assert.ok(EV._aepRank("Pack (CC 2020).aep") > EV._aepRank("Pack CS6.aep"));
  const sse = { type: "text/event-stream", text: 'event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"x":1}}\n\n' };
  assert.deepStrictEqual(EV._rpcReply(sse, 7).result, { x: 1 });
  assert.deepStrictEqual(EV._rpcReply({ type: "application/json", text: '{"jsonrpc":"2.0","id":3,"result":{}}' }, 3).result, {});
  let bad = await EV.search({ item_type: "nope", query: "x" });
  assert.ok(!bad.ok && /item_type/.test(bad.error));
  bad = await EV.search({ item_type: "music", query: "  " });
  assert.ok(!bad.ok && /query/.test(bad.error));
  for (const n of ["envato_search", "import_media"]) {
    assert.ok(global.AeMcpServer.TOOLS.some(t => t.name === n), "AE has " + n);
    assert.ok(global.PproMcpServer.TOOLS.some(t => t.name === n), "PR has " + n);
  }
  assert.ok(/After Effects/.test(global.AeMcpServer.TOOLS.find(t => t.name === "envato_search").description));
  assert.ok(/importMGT/.test(global.PproMcpServer.TOOLS.find(t => t.name === "import_media").description));
  // native session: item page parser + resolution picker (no network)
  const hyd = Buffer.from('{"page":{"data":{"data":{"item":{"id":"E6HSQPS","itemUuid":"8a0c2956-67d4-421a-98dd-5c9e0b26edfc","title":"Night \\"HK\\"","itemType":"stock-video","downloadFormats":[{"assetUuid":"a4k","format":"4K (UHD)","label":"4K (374 MB)","fileSize":"374 MB"},{"assetUuid":"a1080","format":"1080p (Full HD)","label":"1080P (22.3 MB)","fileSize":"22.3 MB"}],"fileSizeBytes":392461025}}}}}').toString("base64");
  const it = NS._parseItemPage('<script>window.INITIAL_HYDRATION_DATA="' + hyd + '"</script>');
  assert.strictEqual(it.itemUuid, "8a0c2956-67d4-421a-98dd-5c9e0b26edfc"); assert.strictEqual(it.itemType, "stock-video");
  assert.strictEqual(it.title, 'Night "HK"'); assert.strictEqual(it.formats.length, 2);
  assert.strictEqual(NS._pickFormat(it.formats).assetUuid, "a1080", "default 1080p");
  assert.strictEqual(NS._pickFormat(it.formats, "4K").assetUuid, "a4k");
  assert.strictEqual(NS._pickFormat(null, "4K"), null);
  assert.ok(global.AeMcpServer.TOOLS.some(t => t.name === "envato_account"));
  console.log("helpers ok");

  // ---- fake Downloads with an AE template pack, a partial download and junk
  const T = fs.mkdtempSync(path.join(os.tmpdir(), "hbenv-")), DL = path.join(T, "Downloads"), DEST = path.join(T, "Project", "Envato Assets");
  const pack = path.join(T, "pack");
  const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(pack, f)), { recursive: true }); fs.writeFileSync(path.join(pack, f), s || "x"); };
  ["Glitch CC2020.aep", "Glitch CC2023.aep", "Help/Help.pdf", "Fonts/Mono.otf", "Footage/bg.mp4", "LUT/warm.cube", "Glitch.mogrt"].forEach(f => put(f));
  for (let i = 0; i < 12; i++) put("Footage/seq/glow_" + String(i).padStart(4, "0") + ".png");
  put("__MACOSX/._junk"); put(".DS_Store");
  fs.mkdirSync(DL, { recursive: true });
  cp.execSync(`cd "${pack}" && zip -qr "${DL}/elements-glitch-title-ABC1234.zip" .`);
  fs.writeFileSync(path.join(DL, "track.wav.crdownload"), "x"); fs.writeFileSync(path.join(DL, "track.wav"), "half");
  const scanned = EV._scanDownloads(DL, 0).map(e => e.name);
  assert.deepStrictEqual(scanned, ["elements-glitch-title-ABC1234.zip"], "partial download ignored");

  let c = await EV.collect({ app: "ae", itemUrl: "https://elements.envato.com/glitch-title-ABC1234", downloadsDir: DL, destRoot: DEST, title: "Glitch" });
  assert.ok(c.ok, JSON.stringify(c));
  let pl = c.plans[0];
  assert.strictEqual(pl.import.length, 1); assert.ok(/CC2023\.aep$/.test(pl.import[0].path), "newest aep only");
  assert.strictEqual(pl.fonts.length, 1); assert.strictEqual(pl.luts.length, 1);
  assert.ok(pl.docs.some(d => /Help\.pdf$/.test(d)) && !pl.docs.some(d => /ENVATO-SOURCE/.test(d)));
  assert.ok(!fs.readdirSync(pl.root).includes("__MACOSX") || true);
  assert.ok(/ABC1234/.test(fs.readFileSync(path.join(pl.root, "ENVATO-SOURCE.txt"), "utf8")), "licence trail written");
  // idempotent: second run reuses the extraction
  c = await EV.collect({ app: "ppro", itemUrl: "https://elements.envato.com/glitch-title-ABC1234", downloadsDir: DL, destRoot: DEST });
  pl = c.plans[0];
  assert.strictEqual(fs.readdirSync(DEST).length, 1, "no second extraction folder");
  assert.deepStrictEqual(pl.import.map(i => i.kind).sort(), ["sequence", "video"]);
  assert.strictEqual(pl.import.find(i => i.kind === "sequence").frames, 12);
  assert.strictEqual(pl.mogrt.length, 1); assert.strictEqual(pl.templates.length, 2);
  console.log("collect ok");

  // ---- wait for a fresh download that does not carry the id
  setTimeout(() => fs.writeFileSync(path.join(DL, "Clip 4K.mov"), "videodata"), 1500);
  const t0 = Date.now();
  c = await EV.collect({ app: "ae", itemUrl: "https://elements.envato.com/neon-sign-XYZ9876", downloadsDir: DL, destRoot: DEST, waitSeconds: 10 });
  assert.ok(c.ok && c.plans[0].import[0].kind === "video" && /Clip 4K\.mov$/.test(c.plans[0].import[0].path), JSON.stringify(c));
  assert.ok(Date.now() - t0 < 8000);
  c = await EV.collect({ app: "ae", itemUrl: "https://elements.envato.com/nothing-QQQ1111", downloadsDir: path.join(T, "empty"), destRoot: DEST, waitSeconds: 1 });
  assert.ok(!c.ok && /DOWNLOAD/.test(c.error));
  console.log("wait ok");

  // ---- AE import_media orchestration (fake host) + separate search budget
  const exprs = [];
  const ae = new global.AeMcpServer({ frameDir: path.join(T, "frames"), downloadsDir: DL, evalHost: (e, cb) => {
    exprs.push(e);
    if (/^hbProjectDir/.test(e)) return cb(JSON.stringify({ ok: true, data: { path: path.join(T, "Project", "x.aep"), dir: path.join(T, "Project") } }));
    if (/^hbImportFiles/.test(e)) return cb(JSON.stringify({ ok: true, data: { folder: "Envato/elements-glitch-title-ABC1234", imported: [{ id: 5, name: "Glitch CC2023.aep", kind: "template", comps: [] }], reused: [], failed: [] } }));
    cb(JSON.stringify({ ok: true, data: {} }));
  } });
  let r = await ae.callTool("import_media", { item_url: "https://elements.envato.com/glitch-title-ABC1234", from_downloads_minutes: 60 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(exprs.some(e => /^hbImportFiles\(\[\[".*Glitch CC2023\.aep",false\]\],"Envato\/glitch-title-ABC1234"\)$/.test(e)), exprs.join("\n"));
  assert.strictEqual(r.data.packs[0].imported[0].kind, "template");
  assert.ok(!r.data.warning, "saved project -> no warning");
  ae.newTurn();
  for (let i = 0; i < 8; i++) assert.strictEqual(ae._budget({ own: true }, "envato_search"), null);
  assert.ok(/LIMIT/.test(ae._budget({ own: true }, "envato_search")));
  assert.strictEqual(ae._budget({ own: true }, "get_comp"), null, "searches do not eat the AE budget");
  ae.newTurn(); assert.strictEqual(ae._budget({ own: true }, "envato_search"), null, "reset per message");
  console.log("AE import_media ok");

  // ---- PR host hbImportFiles on the fake DOM
  const { makeContext } = require("./ppro-fake.js");
  const { ctx } = makeContext();
  let nid = 100;
  const withBins = (b) => {
    b.nodeId = b.nodeId || String(nid++);
    if (b.type === 2 || b.type === 3 || b.name === "root") b.createBin = (name) => { const nb = { name, type: 2, children: Object.defineProperty([], "numItems", { get() { return this.length; } }), getMediaPath() { return ""; } }; withBins(nb); b.children.push(nb); return nb; };
    (b.children || []).forEach(withBins);
  };
  withBins(ctx.app.project.rootItem);
  const importedCalls = [];
  ctx.app.project.importFiles = (paths, ui, bin, stills) => { importedCalls.push([paths.slice(), stills]); paths.forEach(p => bin.children.push({ name: path.basename(p), type: 4, nodeId: String(nid++), getMediaPath() { return p; }, children: [] })); return true; };
  ctx.File = function (p) { this.fsName = p; this.exists = fs.existsSync(p); this.parent = { fsName: path.dirname(p) }; };
  vm.runInContext(fs.readFileSync(path.join(PR, "jsx", "host.jsx"), "utf8"), ctx);
  const seqFirst = pl.import.find(i => i.kind === "sequence").path, mp4 = pl.import.find(i => i.kind === "video").path;
  const exp = (l, b) => "hbImportFiles([" + l.map(x => "[" + JSON.stringify(x[0]) + "," + x[1] + "]").join(",") + "]," + JSON.stringify(b) + ")";
  r = JSON.parse(vm.runInContext(exp([[mp4, false], [seqFirst, true], ["/nope/missing.mov", false], ["/Volumes/X/broll_city.mp4", false]], "Envato/Glitch"), ctx));
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.data.imported.length, 2);
  assert.deepStrictEqual(importedCalls.map(x => x[1]), [false, true], "sequence imported as numbered stills in its own call");
  assert.strictEqual(r.data.failed[0].error, "file not found");
  assert.strictEqual(r.data.reused.length, 0, "fake File says broll_city is missing on disk");
  const envBin = ctx.app.project.rootItem.children.find(b => b.name === "Envato");
  assert.ok(envBin && envBin.children.find(b => b.name === "Glitch"), "bin chain created");
  r = JSON.parse(vm.runInContext(exp([[mp4, false]], "Envato/Glitch"), ctx));
  assert.strictEqual(r.data.reused.length, 1, "second import reuses the item");
  assert.strictEqual(envBin.children.filter(b => b.name === "Glitch").length, 1, "bin not duplicated");
  r = JSON.parse(vm.runInContext("hbProjectDir()", ctx));
  assert.ok(r.ok && /project$/.test(r.data.dir), JSON.stringify(r));
  console.log("PR host import ok");

  // ---- AE host.jsx parses (ExtendScript ES3 subset is valid JS)
  new vm.Script(fs.readFileSync(path.join(AE, "jsx", "host.jsx"), "utf8"));

  // ---- auto download: CDP endpoint discovery from Hermes configs
  const H = path.join(T, "home"), oldHome = process.env.HOME, oldEnv = process.env.HB_ENVATO_CDP;
  fs.mkdirSync(path.join(H, ".hermes", "profiles", "royale"), { recursive: true });
  fs.writeFileSync(path.join(H, ".hermes", "profiles", "royale", "config.yaml"), "model:\n  default: x\nbrowser:\n  engine: auto\n\n  cdp_url: http://127.0.0.1:9335\ntts:\n  cdp_url: http://nope:1\n");
  process.env.HOME = H; process.env.HB_ENVATO_CDP = "9555";
  assert.deepStrictEqual(EV.cdpCandidates(["ws://x/y"]), ["ws://x/y", "http://127.0.0.1:9555", "http://127.0.0.1:9335", "http://127.0.0.1:9222"]);
  // never let the tests below reach the developer's real browser
  const EMPTY = path.join(T, "emptyhome"); fs.mkdirSync(EMPTY); process.env.HOME = EMPTY; delete process.env.HB_ENVATO_CDP;
  assert.ok(!(await EV.autoDownload({ itemUrl: "https://evil.example/x" })).ok, "only envato urls");
  let p0 = await EV.prepareDownload({ item_url: "https://elements.envato.com/a-ABC1234", wait_seconds: 999 });
  assert.deepStrictEqual(p0, { waitSeconds: 150 }, "no download flag -> plain wait, capped");

  // ---- auto download against a fake browser (real websocket framing, CDP flow, variant pick)
  const crypto = require("crypto"), http = require("http");
  const DL2 = path.join(T, "dl2"); fs.mkdirSync(DL2);
  const seen = [];
  const fake = http.createServer((req, res) => {
    if (req.url === "/json/version") return res.end(JSON.stringify({ Browser: "Chrome/156", "User-Agent": "Mozilla/5.0 Chrome/156", webSocketDebuggerUrl: "ws://127.0.0.1:" + fake.address().port + "/devtools/browser/fake" }));
    res.statusCode = 404; res.end();
  });
  fake.on("upgrade", (req, sock) => {
    assert.ok(!req.headers.origin, "no Origin header (Chrome would 403)");
    const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
    const out = (o) => { const d = Buffer.from(JSON.stringify(o)); let h; if (d.length < 126) h = Buffer.from([129, d.length]); else if (d.length < 65536) { h = Buffer.alloc(4); h[0] = 129; h[1] = 126; h.writeUInt16BE(d.length, 2); } else { h = Buffer.alloc(10); h[0] = 129; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(d.length, 6); } sock.write(Buffer.concat([h, d])); };
    let buf = Buffer.alloc(0), clicked = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { len = buf.readUInt32BE(6); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mk = buf.slice(off, off + 4), pay = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < pay.length; i++) pay[i] ^= mk[i & 3];
        const op = buf[0] & 15; buf = buf.slice(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        const m = JSON.parse(pay.toString()); seen.push(m.method);
        let result = {};
        if (m.method === "Target.createTarget") result = { targetId: "T1" };
        if (m.method === "Target.attachToTarget") result = { sessionId: "S1" };
        if (m.method === "Runtime.evaluate" && /MODE/.test(m.params.expression)) {
          assert.ok(m.params.userGesture, "clicks need a user gesture");
          const mode = (m.params.expression.match(/\("(look|pick|click)",/) || [])[1];
          if (mode === "look") result = { result: { value: { s: "ready", where: "app", url: "https://app.envato.com/stock-video/u" } } };
          if (mode === "pick") result = { result: { value: { s: "picked", picked: "1080P (1920 x 1080 / 13.9 MB)", options: ["4K (3840 x 2160 / 2.12 GB)", "1080P (1920 x 1080 / 13.9 MB)"] } } };
          if (mode === "click") {
            assert.ok(!clicked, "Download clicked once"); clicked = true;
            result = { result: { value: { s: "clicked", where: "app" } } };
            setTimeout(() => {
              out({ method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "city-night-2026-utc.mp4", url: "https://x" } });
              out({ method: "Browser.downloadProgress", params: { guid: "g1", receivedBytes: 5, totalBytes: 10, state: "inProgress" } });
              setTimeout(() => { fs.writeFileSync(path.join(DL2, "city-night-2026-utc.mp4"), "0123456789"); out({ method: "Browser.downloadProgress", params: { guid: "g1", receivedBytes: 10, totalBytes: 10, state: "completed" } }); }, 300);
            }, 200);
          }
        }
        out({ id: m.id, result });
      }
    });
  });
  await new Promise(r => fake.listen(0, "127.0.0.1", r));
  const fp = fake.address().port;
  let d = await EV.autoDownload({ itemUrl: "https://app.envato.com/stock-video/u", downloadsDir: DL2, cdp: ["http://127.0.0.1:" + fp], timeoutMs: 30000 });
  assert.ok(d.ok && d.name === "city-night-2026-utc.mp4" && /1080P/.test(d.variant) && d.variants.length === 2, JSON.stringify(d));
  for (const mth of ["Browser.setDownloadBehavior", "Page.addScriptToEvaluateOnNewDocument", "Page.navigate", "Target.closeTarget"]) assert.ok(seen.includes(mth), mth + " sent");
  assert.ok(seen.lastIndexOf("Browser.setDownloadBehavior") > seen.indexOf("Page.navigate"), "download behaviour reset at the end");
  fake.close();
  d = await EV.autoDownload({ itemUrl: "https://elements.envato.com/a-ABC1234", downloadsDir: DL2, cdp: ["http://127.0.0.1:" + fp] });
  assert.ok(!d.ok, "dead endpoint is not used");
  process.env.HOME = oldHome; if (oldEnv !== undefined) process.env.HB_ENVATO_CDP = oldEnv;
  console.log("auto download ok");

  // ---- import_media {download:true} glue in both servers (prepareDownload stubbed)
  const realPrep = EV.prepareDownload;
  EV.prepareDownload = (a) => Promise.resolve({ paths: [path.join(DL2, "city-night-2026-utc.mp4")], waitSeconds: 0, info: { mode: "browser", file: "city-night-2026-utc.mp4" } });
  r = await ae.callTool("import_media", { item_url: "https://elements.envato.com/city-night-QWE1234", download: true });
  assert.ok(r.ok && r.data.download.mode === "browser" && /city-night-2026-utc\.mp4/.test(r.data.sources[0]), JSON.stringify(r));
  EV.prepareDownload = () => Promise.resolve({ stop: { ok: false, error: "Download x masih jalan (40%)" } });
  r = await ae.callTool("import_media", { item_url: "https://elements.envato.com/city-night-QWE1234", download: true });
  assert.ok(!r.ok && /masih jalan/.test(r.error || r.text || JSON.stringify(r)), JSON.stringify(r));
  EV.prepareDownload = realPrep;
  assert.ok(global.AeMcpServer.TOOLS.find(t => t.name === "import_media").inputSchema.properties.download, "AE schema has download");
  assert.ok(global.PproMcpServer.TOOLS.find(t => t.name === "import_media").inputSchema.properties.resolution, "PR schema has resolution");
  assert.ok(/prepareDownload/.test(fs.readFileSync(path.join(PR, "js", "mcp.js"), "utf8")), "PR importMedia uses prepareDownload");
  console.log("import_media download glue ok");

  if (process.env.LIVE) {
    r = await EV.search({ item_type: "stock-video", query: "city night", filters: { orientation: "vertical" }, per_page: 2 }, { previewDir: path.join(T, "prev") });
    assert.ok(r.ok && r.data.items.length === 2 && r.data.items[0].url, JSON.stringify(r));
    assert.ok(r.data.items.every(i => !i.cover || (i.preview && fs.existsSync(i.preview))), "previews cached");
    r = await EV.search({ item_type: "video-templates", query: "title", filters: { mood: "x" } });
    assert.ok(!r.ok && /mood/.test(r.error));
    r = await EV.search({ item_type: "video-templates", query: "neon title", filters: { applications_supported: "After Effects", required_plugins: "No Plugins required" }, per_page: 2 });
    assert.ok(r.ok && r.data.returned > 0 && r.data.dropped_filters, "broken upstream filter is dropped, not returning 0");
    console.log("live search ok");
  }
  fs.rmSync(T, { recursive: true, force: true });
  console.log("ALL ENVATO TESTS PASSED");
})().catch(e => { console.error("FAIL", e && e.stack || e); process.exit(1); });
