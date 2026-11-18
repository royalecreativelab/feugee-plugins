// Fake Premiere Pro ExtendScript DOM, enough for host.jsx + agent scripts.
// Stateful: scripts that add markers / disable clips show up in later reads.
const vm = require("vm"), fs = require("fs");
const TICKS = 254016000000;

function makeTime(sec) {
  const t = { _s: sec };
  Object.defineProperty(t, "seconds", { get() { return this._s; }, set(v) { this._s = Number(v); }, enumerable: true });
  Object.defineProperty(t, "ticks", { get() { return String(Math.round(this._s * TICKS)); }, set(v) { this._s = Number(v) / TICKS; }, enumerable: true });
  return t;
}

function coll(arr, countKey) {
  const c = arr.slice();
  Object.defineProperty(c, countKey, { get() { return c.length; } });
  return c;
}

function param(name, value, keys) {
  return { displayName: name, getValue() { return value; }, setValue(v) { value = v; }, isTimeVarying() { return !!keys; }, getKeys() { return keys ? new Array(keys).fill(0) : null; } };
}
function comp(name, match, params) { return { displayName: name, matchName: match, properties: coll(params, "numItems") }; }

function clip(name, start, end, inP, media, extra) {
  extra = extra || {};
  const c = {
    name, start: makeTime(start), end: makeTime(end), duration: makeTime(end - start), mediaType: media && /\.(wav|mp3)$/.test(media) ? "Audio" : "Video", type: media && /\.(wav|mp3)$/.test(media) ? 2 : 1, inPoint: makeTime(inP), outPoint: makeTime(inP + end - start),
    disabled: !!extra.disabled, _sel: !!extra.sel,
    projectItem: { name, getMediaPath() { return media; }, isOffline() { return !!extra.offline; }, isSequence() { return false; } },
    components: coll([
      comp("Opacity", "AE.ADBE Opacity", [param("Opacity", 100), param("Blend Mode", 0)]),
      comp("Motion", "AE.ADBE Motion", [param("Position", [0.5, 0.5]), param("Scale", extra.scale || 100, extra.keys), param("Rotation", 0)])
    ].concat(extra.fx ? [comp(extra.fx, "AE.ADBE " + extra.fx, [param("Amount", 30)])] : []), "numItems"),
    isSelected() { return this._sel; }, setSelected(v) { this._sel = v; },
    getSpeed() { return extra.speed || 1; }, isMGT() { return !!extra.mogrt; }, isAdjustmentLayer() { return false; },
    getMGTComponent() { return comp("Graphic Parameters", "", [param("Title", "HELLO")]); },
    getLinkedItems() { return coll([], "numItems"); }
  };
  return c;
}

function track(name, clips, opts) {
  opts = opts || {};
  return { name, clips: coll(clips, "numItems"), transitions: coll([], "numItems"), isMuted() { return !!opts.muted; }, isLocked() { return !!opts.locked; } };
}

function markers(list) {
  const ms = list.map(m => ({ start: makeTime(m[0]), end: makeTime(m[1] || m[0]), name: m[2], comments: m[3] || "", type: "Comment", getColorByIndex() { return 0; }, setColorByIndex() {} }));
  ms.sort((a, b) => a.start.seconds - b.start.seconds);
  return {
    get numMarkers() { return ms.length; },
    getFirstMarker() { return ms[0] || null; },
    getNextMarker(m) { return ms[ms.indexOf(m) + 1] || null; },
    createMarker(sec) { const m = { start: makeTime(sec), name: "", comments: "", type: "Comment", getColorByIndex() { return 0; }, setColorByIndex() {} };
      let endS = sec; Object.defineProperty(m, "end", { get() { return makeTime(endS); }, set(v) { endS = Number(v && v.seconds !== undefined ? v.seconds : v); } });
      ms.push(m); ms.sort((a, b) => a.start.seconds - b.start.seconds); return m; },
    deleteMarker(m) { ms.splice(ms.indexOf(m), 1); },
    _list: ms
  };
}

function makeSequence() {
  let ph = 12.5;
  const seq = {
    name: "EP004 Assembly", sequenceID: "a1b2c3", timebase: String(TICKS / 24), end: String(Math.round(300 * TICKS)),
    frameSizeHorizontal: 3840, frameSizeVertical: 2160,
    videoTracks: coll([
      track("Video 1", [clip("broll_city.mp4", 0, 8, 2, "/Volumes/X/broll_city.mp4"), clip("interview_A.mov", 10, 40, 0, "/Volumes/X/interview_A.mov", { sel: true, fx: "Lumetri Color" }), clip("ending.mp4", 40, 60, 0, "/Volumes/X/ending.mp4", { offline: true })]),
      track("Video 2", [clip("TTL-01 Chapter", 11, 14, 0, "", { mogrt: true, keys: 2 })]),
      track("Video 3", [], { locked: true })
    ], "numTracks"),
    audioTracks: coll([
      track("Audio 1", [clip("vo_master.wav", 0, 300, 0, "/Users/x/vo_master.wav")]),
      track("Audio 2", [clip("music.mp3", 0, 120, 0, "/Users/x/music.mp3", { speed: 1.1 })], { muted: true })
    ], "numTracks"),
    markers: markers([[0, 0, "Intro"], [65, 0, "The Rise"], [130, 0, "The Fall"], [70, 73, "GFX NUM-04", "auto"]]),
    getPlayerPosition() { return makeTime(ph); }, setPlayerPosition(ticks) { ph = Number(ticks) / TICKS; },
    getInPointAsTime() { return makeTime(0); }, getOutPointAsTime() { return makeTime(0); },
    getSelection() { const out = []; [this.videoTracks, this.audioTracks].forEach(tt => tt.forEach(t => t.clips.forEach(c => { if (c._sel) out.push(c); }))); return out; },
    clone() { return true; },
    autoReframeSequence(n, d, preset, name) { const s2 = Object.assign({}, seq, { name, sequenceID: "rf1", frameSizeHorizontal: 1080, frameSizeVertical: 1920 }); project.sequences.push(s2); return s2; }
  };
  return seq;
}

const exported = [];
let project;
function makeContext(frameDir) {
  const seq = makeSequence();
  const bin = (name, children) => ({ name, type: 2, children: coll(children, "numItems"), isSequence() { return false; }, getMediaPath() { return ""; }, isOffline() { return false; } });
  const file = (name, p, off) => ({ name, type: 4, children: coll([], "numItems"), isSequence() { return false; }, getMediaPath() { return p; }, isOffline() { return !!off; } });
  project = {
    path: "/Users/royale/Documents/ALUX/004/project/EP004.prproj", name: "EP004.prproj",
    activeSequence: seq,
    sequences: coll([seq], "numSequences"),
    rootItem: bin("root", [bin("Footage", [file("broll_city.mp4", "/Volumes/X/broll_city.mp4"), file("ending.mp4", "/Volumes/X/ending.mp4", true)]), file("vo_master.wav", "/Users/x/vo_master.wav")])
  };
  const ctx = {
    app: { version: "26.0.0", project, enableQE() {} },
    ProjectItemType: { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 },
    Time: function () { return makeTime(0); },
    qe: { project: { getActiveSequence() { return { CTI: { get timecode() { const s = seq.getPlayerPosition().seconds; return "00:00:" + String(Math.floor(s)).padStart(2, "0") + ":00"; } },
      exportFramePNG(tc, p) { exported.push([tc, p]); const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"); setTimeout(() => fs.writeFileSync(p + ".png", png), 200); } }; } } }
  };
  vm.createContext(ctx);
  return { ctx, seq, exported };
}

module.exports = { makeContext, TICKS };
