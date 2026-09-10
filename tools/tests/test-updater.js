// Smoke test for the FEUGEE AUTO-UPDATE v2 block: real filesystem in a temp
// dir, fake fetch serving the local bundle, no After Effects involved.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(REPO, 'Feugelign_CEP/js/modes.js'), 'utf8');
const start = src.indexOf('  // FEUGEE AUTO-UPDATE v2');
const end = src.indexOf('  topbar.appendChild(bUpdate);') + '  topbar.appendChild(bUpdate);'.length;
assert(start > 0 && end > start, 'could not locate updater block');
const block = src.slice(src.lastIndexOf('  // ---', start), end);

function makeSandbox(extPath, opts) {
  opts = opts || {};
  const statuses = [];
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = { id, cls: {}, title: '', style: { setProperty(){} },
      classList: { add(c){ els[id].cls[c]=1; }, remove(c){ delete els[id].cls[c]; },
                   contains(c){ return !!els[id].cls[c]; }, toggle(){} },
      addEventListener(){}, appendChild(){}, innerHTML:'', textContent:'',
      get offsetWidth(){ return 1; } };
    return els[id];
  }
  const topbar = el('topbar');
  const document = {
    getElementById: (id) => (id === 'btnUpdate' || id === 'btnReload' || id === 'status') ? el(id) : null,
    createElement: () => el('tmp' + Math.random()),
    querySelector: () => null,
    title: 'Feugelign'
  };

  const cepfs = {
    readFile(p) {
      try { return { err: 0, data: fs.readFileSync(p, 'utf8') }; }
      catch (e) { return { err: 1 }; }
    },
    writeFile(p, data) {
      if (opts.failWrite && p.endsWith(opts.failWrite)) return { err: 5 };
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data, 'utf8'); return { err: 0 }; }
      catch (e) { return { err: 2 }; }
    },
    deleteFile(p) { try { fs.unlinkSync(p); } catch (e) {} },
    makedir(p) { try { fs.mkdirSync(p); } catch (e) {} }
  };

  const bundlePath = (slug) => path.join(REPO, 'bundles', slug + '.json');
  const fakeFetch = (url) => {
    if (opts.offline) return Promise.reject(new Error('offline'));
    let body = null;
    if (url.indexOf('updates.json') !== -1) body = fs.readFileSync(path.join(REPO, 'updates.json'), 'utf8');
    else {
      const m = url.match(/bundles\/([a-z]+)\.json/);
      if (m) body = fs.readFileSync(bundlePath(m[1]), 'utf8');
    }
    if (body === null) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(body)) });
  };

  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, Math, Object, String, Error,
    encodeURIComponent, decodeURIComponent, parseInt, isNaN,
    navigator: { platform: 'MacIntel', userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: () => {} },
    document,
    topbar,
    XMLHttpRequest: function () { throw new Error('no xhr in test'); },
    AbortController: undefined,
    fetch: fakeFetch,
    SVG_RELOAD: '', SVG_UPDATE: '',
    statuses,
    reloaded: 0,
    esCalls: []
  };
  ctx.window = ctx;
  ctx.cep = { fs: cepfs, util: { openURLInDefaultBrowser: (u) => ctx.statuses.push('OPEN ' + u) } };
  ctx.location = { reload: () => { ctx.reloaded++; } };
  // no ExtendScript bridge: exercises the pure cep.fs path
  ctx.__adobe_cep__ = undefined;

  ctx.getExtPath = () => extPath;
  ctx.getPluginInfo = () => ({ slug: 'feugelign', version: opts.localVersion || '1.0.0', name: 'Feugelign' });
  ctx.isNewerVersion = (remote, local) => {
    const r = String(remote).split('.').map(Number), l = String(local).split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((r[i]||0) > (l[i]||0)) return true; if ((r[i]||0) < (l[i]||0)) return false; }
    return false;
  };
  ctx.setPluginStatus = (t) => statuses.push(t);
  ctx.reloadPlugin = () => {};
  return ctx;
}

function run(ctx) {
  const vm = require('vm');
  vm.createContext(ctx);
  vm.runInContext('(function(){"use strict";\n' + block + '\n; this.__api = { checkForUpdates: checkForUpdates, applyUpdate: applyUpdate, readLocalInfo: readLocalInfo, LOGREF: function(){ return LOG; } };\n}).call(this);', ctx);
  return ctx.__api;
}

