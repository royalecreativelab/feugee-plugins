// FX Search: ranking rules, data handling, host-call syntax and the
// one-global rule for host.jsx. AE is not involved - the live apply path is
// checked in After Effects itself, see Feugee_FXSearch_CEP/README section.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const DIR = path.resolve(__dirname, '..', '..', 'Feugee_FXSearch_CEP');
const FX = require(path.join(DIR, 'js', 'fxcore.js'));

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

const ROWS = [
  ['f', 'Gaussian Blur', 'Blur & Sharpen', 'ADBE Gaussian Blur 2', 0],
  ['f', 'Fast Box Blur', 'Blur & Sharpen', 'ADBE Box Blur2', 0],
  ['f', 'Glow', 'Stylize', 'ADBE Glo2', 0],
  ['f', 'Fill', 'Generate', 'ADBE Fill', 0],
  ['f', 'Fractal Noise', 'Noise & Grain', 'ADBE Fractal Noise', 0],
  ['f', 'Hue/Saturation', 'Color Correction', 'ADBE HUE SATURATION', 0],
  ['f', 'Drop Shadow', 'Perspective', 'ADBE Drop Shadow', 0],
  ['f', 'CC Ball Action', 'Simulation', 'CC Ball Action', 0],
  ['f', 'Basic 3D', 'Obsolete', 'ADBE Basic 3D', 1],
  ['f', 'Gaussian Blur', 'Blur & Sharpen', 'ADBE Gaussian Blur 2', 0],          // duplicate row
  ['p', 'Blur - Gaussian In', 'Transitions - Dissolves', '/P/Blur - Gaussian In.ffx', 0],
  ['p', 'Glow Burst', 'Image - Creative', '/P/Glow Burst.ffx', 0],
  ['p', 'Old Glow', 'Legacy', '/P/Legacy/Old Glow.ffx', 0],
];
const items = FX.buildItems(ROWS);
const map = FX.byId(items);
const top = (q, opts) => FX.search(items, q, Object.assign({ data: FX.emptyData(), map }, opts)).map(r => r.item.name);

test('duplicates collapse, commands appended', () => {
  assert.strictEqual(items.filter(i => i.name === 'Gaussian Blur').length, 1);
  assert.ok(items.some(i => i.kind === 'cmd' && i.key === 'snapshot'));
});

test('initials: gb -> Gaussian Blur first', () => assert.strictEqual(top('gb')[0], 'Gaussian Blur'));
test('word prefixes: "gau bl"', () => assert.strictEqual(top('gau bl')[0], 'Gaussian Blur'));
test('effects outrank presets on a shared word', () => assert.strictEqual(top('blur')[0], 'Gaussian Blur'));
test('exact beats prefix: glow', () => assert.deepStrictEqual(top('glow').slice(0, 2), ['Glow', 'Glow Burst']));
test('prefix beats substring: fil', () => assert.strictEqual(top('fil')[0], 'Fill'));
test('slash names split into words: hue sat', () => assert.strictEqual(top('hue sat')[0], 'Hue/Saturation'));
test('fuzzy subsequence still finds: frcnoise', () => assert.ok(top('frcnoise').includes('Fractal Noise')));
test('nonsense returns nothing', () => assert.strictEqual(top('zzqx').length, 0));
test('obsolete hidden by default', () => assert.ok(!top('basic').includes('Basic 3D')));

test('obsolete shown when enabled', () => {
  const data = FX.emptyData(); data.settings.showObsolete = true;
  assert.ok(FX.search(items, 'basic', { data, map }).some(r => r.item.name === 'Basic 3D'));
});

test('scope presets only', () => {
  const names = top('glow', { scope: 'preset' });
  assert.ok(names.length && names.every(n => map['ps:/P/Glow Burst.ffx'].name === n || n === 'Old Glow'));
});

test('legacy presets rank under regular presets', () => {
  const names = top('glow', { scope: 'preset' });
  assert.ok(names.indexOf('Glow Burst') < names.indexOf('Old Glow'));
});

test('alias puts item first even when it would not match', () => {
  const data = FX.emptyData();
  FX.setAlias(data, 'DS', 'fx:ADBE Drop Shadow');
  const r = FX.search(items, 'ds', { data, map });
  assert.strictEqual(r[0].item.name, 'Drop Shadow');
  assert.ok(r[0].alias);
});

