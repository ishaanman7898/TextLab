// node test.js -- runs the real clean()/FORMATS out of index.html so there is one copy of the logic.
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const { clean, FORMATS } = new Function(
  cut('// Each class is counted', '// Provenance markers') +
  cut('const paras =', '/* ------------------------------------------------------------------ readers */') +
  '; return { clean, FORMATS };')();

// --- cleaning -------------------------------------------------------------
const zw = clean('a​b﻿­c');
assert.strictEqual(zw.text, 'abc');
assert.strictEqual(zw.found.length, 2, 'zero-width (x2) and soft hyphen get one ledger row each');
assert.strictEqual(zw.found[0].count, 2);
assert.strictEqual(clean('hi󠁡there').text, 'hithere');          // U+E0061 tag char
assert.strictEqual(clean('one;two').text, 'one, two');
assert.strictEqual(clean('well-known — yes – no').text, 'well, known, yes, no');
assert.strictEqual(clean('a b').text, 'a b');                        // nbsp flattened
assert.strictEqual(clean('trailing-').text, 'trailing,');                 // no dangling ", "
assert.strictEqual(clean('x http://a.com/p?utm_source=ai&id=3 y').text, 'x http://a.com/p?id=3 y');
assert.strictEqual(clean('keep\nlines\tand tabs').text, 'keep\nlines\tand tabs');
assert.deepStrictEqual(clean('nothing to see').found, []);

// --- format chain round-trips --------------------------------------------
const sample = 'First paragraph with "quotes" and a café.\n\nSecond {braces} & <angles>.';
for (const f of ['txt', 'md', 'rtf', 'csv']) {
  assert.strictEqual(FORMATS[f].from(FORMATS[f].to(sample)), sample, f + ' does not survive the round-trip');
}
console.log('ok');
