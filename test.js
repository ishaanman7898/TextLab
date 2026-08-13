// node test.js -- runs the real clean()/FORMATS out of index.html plus the byte inspector.
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
assert.strictEqual(clean('a b').text, 'a b');                        // nbsp flattened
assert.strictEqual(clean('trailing-').text, 'trailing,');                 // no dangling ", "
assert.strictEqual(clean('x http://a.com/p?utm_source=ai&id=3 y').text, 'x http://a.com/p?id=3 y');
assert.strictEqual(clean('keep\nlines\tand tabs').text, 'keep\nlines\tand tabs');
assert.deepStrictEqual(clean('nothing to see').found, []);

// --- format chain round-trips --------------------------------------------
const sample = 'First paragraph with "quotes" and a café.\n\nSecond {braces} & <angles>.';
for (const f of ['txt', 'md', 'rtf', 'csv']) {
  assert.strictEqual(FORMATS[f].from(FORMATS[f].to(sample)), sample, f + ' does not survive the round-trip');
}

// --- provenance inspector -------------------------------------------------
(async () => {
  const { inspect, sniff } = await import('./public/inspect.js');

  // A minimal JPEG carrying APP11/JUMBF (the C2PA carrier), an EXIF IFD and an XMP packet.
  const seg = (marker, payload) => {
    const b = Buffer.from(payload, 'binary'), len = Buffer.alloc(2);
    len.writeUInt16BE(b.length + 2);
    return Buffer.concat([Buffer.from([0xFF, marker]), len, b]);
  };
  const ifd = Buffer.alloc(2 + 12 + 4);
  ifd.writeUInt16BE(1, 0);                       // one entry
  ifd.writeUInt16BE(0x0131, 2);                  // Software
  ifd.writeUInt16BE(2, 4);                       // ASCII
  ifd.writeUInt32BE(8, 6);                       // length
  ifd.writeUInt32BE(8 + ifd.length, 10);         // offset into the TIFF block
  const tiff = Buffer.concat([Buffer.from('MM\0\x2a'), Buffer.from([0, 0, 0, 8]), ifd, Buffer.from('Firefly\0')]);
  const jpg = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    seg(0xE1, Buffer.concat([Buffer.from('Exif\0\0'), tiff]).toString('binary')),
    seg(0xEB, 'JP\0\0\0\0\0\x18jumbc2pa\0c2pa.created\0Adobe Firefly\0c2pa.training-mining\0'),
    seg(0xE1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>'),
    Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]),
  ]);

  const r = inspect(new Uint8Array(jpg));
  const labels = r.found.map(f => f.label).join(' | ');
  assert.strictEqual(r.kind, 'jpeg');
  assert.ok(/C2PA Content Credentials manifest/.test(labels), 'C2PA manifest not reported: ' + labels);
  assert.ok(/training and mining/.test(labels), 'training-mining assertion not reported');
  assert.ok(/JUMBF box/.test(labels), 'APP11 JUMBF carrier not reported');
  assert.ok(/EXIF Software: Firefly/.test(labels), 'EXIF software tag not read: ' + labels);
  assert.ok(/XMP packet/.test(labels), 'XMP packet not reported');
  assert.ok(/Adobe Firefly/.test(labels), 'claim generator string not surfaced');
  assert.ok(r.found.some(f => f.count === 0 && /Soft bindings/.test(f.label)), 'soft-binding caveat missing');

  // Pixels only, which is what a canvas re-encode leaves behind: nothing to report.
  const bare = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])]);
  assert.deepStrictEqual(inspect(new Uint8Array(bare)).found, [], 'clean JPEG should report nothing');
  assert.strictEqual(sniff(new Uint8Array(Buffer.from('%PDF-1.7'))), 'pdf');

  console.log('ok');
})();
