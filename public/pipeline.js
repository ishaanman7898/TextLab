// The text bench itself: scan, clean, round-trip, convert. No DOM wiring, so test.js can run it in node.

/* ------------------------------------------------------------------ scanning */

// Each class is counted before it is removed, so the ledger can report it.
export const CLASSES = [
  { label:'Zero-width characters',  re:/[\u200B-\u200D\u2060-\u2064\uFEFF]/g,                        to:'',   act:'removed' },
  { label:'Bidirectional controls', re:/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g,            to:'',   act:'removed' },
  { label:'Variation selectors',    re:/[\uFE00-\uFE0F]/g,                                           to:'',   act:'removed' },
  { label:'Unicode tag characters', re:/\uDB40[\uDC00-\uDDEF]/g,                                     to:'',   act:'removed' },
  { label:'Soft hyphens',           re:/\u00AD/g,                                                    to:'',   act:'removed' },
  { label:'Invisible fillers',      re:/[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\u206A-\u206F\uFFA0\uFFF9-\uFFFB]/g, to:'', act:'removed' },
  { label:'Control characters',     re:/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,     to:'',   act:'removed' },
  { label:'Non-standard spaces',    re:/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g,             to:' ',  act:'flattened' },
  { label:'Link tracking parameters', re:/([?&])(utm_[a-z]+|fbclid|gclid|igshid|mc_[a-z]+|ref_src|si)=[^&\s)\]]*/gi, to:'$1', act:'removed' },
  { label:'Semicolons',             re:/;/g,                                                         to:', ', act:'replaced with ", "' },
  { label:'Dashes and em dashes',   re:/[\u002D\u058A\u1400\u1806\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g, to:', ', act:'replaced with ", "' },
];