test('usage lifts within a tier but never across tiers', () => {
  const data = FX.emptyData();
  for (let i = 0; i < 500; i++) FX.recordUse(data, 'fx:ADBE Box Blur2');
  assert.strictEqual(FX.search(items, 'gaussian', { data, map })[0].item.name, 'Gaussian Blur');
  assert.strictEqual(FX.search(items, 'blur', { data, map })[0].item.name, 'Fast Box Blur');
});

test('empty query lists favorites then recents', () => {
  const data = FX.emptyData();
  FX.toggleFavorite(data, 'fx:ADBE Glo2');
  FX.recordUse(data, 'fx:ADBE Fill');
  FX.recordUse(data, 'fx:ADBE Glo2');
  const r = FX.search(items, '', { data, map });
  assert.deepStrictEqual(r.map(x => [x.section, x.item.name]), [['FAVORITES', 'Glow'], ['RECENT', 'Fill']]);
});

test('empty query, no history: commands', () => {
  const r = FX.search(items, '', { data: FX.emptyData(), map });
  assert.ok(r.length && r.every(x => x.item.kind === 'cmd'));
});

test('override resolves to preset, even one outside the index', () => {
  const data = FX.emptyData();
  data.overrides['fx:ADBE Glo2'] = 'ps:/P/Glow Burst.ffx';
  assert.strictEqual(FX.resolveTarget(map['fx:ADBE Glo2'], data, map).kind, 'preset');
  data.overrides['fx:ADBE Glo2'] = 'ps:/Users/x/My Glow.ffx';
  const t = FX.resolveTarget(map['fx:ADBE Glo2'], data, map);
  assert.strictEqual(t.key, '/Users/x/My Glow.ffx');
  assert.strictEqual(t.name, 'My Glow');
});

test('highlight segments map back to the name', () => {
  const r = FX.search(items, 'gb', { data: FX.emptyData(), map })[0];
  const segs = FX.segments(r.item.name, r.pos);
  assert.strictEqual(segs.map(s => s.t).join(''), 'Gaussian Blur');
  assert.deepStrictEqual(segs.filter(s => s.hit).map(s => s.t), ['G', 'B']);
});

test('corrupt data file falls back to defaults', () => {
  assert.deepStrictEqual(FX.parseData('{nope'), FX.emptyData());
  const d = FX.parseData(JSON.stringify({ favorites: [1, 'fx:a'], settings: { keepOpen: 'yes', showObsolete: true } }));
  assert.deepStrictEqual(d.favorites, ['fx:a']);
  assert.strictEqual(d.settings.keepOpen, false);
  assert.strictEqual(d.settings.showObsolete, true);
});

test('scope cycling wraps both ways', () => {
  assert.strictEqual(FX.nextScope('cmd', 1), 'all');
  assert.strictEqual(FX.nextScope('all', -1), 'cmd');
});

// ---------------------------------------------------------------------------
// host calls: every generated call must parse as JS (ExtendScript subset)
// and carry quotes / backslashes / unicode through intact
// ---------------------------------------------------------------------------
test('apply call survives hostile names and paths', () => {
  const nasty = { kind: 'preset', key: 'C:\\Presets\\My "Best" Glow\u2028.ffx', name: 'x' };
  const call = FX.applyCall(nasty, 'sel', FX.emptyData(), 'He said "hi" \\ \u00e9');
  let got;
  vm.runInNewContext(call, { FG_FXS: { apply: (...a) => { got = a; } } });
  assert.strictEqual(got[1], nasty.key);
  assert.strictEqual(got[4], 'He said "hi" \\ \u00e9');
  assert.strictEqual(got[3], 'AB');
});

test('save call round-trips the data', () => {
  const data = FX.emptyData();
  FX.setAlias(data, 'gb', 'fx:ADBE Gaussian Blur 2');
  data.presetFolders.push('/Users/me/Presets "odd" 100%');
  let payload;
  vm.runInNewContext(FX.saveCall(data), { FG_FXS: { saveData: (p) => { payload = p; } } });
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(payload)), data);
});

