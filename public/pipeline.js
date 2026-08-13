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
};

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
    { fmt:'txt',  note:'extracted source' },
    { fmt:mid[0], note:'first conversion' },
    { fmt:mid[1], note:'second conversion' },
    { fmt:mid[2], note:'third conversion' },
    { fmt:dest,   note:'your destination' },
  ].map(s => ({ ...s, name:FORMATS[s.fmt].name }));
  if (opts.onChain) opts.onChain(chain);

  const swept = clean(raw);
  let text = swept.text;
  const found = [...extraFindings, ...swept.found];
  let translated = false;

  if (translate) {
    const t0 = Date.now();
    onStatus('Round-trip running, this takes 15 to 40 seconds…');
    try {
      const t = await roundTrip(text, opts);
      // the translator sometimes welds sentences together; two lowercase letters before the stop keeps "U.S.A." safe
      text = clean(t.text.replace(/([a-z]{2}[.!?])([A-Z])/g, '$1 $2')).text;
      translated = true;
      const secs = Math.round((Date.now() - t0) / 1000);
      found.push({ count:3, label:'Round-trip: english → ' + t.langs[0] + ' → ' + t.langs[1] + ' → english (' + secs + 's)', act:'rewritten' });
      if (t.failed) found.push({ count:t.failed, label:'Paragraphs the translator could not process, left in english', act:'passed through' });
      onStatus('Round-trip done via ' + t.langs.join(' and ') + '.');
    } catch (err) {
      found.push({ count:0, label:'Round-trip failed: ' + err.message, act:'not run' });
      onStatus('Round-trip failed: ' + err.message, true);
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
