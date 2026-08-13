// node test.js -- runs clean() straight out of index.html so there's one copy of the logic.
const fs = require('fs'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const code = src.slice(src.indexOf('// Invisible'), src.indexOf('const $in'));
const clean = new Function(code + '; return clean;')();

assert.strictEqual(clean('a​b﻿­c'), 'abc');                 // zero-width + BOM + soft hyphen
assert.strictEqual(clean('hi󠁡there'), 'hithere');               // U+E0061 tag char
assert.strictEqual(clean('one;two'), 'one, two');                          // semicolon
assert.strictEqual(clean('well-known — yes – no'), 'well, known, yes, no');
assert.strictEqual(clean('a b'), 'a b');                              // nbsp -> space
assert.strictEqual(clean('trailing-'), 'trailing,');                       // no dangling ", "
assert.strictEqual(clean('keep\nlines\tand tabs'), 'keep\nlines\tand tabs');
console.log('ok');