// ---------------------------------------------------------------------------
// host.jsx: exactly one global, and boot() emits valid JSON
// ---------------------------------------------------------------------------
test('host.jsx creates one global and boots to valid JSON', () => {
  const src = fs.readFileSync(path.join(DIR, 'jsx', 'host.jsx'), 'utf8');
  assert.ok(!/[^\x00-\x7F]/.test(src), 'host.jsx must stay ASCII');

  const files = {};
  function File(p) { this.fsName = p; this.displayName = String(p).split('/').pop(); }
  Object.defineProperty(File.prototype, 'exists', { get() { return this.fsName in files; } });
  File.prototype.open = function (m) { this._m = m; if (m === 'w') files[this.fsName] = ''; return true; };
  File.prototype.read = function () { return files[this.fsName]; };
  File.prototype.write = function (t) { files[this.fsName] += t; return true; };
  File.prototype.close = function () {};
  function Folder(p) { this.fsName = p; this.displayName = String(p).split('/').pop(); this.exists = /Presets$/.test(p) || /Feugee/.test(p); }
  Folder.prototype.create = function () { this.exists = true; };
  Folder.prototype.getFiles = function () {
    if (/Adobe After Effects 2026\/Presets$/.test(this.fsName)) {
      const sub = new Folder(this.fsName + '/Image - Creative');
      sub.getFiles = () => [new File(sub.fsName + '/Glow "Burst".ffx'), new File(sub.fsName + '/readme.txt')];
      const hidden = new Folder(this.fsName + '/(support)');
      return [sub, hidden];
    }
    return [];
  };
  Object.assign(Folder, {
    userData: { fsName: '/U/Library/Application Support', parent: { fsName: '/U/Library' } },
    myDocuments: { fsName: '/U/Documents' },
    appPackage: { fsName: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
                  parent: { fsName: '/Applications/Adobe After Effects 2026' } },
    temp: { fsName: '/tmp' }
  });
  function CompItem() {}
  const comp = Object.assign(new CompItem(), { name: 'Main "01"', selectedLayers: [
    { name: 'Title', property: () => ({}) }, { name: 'Camera 1', property: () => null }] });
  const ctx = {
    File, Folder, CompItem, JSON,
    $: { os: 'Macintosh OS 14', sleep() {} },
    app: { version: '26.5x89', project: { activeItem: comp }, effects: [
      { displayName: 'Gaussian Blur', matchName: 'ADBE Gaussian Blur 2', category: 'Blur & Sharpen' },
      { displayName: 'Hidden', matchName: 'ADBE Hidden', category: '' },
      { displayName: 'Old', matchName: 'ADBE Old', category: '_Obsolete' }] }
  };
  vm.createContext(ctx);
  const before = new Set(Object.keys(ctx));
  vm.runInContext(src, ctx);
  const added = Object.keys(ctx).filter(k => !before.has(k));
  assert.deepStrictEqual(added, ['FG_FXS']);

  const res = ctx.FG_FXS.boot('');
  assert.ok(res.startsWith('OK|'), res);
  const d = JSON.parse(res.slice(3));
  assert.strictEqual(d.nfx, 2);
  assert.strictEqual(d.nps, 1);
  assert.deepStrictEqual(d.rows[1], ['f', 'Old', 'Obsolete', 'ADBE Old', 1]);
  assert.strictEqual(d.rows[2][1], 'Glow "Burst"');
  assert.deepStrictEqual(d.ctx, { comp: 'Main "01"', sel: 2, fxable: 1, names: ['Title', 'Camera 1'] });

  // cached: stamp match sends no rows; re-evaluating the host keeps the cache
  assert.ok(!('rows' in JSON.parse(ctx.FG_FXS.boot(d.stamp).slice(3))));
  vm.runInContext(src, ctx);
  assert.ok(!('rows' in JSON.parse(ctx.FG_FXS.boot(d.stamp).slice(3))));

  // launcher: lands in every version folder, is valid JS, and only fires open()
  const prefs = '/U/Library/Preferences/Adobe/After Effects';
  const origGet = Folder.prototype.getFiles;
  Folder.prototype.getFiles = function () {
    if (this.fsName === prefs) return [new Folder(prefs + '/26.0'), new Folder(prefs + '/26.5'), new Folder(prefs + '/Cache')];
    return origGet.call(this);
  };
  const origFolder = ctx.Folder;
  ctx.Folder = function (p) { const f = new origFolder(p); if (p === prefs) f.exists = true; return f; };
  Object.assign(ctx.Folder, origFolder);
  ctx.Folder.prototype = origFolder.prototype;
  vm.runInContext(src, ctx);
  const inst = ctx.FG_FXS.installLauncher('/Ext/com.feugee.fxsearch');
  assert.ok(/^OK\|Launcher installed in AE 26.0, 26.5/.test(inst), inst);
  assert.ok(/restart AE/.test(inst), 'current version newly written needs a restart');
  assert.ok(/^OK\|Launcher ready/.test(ctx.FG_FXS.installLauncher('/Ext/com.feugee.fxsearch')), 'second run is a no-op');
  const launcher = files[prefs + '/26.5/Scripts/Feugee FX Search.jsx'];
  assert.ok(launcher && !/[^\x00-\x7F]/.test(launcher));
  assert.ok(!/#targetengine/.test(launcher), 'popup must live in the main engine');
  // host's copy of the loader must match FXCore.popupScript exactly
  const rootExpr = launcher.match(/\$\.setenv\("FEUGEE_FXS_ROOT", (.*)\);/)[1];
  assert.ok(launcher.includes(FX.popupScript(rootExpr, 'show', FX.POPUP_VERSION)), 'host popupSource drifted from FXCore.popupScript');
  assert.strictEqual(FX.POPUP_VERSION, fs.readFileSync(path.join(DIR, 'jsx', 'popup.jsx'), 'utf8').match(/var VERSION = "([^"]+)"/)[1]);

  const run = (script, popupLoaded) => {
    const calls = [];
    const env = {};
    const popup = { version: FX.POPUP_VERSION, init: (r) => calls.push('init ' + r), warm: () => { calls.push('warm'); return 'x'; }, show: () => { calls.push('show'); return 'shown'; } };
    const g = { Folder: { userData: { fsName: '/U' } }, File: function (p) { this.p = p; this.exists = /^\/Ext\/com.feugee.fxsearch\/jsx\/popup.jsx$/.test(p); },
                clearOutput() {}, writeLn: (m) => calls.push('log ' + m) };
    g.$ = { getenv: (k) => env[k] || '', setenv: (k, v) => { env[k] = v; },
            evalFile: (f) => { calls.push('eval ' + f.p.split('/').pop()); if (/popup/.test(f.p)) g.FG_FXS_POPUP = popup; if (/host/.test(f.p)) g.FG_FXS = {}; } };
    if (popupLoaded) { g.FG_FXS_POPUP = popup; g.FG_FXS = {}; }
    const ctx = vm.createContext(g);
    const before = new Set(Object.keys(ctx));
    const result = vm.runInContext(script, ctx);
    const leaked = Object.keys(ctx).filter(k => !before.has(k) && k !== 'FG_FXS_POPUP' && k !== 'FG_FXS');
    assert.deepStrictEqual(leaked, [], 'loader leaks globals into the shared main engine');
    return { calls, result };
  };
  assert.deepStrictEqual(run(launcher, false).calls, ['eval host.jsx', 'eval popup.jsx', 'init /Ext/com.feugee.fxsearch', 'show']);
  assert.deepStrictEqual(run(launcher, true).calls, ['show'], 'second press only shows');
  const warm = run(FX.popupScript('"/Ext/com.feugee.fxsearch"', 'warm', FX.POPUP_VERSION), false);
  assert.deepStrictEqual(warm.calls, ['eval host.jsx', 'eval popup.jsx', 'init /Ext/com.feugee.fxsearch', 'warm']);
  assert.strictEqual(warm.result, 'OK|x', 'evalScript gets the completion value');
  assert.ok(/^ERR\|/.test(run(FX.popupScript('"/nope"', 'show', FX.POPUP_VERSION), false).result));
});

// ---------------------------------------------------------------------------
// updater identity: a plugin must resolve to its OWN slug from the manifest.
// Regression: FX Search fell back to "feugelign" and got force-"updated" with
// Feugelign's files on first launch.
// ---------------------------------------------------------------------------
test('updater resolves every plugin to its own slug, unknown ones never to feugelign', () => {
  const REPO = path.resolve(__dirname, '..', '..');
  const src = fs.readFileSync(path.join(REPO, 'Feugelign_CEP/js/modes.js'), 'utf8');
  const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const code = cut('  function getPluginInfo()', '  function isNewerVersion(') +
               cut('  var SLUG_BY_BUNDLE', '  var TIMEOUT_MANIFEST') +
               cut('  function readLocalInfo()', '  function getManifestUrls(');
  const resolve = (brand, manifest) => vm.runInNewContext(code + '; readLocalInfo()', {
    document: { querySelector: () => ({ textContent: brand, firstChild: { textContent: brand } }), title: '' },
    getExtPath: () => '/ext', cepRead: () => manifest
  });
  const m = (id) => '<ExtensionManifest ExtensionBundleId="' + id + '" ExtensionBundleVersion="1.0.0"><Extension Id="' + id + '.panel"/>';
  const plugins = require('child_process').execSync('python3 -c "import sys; sys.path.insert(0, \'tools\'); import build; print(\'\\n\'.join(p[0] + \' \' + p[1] for p in build.PLUGINS))"', { cwd: REPO }).toString().trim().split('\n');
  for (const line of plugins) {
    const [dir, slug] = line.split(' ');
    const xml = fs.readFileSync(path.join(REPO, dir, 'CSXS/manifest.xml'), 'utf8');
    const html = fs.readFileSync(path.join(REPO, dir, 'index.html'), 'utf8');
    const brand = (html.match(/<div class="brand-text">[\s\S]*?<p>([\s\S]*?)<\/p>/) || [])[1].replace(/<[^>]+>/g, '');
    assert.strictEqual(resolve(brand, xml).slug, slug, dir + ' resolved wrong');
  }
  assert.strictEqual(resolve('Something New v1.0.0', m('com.feugee.brandnew')).slug, 'brandnew');
});

// ---------------------------------------------------------------------------
// popup.jsx: one global, and its private fxcore ranks real-world ties right
// ---------------------------------------------------------------------------
test('popup.jsx adds only FG_FXS_POPUP and loads fxcore privately', () => {
  const src = fs.readFileSync(path.join(DIR, 'jsx', 'popup.jsx'), 'utf8');
  assert.ok(!/[^\x00-\x7F]/.test(src), 'popup.jsx must stay ASCII');
  function File(p) { this.p = p; }
  File.prototype.open = function () { return true; };
  File.prototype.read = function () { return fs.readFileSync(path.join(DIR, 'js', 'fxcore.js'), 'utf8'); };
  File.prototype.close = function () {};
  const ctx = vm.createContext({ File, JSON, $: {} });
  const before = new Set(Object.keys(ctx));
  vm.runInContext(src, ctx);
  vm.runInContext('FG_FXS_POPUP.init("/Ext")', ctx);
  assert.deepStrictEqual(Object.keys(ctx).filter(k => !before.has(k)), ['FG_FXS_POPUP']);
  assert.strictEqual(typeof ctx.FXCore, 'undefined');
  assert.strictEqual(ctx.FG_FXS_POPUP.version, '1.1.0');
});

test('everyday effects win ties seen in AE 26.5 (blur, gb)', () => {
  const real = FX.buildItems([
    ['f', 'VR Blur', 'Immersive Video', 'ADBE VR Blur', 0],
    ['f', 'Gaussian Blur', 'Blur & Sharpen', 'ADBE Gaussian Blur 2', 0],
    ['f', 'Grow Bounds', 'Utility', 'ADBE Grow Bounds', 0],
    ['f', 'Bilateral Blur', 'Blur & Sharpen', 'ADBE Bilateral', 0],
  ]);
  const m = FX.byId(real);
  const first = (q) => FX.search(real, q, { data: FX.emptyData(), map: m })[0].item.name;
  assert.strictEqual(first('blur'), 'Gaussian Blur');
  assert.strictEqual(first('gb'), 'Gaussian Blur');
});

test('no chained ternaries in code ExtendScript runs', () => {
  const find = require('./ternary-check.js');
  // self-check: the scanner must catch the exact pattern that broke the popup
  const tmp = path.join(require('os').tmpdir(), 'fxs-ternary.jsx');
  fs.writeFileSync(tmp, 'var badge = k === "fx" ? "FX" : k === "preset" ? "PRESET" : "CMD";\nvar ok = (a ? 1 : (b ? 2 : 3));\n');
  assert.deepStrictEqual(find(tmp), [1]);
  for (const f of ['jsx/popup.jsx', 'jsx/host.jsx', 'js/fxcore.js']) {
    assert.deepStrictEqual(find(path.join(DIR, f)), [], f + ' has a chained ternary (ExtendScript mis-parses it)');
  }
});

console.log(passed + ' FX Search tests passed' + (process.exitCode ? ' (with failures)' : ''));