export function clean(text) {
  const found = [];
  let s = text.replace(/\r\n?/g, '\n');
  for (const c of CLASSES) {
    const hits = s.match(c.re);
    if (hits) found.push({ count:hits.length, label:c.label, act:c.act });
    s = s.replace(c.re, c.to);
  }
  s = s.normalize('NFC')
    .replace(/\?&+/g, '?').replace(/&&+/g, '&')   // tidy URLs left ragged by removed tracking params
    .replace(/[?&]+(\s|$)/g, '$1')
    .replace(/[ \t]*,(?:[ \t]*,)+/g, ',')         // collapse runs of inserted commas
    .replace(/[ \t]+,/g, ',')
    .replace(/,(\S)/g, ', $1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text:s, found };
}

// Provenance markers that ride along with rich-text pastes.
const MARKERS = [
  [/docs-internal-guid|google-docs/i,      'Google Docs paste markers'],
  [/mso-|urn:schemas-microsoft-com|<o:p>/i,'Microsoft Word paste markers'],
  [/notion\.so|notion-/i,                  'Notion paste markers'],
  [/data-pm-slice|ProseMirror/i,           'ProseMirror editor markers'],
  [/<meta[^>]+name=["']?generator/i,       'Generator metadata'],
  [/class=["'][^"']*(ql-|tiptap|slate-)/i, 'Rich-text editor classes'],
];

export function scanHtml(html) {
  const found = [];
  for (const [re, label] of MARKERS) if (re.test(html)) found.push({ count:1, label, act:'dropped with the markup' });
  const links = html.match(/href=/gi);
  if (links) found.push({ count:links.length, label:'Hyperlinks', act:'flattened to text' });
  const comments = html.match(/<!--[\s\S]*?-->/g);
  if (comments) found.push({ count:comments.length, label:'HTML comments', act:'dropped with the markup' });
  return found;
}

/* ------------------------------------------------------------------ formats */

export const paras = t => t.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
export const escHtml = t => t.replace(/[&<>]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));

export const stripTags = h => {
  const d = new (globalThis.DOMParser)().parseFromString(h, 'text/html');
  return [...d.body.querySelectorAll('p,div,li,h1,h2,h3,br')].length
    ? [...d.body.children].map(e => e.textContent.trim()).filter(Boolean).join('\n\n')
    : d.body.textContent.trim();
};

export const FORMATS = {
  txt:  { ext:'txt',  mime:'text/plain',        name:'TXT',  to:t => t,                       from:s => s },
  md:   { ext:'md',   mime:'text/markdown',     name:'MD',   name2:'Markdown',
          to:t => paras(t).map(p => p.replace(/^([#>*+\-=])/gm, '\\$1')).join('\n\n'),
          from:s => s.replace(/^\\([#>*+\-=])/gm, '$1') },
  html: { ext:'html', mime:'text/html',         name:'HTML',
          to:t => '<!doctype html>\n<meta charset="utf-8">\n<title>TextLab</title>\n' + paras(t).map(p => '<p>' + escHtml(p) + '</p>').join('\n') + '\n',
          from:s => stripTags(s) },
  rtf:  { ext:'rtf',  mime:'application/rtf',   name:'RTF',
          to:t => '{\\rtf1\\ansi\\deff0\n' + paras(t).map(p =>
                    '\\pard ' + p.replace(/[\\{}]/g, m => '\\' + m)
                                 .replace(/[\u0080-\uFFFF]/g, c => '\\u' + c.charCodeAt(0) + '?')
                                 .replace(/\n/g, '\\line ') + '\\par').join('\n') + '\n}',
          from:s => s.replace(/^\{\\rtf1[^\n]*\n?/, '')
                     .replace(/\\par\b\s*/g, '\n\n').replace(/\\line\b\s?/g, '\n')
                     .replace(/\\u(\d+)\?/g, (_, n) => String.fromCharCode(+n))
                     .replace(/\\([\\{}])/g, (_, c) => '\u0001' + c.charCodeAt(0) + '\u0002')
                     .replace(/\\[a-z]+-?\d*\s?/gi, '')   // drop the remaining control words
                     .replace(/[{}]/g, '')                // and the grouping braces
                     .replace(/\u0001(\d+)\u0002/g, (_, n) => String.fromCharCode(+n))
                     .trim() },
  csv:  { ext:'csv',  mime:'text/csv',          name:'CSV',
          to:t => 'paragraph\n' + paras(t).map(p => '"' + p.replace(/"/g, '""') + '"').join('\n') + '\n',
          from:s => s.trim().replace(/^paragraph\n/, '').split(/\n(?=")/)
                     .map(r => r.replace(/^"|"$/g, '').replace(/""/g, '"')).join('\n\n') },
  doc:  { ext:'doc',  mime:'application/msword', name:'DOC', name2:'Word',
          to:t => '<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body>' +
                  paras(t).map(p => '<p>' + escHtml(p) + '</p>').join('') + '</body></html>',
          from:s => stripTags(s) },
  pdf:  { ext:'pdf',  mime:'application/pdf',    name:'PDF',
          to:t => pdfBuild(t),
          from:b => pdfExtract(b) },
};

// ponytail: hand-rolled single-byte-per-char PDF writer, WinAnsi range only (0x20-0x7E, 0xA0-0xFF).
// Characters outside that range become "?" rather than embedding a Unicode font.
const PDF_PAGE = { w:612, h:792, margin:54, fontSize:10, leading:14 };

function pdfEscape(s) { return s.replace(/[\\()]/g, c => '\\' + c); }

function pdfWrapWords(line, width) {
  const words = line.split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  out.push(cur);
  return out;
}

function pdfBuild(text) {
  const { w:W, h:H, margin:M, fontSize:FS, leading:LEAD } = PDF_PAGE;
  const width = Math.max(20, Math.floor((W - M * 2) / (FS * 0.5)));
  const linesPerPage = Math.max(1, Math.floor((H - M * 2) / LEAD));

  const lines = [];
  paras(text).forEach((p, pi) => {
    if (pi) lines.push('');   // a blank Tj marks a paragraph break for pdfExtract to find later
    for (const l of pdfWrapWords(p, width)) lines.push(l.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?'));
  });

  const pages = [];
  for (let i = 0; i < lines.length || !pages.length; i += linesPerPage) pages.push(lines.slice(i, i + linesPerPage));

  const streams = pages.map(ls => {
    let body = 'BT /F1 ' + FS + ' Tf ' + LEAD + ' TL ' + M + ' ' + (H - M) + ' Td\n';
    body += ls.map((l, i) => (i ? 'T*\n' : '') + '(' + pdfEscape(l) + ') Tj').join('\n');
    return body + '\nET';
  });

  // Object numbers: 1 catalog, 2 pages, 3 font, then a page + content pair per page from 4 up.
  const CATALOG = 1, PAGES = 2, FONT = 3;
  const pageObj = i => 4 + i * 2, contentObj = i => 5 + i * 2;

  const objs = [];
  objs[CATALOG] = '<< /Type /Catalog /Pages ' + PAGES + ' 0 R >>';
  objs[PAGES] = '<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
    pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') + '] >>';
  objs[FONT] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((_, i) => {
    objs[pageObj(i)] = '<< /Type /Page /Parent ' + PAGES + ' 0 R /MediaBox [0 0 ' + W + ' ' + H + ']' +
      ' /Resources << /Font << /F1 ' + FONT + ' 0 R >> >> /Contents ' + contentObj(i) + ' 0 R >>';
    objs[contentObj(i)] = { stream: streams[i] };
  });

  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    const o = objs[i];
    out += o.stream !== undefined
      ? i + ' 0 obj\n<< /Length ' + o.stream.length + ' >>\nstream\n' + o.stream + '\nendstream\nendobj\n'
      : i + ' 0 obj\n' + o + '\nendobj\n';
  }
  const xrefStart = out.length;
  out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + objs.length + ' /Root ' + CATALOG + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';

  return Uint8Array.from(out, c => c.charCodeAt(0));
}

function pdfBytesToStr(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function pdfExtract(bytes) {
  const s = pdfBytesToStr(bytes);
  const raw = [...s.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
  let out = '', para = [];
  const flush = () => { if (para.length) { out += (out ? '\n\n' : '') + para.join(' '); para = []; } };
  for (const l of raw) { if (l === '') flush(); else para.push(l); }
  flush();
  return out;
}

export const INTERMEDIATES = ['md','html','rtf','csv'];
export const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

export const LANGS = ['spanish','russian','french','german','japanese','portuguese','italian',
                      'korean','turkish','dutch','polish','swedish','indonesian','vietnamese'];

/* ------------------------------------------------------------------ the run */

export async function roundTrip(text, opts = {}) {
  const langs = opts.langs || pick(LANGS, 2);
  const f = opts.fetchImpl || globalThis.fetch;
  const res = await f((opts.apiBase || '') + '/api/translate', {
    method:'POST', headers:{ 'content-type':'application/json' },
    body: JSON.stringify({ text, langs }),
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('the server sent back something that is not JSON (' + res.status + ')'); }
  if (!res.ok) throw new Error(data.error || ('translation failed with status ' + res.status));
  if (!data.text || !data.text.trim()) throw new Error('the translator sent back nothing');
  return { text:data.text, langs, failed:data.failed || 0 };
}

/**
 * The whole text bench. Returns { text, found, artifacts, chain, translated }.
 * onStatus(msg) and onStage(index, bytes) are for the UI; both are optional.
 */
export async function runTextPipeline(opts) {
  const { raw, dest = 'doc', translate = false, extraFindings = [] } = opts;
  const onStatus = opts.onStatus || (() => {});
  const onStage = opts.onStage || (() => {});

  // The chain is settled first so the UI can draw the rail before the slow part starts.
  const mid = opts.mid || pick(INTERMEDIATES.filter(f => f !== dest), 3);
  const chain = [
    { fmt:'txt',  note:'source text' },
    { fmt:mid[0], note:'pass one' },
    { fmt:mid[1], note:'pass two' },
    { fmt:mid[2], note:'pass three' },
    { fmt:dest,   note:'the file you keep' },
  ].map(s => ({ ...s, name:FORMATS[s.fmt].name }));
  if (opts.onChain) opts.onChain(chain);

  const swept = clean(raw);
  let text = swept.text;
  const found = [...extraFindings, ...swept.found];
  let translated = false;

  if (translate) {
    const t0 = Date.now();
    onStatus('Translating there and back, usually 15 to 40 seconds…');
    try {
      const t = await roundTrip(text, opts);
      // the translator sometimes welds sentences together; two lowercase letters before the stop keeps "U.S.A." safe
      text = clean(t.text.replace(/([a-z]{2}[.!?])([A-Z])/g, '$1 $2')).text;
      translated = true;
      const secs = Math.round((Date.now() - t0) / 1000);
      found.push({ count:3, label:'Translated english → ' + t.langs[0] + ' → ' + t.langs[1] + ' → english (' + secs + 's)', act:'rewritten' });
      if (t.failed) found.push({ count:t.failed, label:'Paragraphs the translator skipped, left in english', act:'passed through' });
      onStatus('Translated through ' + t.langs.join(' and ') + '.');
    } catch (err) {
      found.push({ count:0, label:'Translation failed: ' + err.message, act:'not run' });
      onStatus('Translation failed: ' + err.message, true);
    }
  }

  // Each step really serialises to its format and parses back before the next one.
  const artifacts = [];
  for (let i = 0; i < chain.length; i++) {
    const f = FORMATS[chain[i].fmt];
    const body = f.to(text);
    const artifact = { fmt:chain[i].fmt, name:'textlab-' + (i + 1) + '.' + f.ext, body, mime:f.mime };
    artifacts.push(artifact);
    await onStage(i, artifact);
    if (i < chain.length - 1) text = f.from(body);
  }

  return { text:FORMATS[dest].from(artifacts[4].body), found, artifacts, chain, translated };
}
