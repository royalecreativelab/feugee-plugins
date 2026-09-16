// Feugelord: host hygiene, AE helper logic, manifest wiring, and the CEP path
// decoding every Feugee panel/hub must do. The live round trip (Illustrator
// push -> AE build -> pixel compare) is tools/tests/feugelord_fixture_ai.jsx +
// verify_feugelord_ae.jsx; see the Feugelord vault note for how to run it.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const REPO = path.resolve(__dirname, '..', '..');
const DIR = path.join(REPO, 'Feugee_Feugelord_CEP');
const find = require('./ternary-check.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { console.error('FAIL ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

const hostSrc = fs.readFileSync(path.join(DIR, 'jsx', 'host.jsx'));

test('host.jsx is plain ASCII with no raw control characters', () => {
  assert.ok(!/[^\x00-\x7F]/.test(hostSrc.toString('latin1')), 'non-ASCII byte');
  const ctrl = [...hostSrc].filter(c => c < 0x20 && ![9, 10, 13].includes(c));
  assert.strictEqual(ctrl.length, 0, 'raw control characters (a \\u escape was written out literally)');
});

test('host.jsx has no chained ternaries', () => {
  assert.deepStrictEqual(find(path.join(DIR, 'jsx', 'host.jsx')), []);
});

const ctx = vm.createContext({ BridgeTalk: { appName: 'aftereffects' } });
const before = new Set(Object.keys(ctx));
vm.runInContext(hostSrc.toString('utf8'), ctx);

test('host.jsx adds exactly one global', () => {
  assert.deepStrictEqual(Object.keys(ctx).filter(k => !before.has(k)), ['FG_LORD']);
});

const AEB = ctx.FG_LORD._aeb;

test('dash lists become AE dash/gap pairs (odd lists repeat, max 3 pairs)', () => {
  const plain = (x) => JSON.parse(JSON.stringify(x));
  assert.deepStrictEqual(plain(AEB.dashPairs([24, 10])), [[24, 10]]);
  assert.deepStrictEqual(plain(AEB.dashPairs([5])), [[5, 5]]);
  assert.deepStrictEqual(plain(AEB.dashPairs([1, 2, 3])), [[1, 2], [3, 1], [2, 3]]);
  assert.deepStrictEqual(plain(AEB.dashPairs([1, 2, 3, 4, 5, 6, 7, 8])), [[1, 2], [3, 4], [5, 6]]);
  assert.deepStrictEqual(plain(AEB.dashPairs([])), []);
});

test('a lone wrapper group unwraps, a faded one stays', () => {
  const kids = [{ t: 'path' }, { t: 'path' }];
  assert.strictEqual(AEB.flatten({ t: 'group', opacity: 100, children: kids }), kids);
  assert.strictEqual(AEB.flatten({ t: 'group', opacity: 50, children: kids }).length, 1);
  assert.strictEqual(AEB.flatten({ t: 'path' }).length, 1);
});

test('cap / join enums match AE (1 butt|miter, 2 round, 3 square|bevel)', () => {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(AEB.CAP)), { butt: 1, round: 2, square: 3 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(AEB.JOIN)), { miter: 1, round: 2, bevel: 3 });
});

test('build refuses to run outside After Effects, push outside Illustrator', () => {
  assert.ok(/^ERR\|/.test(ctx.FG_LORD.push('selection', '')));
  const ai = vm.createContext({ BridgeTalk: { appName: 'illustrator' } });
  vm.runInContext(hostSrc.toString('utf8'), ai);
  assert.ok(/^ERR\|/.test(ai.FG_LORD.build('/nope.json')));
});

test('manifest: panel in AE + Illustrator, hub in AE only', () => {
  const xml = fs.readFileSync(path.join(DIR, 'CSXS', 'manifest.xml'), 'utf8');
  assert.ok(/<Host Name="AEFT"/.test(xml) && /<Host Name="ILST"/.test(xml));
  const hub = xml.slice(xml.indexOf('<Extension Id="com.feugee.feugelord.hub">', xml.indexOf('<DispatchInfoList>')));
  assert.ok(/<DispatchInfo Host="AEFT">/.test(hub), 'hub must be limited to After Effects');
});

test('every panel/hub decodes getSystemPath before using it as a file path', () => {
  // getSystemPath returns a URL ("Application%20Support"). ExtendScript's File
  // decodes it, window.cep.fs does not - Feugelord's hub read an empty folder.
  const offenders = [];
  for (const dir of fs.readdirSync(REPO).filter(d => /_CEP$/.test(d))) {
    const jsDir = path.join(REPO, dir, 'js');
    if (!fs.existsSync(jsDir)) continue;
    for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/getSystemPath\(/.test(line) && /replace\(\/\^file/.test(line) && !/decodeURIComponent/.test(line)) {
          offenders.push(dir + '/js/' + f + ':' + (i + 1));
        }
      });
    }
  }
  assert.deepStrictEqual(offenders, []);
});

console.log(passed + ' Feugelord tests passed' + (process.exitCode ? ' (with failures)' : ''));