function stageInstall(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feugee-ext-'));
  const bundle = JSON.parse(fs.readFileSync(path.join(REPO, 'bundles/feugelign.json'), 'utf8'));
  for (const rel of Object.keys(bundle.files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let content = bundle.files[rel];
    if (rel === 'CSXS/manifest.xml') content = content.replace(/Version="[0-9.]+"/g, `Version="${version}"`);
    else content = '/* OLD v' + version + ' */\n' + content;
    fs.writeFileSync(p, content, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'META-INF'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'META-INF/signatures.xml'), '<signature/>', 'utf8');
  return { dir, bundle };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function () {
  // ---- 1. happy path: detect + install ---------------------------------
  const { dir, bundle } = stageInstall('1.0.0');
  const ctx = makeSandbox(dir);
  const api = run(ctx);

  const info = api.readLocalInfo();
  assert.strictEqual(info.slug, 'feugelign');
  assert.strictEqual(info.version, '1.0.0', 'version must come from manifest.xml, got ' + info.version);
  assert.strictEqual(info.bundleId, 'com.feugee.feugelign');
  console.log('  ok  reads identity from CSXS/manifest.xml');

  const remote = await new Promise((res) => api.checkForUpdates(true, (e, has, r) => res({ e, has, r })));
  assert(!remote.e, 'check failed: ' + (remote.e && remote.e.message));
  assert(remote.has, 'should have seen an update');
  console.log('  ok  detects v' + remote.r.version + ' over local v1.0.0');

  api.applyUpdate(remote.r);
  await wait(600);

  for (const rel of Object.keys(bundle.files)) {
    const onDisk = fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.strictEqual(onDisk, bundle.files[rel], 'file not installed cleanly: ' + rel);
  }
  console.log('  ok  all ' + Object.keys(bundle.files).length + ' files written and byte-identical');

  assert(fs.existsSync(path.join(dir, '.debug')), '.debug missing');
  assert(!fs.existsSync(path.join(dir, 'META-INF/signatures.xml')), 'stale signature left behind');
  assert(fs.existsSync(path.join(dir, 'feugee-update.log')), 'log missing');
  assert(!fs.existsSync(path.join(dir, '.feugee-write-test')), 'write probe not cleaned up');
  console.log('  ok  signature dropped, .debug + log written, probe cleaned');
  assert(ctx.reloaded === 1, 'panel should reload once, got ' + ctx.reloaded);
  console.log('  ok  panel reloaded');

  // ---- 2. rollback when a write fails mid-way --------------------------
  const s2 = stageInstall('1.0.0');
  const ctx2 = makeSandbox(s2.dir, { failWrite: 'jsx/host.jsx' });
  const api2 = run(ctx2);
  const before = {};
  for (const rel of Object.keys(s2.bundle.files)) before[rel] = fs.readFileSync(path.join(s2.dir, rel), 'utf8');

  const r2 = await new Promise((res) => api2.checkForUpdates(true, (e, has, r) => res(r)));
  api2.applyUpdate(r2);
  await wait(600);

  for (const rel of Object.keys(s2.bundle.files)) {
    assert.strictEqual(fs.readFileSync(path.join(s2.dir, rel), 'utf8'), before[rel],
      'rollback did not restore ' + rel);
  }
  const failStatus = ctx2.statuses.filter(s => /Update failed/.test(s)).pop();
  assert(failStatus, 'no failure status shown');
  console.log('  ok  failed write rolled everything back: "' + failStatus.slice(0, 70) + '..."');

  // ---- 3. offline: no crash, clear message ----------------------------
  const s3 = stageInstall('1.0.0');
  const ctx3 = makeSandbox(s3.dir, { offline: true });
  const api3 = run(ctx3);
  const e3 = await new Promise((res) => api3.checkForUpdates(false, (e) => res(e)));
  assert(e3, 'offline should report an error');
  console.log('  ok  offline check degrades cleanly: "' + ctx3.statuses.pop() + '"');

  console.log('\n  all updater smoke tests passed');
})().catch((e) => { console.error('\n  FAILED: ' + e.message); process.exit(1); });
