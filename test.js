// node test.js          -- offline checks
// node test.js --live    -- also runs the deployed round-trip end to end
const assert = require('assert');

// Enough of a DOM for the HTML/Word parsers, which only ever meet markup this file wrote.
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
globalThis.DOMParser = class {
  parseFromString(html) {
    const ps = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => ({ textContent: unesc(m[1]) }));
    return { body: { querySelectorAll: () => ps, children: ps, textContent: unesc(html.replace(/<[^>]+>/g, '')) } };
  }
};

const ESSAY = `The Role of Technology in Shaping Modern Society

In today's fast-paced world, technology has become an integral part of our daily lives; from the moment we wake up to the moment we sleep.
A second line inside the same paragraph.

Furthermore, technology has played a pivotal role in education — breaking down geographical barriers.`;

(async () => {
  const { clean, FORMATS, runTextPipeline, INTERMEDIATES } = await import('./public/pipeline.js');
  const { inspect, sniff } = await import('./public/inspect.js');

  // --- cleaning -----------------------------------------------------------
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

  // --- format round-trips -------------------------------------------------
  const sample = 'First paragraph with "quotes" and a café.\n\nSecond {braces} & <angles>.';
  for (const f of Object.keys(FORMATS)) {
    assert.strictEqual(FORMATS[f].from(FORMATS[f].to(sample)), sample, f + ' does not survive its own round-trip');
  }

  // --- the five-file chain must not invent or lose a character ------------
  const expected = clean(ESSAY).text;
  const perms = [];
  for (const a of INTERMEDIATES) for (const b of INTERMEDIATES) for (const c of INTERMEDIATES) {
    if (a !== b && b !== c && a !== c) perms.push([a, b, c]);
  }
  for (const dest of ['doc','txt','md','html','rtf']) {
    for (const mid of perms.filter(p => !p.includes(dest))) {
      const r = await runTextPipeline({ raw:ESSAY, dest, mid, translate:false });
      assert.strictEqual(r.artifacts.length, 5, 'chain must produce five files');
      assert.strictEqual(r.text, expected,
        'chain txt→' + mid.join('→') + '→' + dest + ' changed the text:\n' + JSON.stringify(r.text.slice(0, 120)));
    }
  }
  assert.ok(!expected.startsWith('#'), 'no heading marker may be introduced');

  // --- a failing round-trip must not take the run down --------------------
  const broke = await runTextPipeline({
    raw:ESSAY, dest:'txt', translate:true,
    fetchImpl: async () => ({ ok:false, status:503, json: async () => ({ error:'model overloaded' }) }),
  });
  assert.strictEqual(broke.text, expected, 'a failed round-trip must still deliver the cleaned text');
  assert.strictEqual(broke.translated, false);
  assert.ok(broke.found.some(f => /Round-trip failed: model overloaded/.test(f.label)), 'the failure must reach the ledger');

  // --- provenance inspector ----------------------------------------------
  const seg = (marker, payload) => {
    const b = Buffer.from(payload, 'binary'), len = Buffer.alloc(2);
    len.writeUInt16BE(b.length + 2);
    return Buffer.concat([Buffer.from([0xFF, marker]), len, b]);
  };
  const ifd = Buffer.alloc(18);
  ifd.writeUInt16BE(1, 0); ifd.writeUInt16BE(0x0131, 2); ifd.writeUInt16BE(2, 4);
  ifd.writeUInt32BE(8, 6); ifd.writeUInt32BE(8 + ifd.length, 10);
  const tiff = Buffer.concat([Buffer.from('MM\0\x2a'), Buffer.from([0,0,0,8]), ifd, Buffer.from('Firefly\0')]);
  const jpg = Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    seg(0xE1, Buffer.concat([Buffer.from('Exif\0\0'), tiff]).toString('binary')),
    seg(0xEB, 'JP\0\0\0\0\0\x18jumbc2pa\0c2pa.created\0Adobe Firefly\0c2pa.training-mining\0'),
    seg(0xE1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>'),
    Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]),
  ]);
  const r = inspect(new Uint8Array(jpg)), labels = r.found.map(f => f.label).join(' | ');
  assert.strictEqual(r.kind, 'jpeg');
  for (const want of [/C2PA Content Credentials manifest/, /training and mining/, /JUMBF box/,
                      /EXIF Software: Firefly/, /XMP packet/, /Adobe Firefly/]) {
    assert.ok(want.test(labels), want + ' not reported in: ' + labels);
  }
  assert.ok(r.found.some(f => f.count === 0 && /Soft bindings/.test(f.label)), 'soft-binding caveat missing');
  const bare = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9])]);
  assert.deepStrictEqual(inspect(new Uint8Array(bare)).found, [], 'clean JPEG should report nothing');
  assert.strictEqual(sniff(new Uint8Array(Buffer.from('%PDF-1.7'))), 'pdf');

  // --- live round-trip against the deployment -----------------------------
  if (process.argv.includes('--live')) {
    const apiBase = process.env.TEXTLAB_URL || 'https://textlab.ishman.workers.dev';
    const t0 = Date.now();
    const live = await runTextPipeline({ raw:ESSAY, dest:'doc', translate:true, apiBase });
    const note = live.found.find(f => /Round-trip/.test(f.label));
    assert.ok(live.translated, 'live round-trip did not run: ' + (note && note.label));
    assert.ok(live.text.length > 100, 'live round-trip came back too short');
    assert.notStrictEqual(live.text, expected, 'live round-trip returned the text unchanged');
    console.log('live round-trip ok in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's -- ' + note.label);
    console.log('  ' + live.text.split('\n')[0].slice(0, 90));
  }

  console.log('ok');
})().catch(e => { console.error(e.message); process.exit(1); });
