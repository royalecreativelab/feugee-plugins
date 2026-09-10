// Every ExtendScript snippet the updater builds must be syntactically valid
// and must round-trip the file content exactly. AE is not involved, so we
// parse the generated source and emulate File.write.
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), assert = require('assert');
const REPO = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(REPO, 'Feugelign_CEP/js/modes.js'), 'utf8');
const end = src.indexOf('  topbar.appendChild(bUpdate);') + '  topbar.appendChild(bUpdate);'.length;
const block = src.slice(src.lastIndexOf('  // ---', src.indexOf('  // FEUGEE AUTO-UPDATE v2')), end);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feugee-jsx-'));
const bundle = JSON.parse(fs.readFileSync(path.join(REPO, 'bundles/feugelign.json'), 'utf8'));
fs.mkdirSync(path.join(dir, 'CSXS'), { recursive: true });
fs.writeFileSync(path.join(dir, 'CSXS/manifest.xml'), bundle.files['CSXS/manifest.xml'].replace(/Version="[0-9.]+"/g, 'Version="1.0.0"'));

const scripts = [];
const files = {};           // emulated ExtendScript File targets

function fakeEvalScript(script, cb) {
  scripts.push(script);
  // syntax check as the interpreter would see it
  try { new Function(script); } catch (e) { return cb('ERR|SYNTAX ' + e.message); }

  // The payload is a string literal to ExtendScript, so strip it before
  // reading the control flow - encodeURIComponent leaves ( ) . ' * ! ~ as-is
  // and file content routinely contains things like f.remove().
  const payloadMatch = script.match(/decodeURIComponent\("([^"]*)"\)/);
  const control = payloadMatch ? script.replace(payloadMatch[0], 'PAYLOAD') : script;

  const fileMatch = control.match(/new File\("([^"]+)"\)/);
  const modeMatch = control.match(/f\.open\("(w|a)"\)/);
  if (fileMatch && modeMatch) {
    const target = fileMatch[1];
    let text = '';
    if (payloadMatch) {
      try { text = decodeURIComponent(payloadMatch[1]); }
      catch (e) { return cb('ERR|payload decode: ' + e.message); }
    } else {
      const literal = control.match(/f\.write\("([^"]*)"\)/);
      text = literal ? literal[1] : '';
    }
    files[target] = (modeMatch[1] === 'a' && files[target] ? files[target] : '') + text;
    if (/f\.remove\(\)/.test(control)) delete files[target];
    return cb('OK');
  }
  return cb('OK');
}

const ctx = {
  console: { log(){} }, setTimeout, clearTimeout, Date, JSON, Math, Object, String, Error,
  encodeURIComponent, decodeURIComponent, parseInt,
  navigator: { platform: 'MacIntel', userAgent: 't' },
  localStorage: { getItem: () => null, setItem(){} },
  document: { getElementById: () => null, createElement: () => ({ classList:{add(){},remove(){},contains(){return false;}}, addEventListener(){}, style:{setProperty(){}} }), querySelector: () => null, title: 'Feugelign' },
  topbar: { appendChild(){} },
  fetch: () => Promise.reject(new Error('n/a')),
  XMLHttpRequest: function(){ throw new Error('n/a'); },
  SVG_RELOAD: '', SVG_UPDATE: ''
};
ctx.window = ctx;
ctx.cep = { fs: { readFile(p){ try { return { err:0, data: fs.readFileSync(p,'utf8') }; } catch(e){ return { err:1 }; } },
                  writeFile(){ return { err: 9 }; },   // force the ExtendScript path
                  deleteFile(){}, makedir(){} } };
ctx.__adobe_cep__ = { evalScript: fakeEvalScript, getSystemPath: () => dir };
ctx.location = { reload(){} };
ctx.getExtPath = () => dir;
ctx.getPluginInfo = () => ({ slug: 'feugelign', version: '1.0.0', name: 'Feugelign' });
ctx.isNewerVersion = (r, l) => r !== l;
ctx.setPluginStatus = () => {};
ctx.reloadPlugin = () => {};

vm.createContext(ctx);
vm.runInContext('(function(){"use strict";\n' + block + '\n; this.__api = { writeVerified: writeVerified, enableDebugMode: enableDebugMode, probeWritable: probeWritable, esWrite: esWrite, safeChunks: safeChunks };\n}).call(this);', ctx);
const api = ctx.__api;

(async function () {
  // biggest real file, plus unicode and a surrogate pair that used to break encodeURIComponent
  const cases = {
    'jsx/host.jsx': bundle.files['jsx/host.jsx'],
    'js/modes.js': bundle.files['js/modes.js'],
    'css/panel.css': bundle.files['css/panel.css'] + '\n/* émoji 🎬 dan tanda " kutip \' */\n'
  };

  for (const rel of Object.keys(cases)) {
    const target = dir + '/' + rel;
    await new Promise((res, rej) => api.writeVerified(target, cases[rel], (e) => e ? rej(new Error(rel + ': ' + e.message)) : res()));
    assert.strictEqual(files[target], cases[rel], 'ExtendScript round-trip mismatch for ' + rel);
    console.log('  ok  ' + rel + ' round-trips through ExtendScript (' + cases[rel].length + ' chars, ' + api.safeChunks(cases[rel], 6000).length + ' chunks)');
  }

  // lone-surrogate guard
  const nasty = 'a'.repeat(5999) + '🎬' + 'b'.repeat(10);
  const chunks = api.safeChunks(nasty, 6000);
  chunks.forEach((c) => { encodeURIComponent(c); });   // would throw URIError if split
  console.log('  ok  surrogate pair never split across chunks');

  await new Promise((res) => api.enableDebugMode((r) => { assert.strictEqual(r, 'OK', 'debug mode script: ' + r); res(); }));
  console.log('  ok  PlayerDebugMode script is valid');

  await new Promise((res) => api.probeWritable(dir, (w, d) => { assert(w, 'probe should pass, got ' + d); res(); }));
  console.log('  ok  write probe works over ExtendScript');

  const bad = scripts.filter((s) => { try { new Function(s); return false; } catch (e) { return true; } });
  assert.strictEqual(bad.length, 0, bad.length + ' generated scripts do not parse');
  console.log('  ok  all ' + scripts.length + ' generated ExtendScript snippets parse');
  console.log('\n  all ExtendScript-path tests passed');
})().catch((e) => { console.error('\n  FAILED: ' + e.message); process.exit(1); });
