// ExtendScript hygiene across EVERY plugin: no chained ternaries in anything
// ExtendScript runs. ExtendScript parses a ? b : c ? d : e as
// (a ? b : c) ? d : e (verified in AE 26.5), which silently broke Feugee Motion
// align min and Feugelign's axis labels. Node parses it correctly, so the only
// guard is this scan - plus the behaviour checks below that pin the intended
// results of the code that was rewritten.
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), assert = require('assert');
const find = require('./ternary-check.js');
const REPO = path.resolve(__dirname, '..', '..');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

// Everything ExtendScript evaluates: each plugin's jsx/, the live AE/AI test
// scripts, and any .js a .jsx reads in and evals (FX Search's fxcore.js).
function extendScriptFiles() {
  const files = [];
  for (const d of fs.readdirSync(REPO)) {
    const jsx = path.join(REPO, d, 'jsx');
    if (!/_CEP$/.test(d) || !fs.existsSync(jsx)) continue;
    for (const f of fs.readdirSync(jsx)) if (/\.jsx(inc)?$/.test(f)) files.push(path.join(jsx, f));
  }
  const tests = path.join(REPO, 'tools', 'tests');
  for (const f of fs.readdirSync(tests)) if (/\.jsx$/.test(f)) files.push(path.join(tests, f));
  for (const f of files.slice()) {
    if (!f.includes('_CEP')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/["']\/js\/([\w.-]+\.js)["']/g)) {
      const js = path.join(path.dirname(path.dirname(f)), 'js', m[1]);
      if (fs.existsSync(js) && !files.includes(js)) files.push(js);
    }
  }
  return files;
}

test('scanner catches the exact patterns that broke Motion and Feugelign', () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feugee-ternary-')), 'bad.jsx');
  fs.writeFileSync(tmp, [
    'var dest = (mode === "min") ? targetMin : (mode === "max") ? targetMax : targetMid;',
    'var md = (mode === "min") ? (a === 0 ? "kiri" : a === 1 ? "atas" : "belakang")',
    '       : "tengah";',
    'var ok = (a ? 1 : (b ? 2 : 3));',
    'var ok2 = a ? (b ? 1 : 2) : 3;',
  ].join('\n') + '\n');
  assert.deepStrictEqual(find(tmp), [1, 2]);
});

test('no chained ternaries in any file ExtendScript runs', () => {
  const files = extendScriptFiles();
  const rel = files.map(f => path.relative(REPO, f));
  // the scan must actually cover every plugin host, not silently find nothing
  for (const d of fs.readdirSync(REPO).filter(d => /_CEP$/.test(d))) {
    if (fs.existsSync(path.join(REPO, d, 'jsx', 'host.jsx'))) assert.ok(rel.includes(path.join(d, 'jsx', 'host.jsx')), d + ' host.jsx not scanned');
  }
  assert.ok(rel.includes(path.join('Feugee_FXSearch_CEP', 'js', 'fxcore.js')), 'fxcore.js (eval-ed by popup.jsx) not scanned');
  const bad = files.map(f => [path.relative(REPO, f), find(f)]).filter(([, hits]) => hits.length);
  assert.deepStrictEqual(bad, [], 'chained ternary (ExtendScript mis-parses it) at: ' +
    bad.map(([f, h]) => f + ':' + h.join(',')).join('  '));
});

// --- Feugelign: status labels -----------------------------------------------
test('Feugelign axis / target labels', () => {
  const src = fs.readFileSync(path.join(REPO, 'Feugelign_CEP', 'jsx', 'host.jsx'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name + ' not found');
    return src.slice(start, src.indexOf('\n}\n', start) + 2);
  };
  const ctx = vm.createContext({});
  vm.runInContext(grab('fgAxisLabel') + grab('fgToLabel'), ctx);
  const expect = {
    min: ['X kiri', 'Y atas', 'Z belakang'],
    max: ['X kanan', 'Y bawah', 'Z depan'],
    mid: ['X tengah', 'Y tengah', 'Z tengah'],
  };
  for (const mode of Object.keys(expect)) {
    for (let a = 0; a < 3; a++) assert.strictEqual(ctx.fgAxisLabel(a, mode), expect[mode][a], mode + ' axis ' + a);
  }
  assert.strictEqual(ctx.fgToLabel('comp', 'action'), 'action safe');
  assert.strictEqual(ctx.fgToLabel('comp', 'title'), 'title safe');
  assert.strictEqual(ctx.fgToLabel('comp', 'none'), 'comp');
  assert.strictEqual(ctx.fgToLabel('key', 'action'), 'key object');
  assert.strictEqual(ctx.fgToLabel('sel', 'title'), 'selection');
});

// --- Feugee Motion: align min / max / center --------------------------------
test('Feugee Motion alignLayers sends min/max/center to the right edge', () => {
  const src = fs.readFileSync(path.join(REPO, 'Feugee_Motion_CEP', 'jsx', 'host.jsx'), 'utf8');
  function run(axis, mode, target, positions) {
    function CompItem() {}
    const layers = positions.map((p) => {
      const pos = { value: p.slice(), isTimeVarying: false, setValue(v) { this.value = v.slice(); } };
      return { property: () => ({ property: () => pos }), pos };
    });
    const comp = Object.assign(new CompItem(), { width: 1920, height: 1080, time: 0, selectedLayers: layers });
    const app = { project: { activeItem: comp }, beginUndoGroup() {}, endUndoGroup() {} };
    const ctx = vm.createContext({ app, CompItem });
    vm.runInContext(src, ctx);
    const res = ctx.FG_MOTION.alignLayers(axis, mode, target);
    assert.ok(/^OK\|/.test(res), res);
    return layers.map(l => l.pos.value[axis === 'x' ? 0 : 1]);
  }
  const sel = [[100, 100, 0], [500, 900, 0], [900, 300, 0]];
  assert.deepStrictEqual(run('x', 'min', 'sel', sel), [100, 100, 100]);
  assert.deepStrictEqual(run('x', 'max', 'sel', sel), [900, 900, 900]);
  assert.deepStrictEqual(run('x', 'mid', 'sel', sel), [500, 500, 500]);
  assert.deepStrictEqual(run('y', 'min', 'comp', sel), [0, 0, 0]);
  assert.deepStrictEqual(run('y', 'max', 'comp', sel), [1080, 1080, 1080]);
  assert.deepStrictEqual(run('y', 'mid', 'comp', sel), [540, 540, 540]);
});

console.log(passed + ' ExtendScript hygiene tests passed' + (process.exitCode ? ' (with failures)' : ''));
