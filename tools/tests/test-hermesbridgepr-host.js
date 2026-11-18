// Unit test host.jsx against the fake Premiere DOM.
const vm = require("vm"), fs = require("fs"), assert = require("assert"), path = require("path");
const { makeContext } = require("./ppro-fake.js");
const HOST = process.argv[2] || path.join(__dirname, "..", "..", "Feugee_HermesBridgePR_CEP", "jsx", "host.jsx");
const { ctx, seq, exported } = makeContext();
vm.runInContext(fs.readFileSync(HOST, "utf8"), ctx);
const call = (expr) => { const raw = vm.runInContext(expr, ctx); return JSON.parse(raw); };

let r = call("hbContext(20)");
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(r.data.sequence.fps, 24);
assert.strictEqual(r.data.sequence.duration, 300);
assert.strictEqual(r.data.sequence.playhead, 12.5);
assert.strictEqual(r.data.tracks.length, 5);
assert.deepStrictEqual(r.data.underPlayhead.map(c => c.track + "#" + c.i), ["V1#1", "V2#0", "A1#0", "A2#0"]);
assert.deepStrictEqual(r.data.selected.map(c => c.track + "#" + c.i), ["V1#1"]);
assert.ok(r.data.tracks[2].locked && r.data.tracks[4].muted);
console.log("context ok", JSON.stringify(r.data).length, "bytes");

r = call("hbGetSequence(null, 80, null)");
assert.ok(r.ok); assert.strictEqual(r.data.clipsTotal, 6);
assert.ok(r.data.clips.find(c => c.name === "ending.mp4").offline);
assert.strictEqual(r.data.clips.find(c => c.name === "music.mp3").speed, 1.1);
r = call('hbGetSequence(null, 80, "V1")'); assert.strictEqual(r.data.clipsTotal, 3);
r = call('hbGetSequence(null, 2, null)'); assert.strictEqual(r.data.clipsListed, 2); assert.ok(r.data.truncated);
r = call('hbGetSequence("nope", 2, null)'); assert.ok(!r.ok && /not found/.test(r.error));
console.log("get_sequence ok");

r = call('hbGetClip(null, "V1", 1, null, false)');
assert.ok(r.ok, JSON.stringify(r));
assert.strictEqual(r.data.components[0].props, "(static - pass all_props)");
assert.strictEqual(r.data.components[1].props.length, 3);
assert.strictEqual(r.data.components[2].name, "Lumetri Color");
r = call('hbGetClip(null, "v2", null, "TTL-01 Chapter", false)');
assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(r.data.mogrtParams, [{ name: "Title", value: "HELLO" }]);
assert.strictEqual(r.data.components[1].props.find(p => p.name === "Scale").keys, 2);
r = call('hbGetClip(null, "V9", 0, null, false)'); assert.ok(!r.ok && /does not exist/.test(r.error), r.error);
r = call('hbGetClip(null, "V1", 7, null, false)'); assert.ok(!r.ok && /out of range/.test(r.error));
console.log("get_clip ok");

r = call("hbMarkers(null, 150, 0)");
assert.ok(r.ok); assert.strictEqual(r.data.total, 4);
assert.deepStrictEqual(r.data.markers.map(m => m.name), ["Intro", "The Rise", "GFX NUM-04", "The Fall"]);
assert.strictEqual(r.data.markers[2].end, 73);
r = call("hbMarkers(null, 2, 1)"); assert.deepStrictEqual(r.data.markers.map(m => m.n), [1, 2]); assert.ok(r.data.truncated);
console.log("markers ok");

r = call("hbProject(200)");
assert.ok(r.ok); assert.strictEqual(r.data.offline, 1);
assert.deepStrictEqual(r.data.items.map(i => i.bin + "/" + i.name), ["/Footage", "/Footage/broll_city.mp4", "/Footage/ending.mp4", "/vo_master.wav"]);
console.log("project ok");
r = call("hbGaps(null, 1, null, false)");
assert.ok(r.ok, JSON.stringify(r));
assert.deepStrictEqual(r.data.gaps.map(g => g.track + "@" + g.start + "+" + g.sec + "/" + g.frames), ["V1@8+2/48", "V2@0+11/264"]);
assert.deepStrictEqual(r.data.emptyTracks, ["V3"]);
r = call('hbGaps(null, 1, "A2", true)'); assert.deepStrictEqual(r.data.gaps.map(g => g.start + "-" + g.end), ["120-300"]);
console.log("gaps ok");

r = call('hbEval("var m = app.project.activeSequence.markers.createMarker(90); m.name = \\"Test\\"; m.end = 92; \\"ok: \\" + app.project.activeSequence.markers.numMarkers")');
assert.deepStrictEqual(r, { ok: true, result: "ok: 5" });
r = call('hbEval("undefinedThing.x")'); assert.ok(!r.ok);
r = call('hbEval("[1,2,{a:1}]")'); assert.ok(r.ok);
r = call('hbEval("var n = app.project.activeSequence.markers.numMarkers; return \\"n=\\" + n;")');
assert.deepStrictEqual(r, { ok: true, result: "n=5" }, JSON.stringify(r));
console.log("eval ok");

r = call('hbExportFrame(null, 65, "/tmp/hbpr_frame_test")');
assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.data.time, 65);
assert.strictEqual(seq.getPlayerPosition().seconds, 12.5, "playhead restored");
assert.strictEqual(exported[0][1], "/tmp/hbpr_frame_test");
console.log("export ok", JSON.stringify(r.data));

assert.ok(/EP004 Assembly  3840x2160 @24  \|  V3 A2  \|  1 selected/.test(vm.runInContext("hbSeqMeta()", ctx)));
ctx.app.project.activeSequence = null;
assert.strictEqual(vm.runInContext("hbSeqMeta()", ctx), "No sequence open");
r = call("hbContext(20)"); assert.ok(!r.ok && /no active sequence/.test(r.error));
console.log("ALL HOST TESTS PASSED");
