// Flags a ternary whose ELSE branch is another bare ternary (a ? b : c ? d : e)
// at the same parenthesis depth - ExtendScript parses that left-associatively.
const fs = require('fs');
function strip(src) {
  // blank out comments, strings and regex literals, keep length/newlines
  let out = '', i = 0, prev = '';
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") { out += c; i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') { out += ' '; i++; } out += ' '; i++; } out += c; i++; prev = c; continue; }
    if (c === '/' && /[=(,:!&|?{};\n]\s*$/.test(out.slice(-20)) ) { out += ' '; i++; while (i < src.length && src[i] !== '/') { if (src[i] === '\\') { out += ' '; i++; } out += ' '; i++; } out += ' '; i++; continue; }
    out += c; i++;
  }
  return out;
}
function find(file) {
  const s = strip(fs.readFileSync(file, 'utf8'));
  const hits = [];
  // per depth: state 0 none, 1 saw '?', 2 saw ':' after '?'
  const state = [0];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('([{'.includes(c)) { depth++; state[depth] = 0; }
    else if (')]}'.includes(c)) { state[depth] = 0; depth = Math.max(0, depth - 1); }
    else if (c === ';' || c === ',') state[depth] = 0;
    else if (c === '?') {
      if (state[depth] === 2) hits.push(s.slice(0, i).split('\n').length);
      state[depth] = 1;
    } else if (c === ':' && state[depth] === 1) state[depth] = 2;
  }
  return hits;
}
module.exports = find;
if (require.main === module) for (const f of process.argv.slice(2)) console.log(f, find(f));
