// Static assets are served by the ASSETS binding; this only handles /api/translate.
const LANGS = ['spanish','russian','french','german','japanese','portuguese','italian',
               'korean','turkish','dutch','polish','swedish','indonesian','vietnamese'];
const MAX_CHARS = 12000, CHUNK = 1200, MAX_CHUNKS = 12;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// Split on blank lines, then hard-wrap anything still over the chunk size.
function chunk(text) {
  const out = [];
  for (const p of text.split(/\n{2,}/)) {
    for (let i = 0; i < p.length || i === 0; i += CHUNK) out.push(p.slice(i, i + CHUNK));
  }
  return out.filter(s => s.trim());
}

async function hop(env, text, source_lang, target_lang) {
  const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang, target_lang });
  return (r && r.translated_text || '').trim() || text;   // a failed hop passes the text through
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/api/translate') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
    const text = typeof body.text === 'string' ? body.text : '';
    const hops = (Array.isArray(body.langs) ? body.langs : []).filter(l => LANGS.includes(l)).slice(0, 2);

    if (!text.trim()) return json({ error: 'no text' }, 400);
    if (hops.length !== 2) return json({ error: 'need two supported languages' }, 400);
    if (text.length > MAX_CHARS) return json({ error: `text over the ${MAX_CHARS} character round-trip limit` }, 413);

    const parts = chunk(text);
    if (parts.length > MAX_CHUNKS) return json({ error: 'too many paragraphs for one round-trip' }, 413);

    const route = ['english', ...hops, 'english'];
    let cur = parts;
    for (let i = 1; i < route.length; i++) {
      cur = await Promise.all(cur.map(p => hop(env, p, route[i - 1], route[i])));
    }
    return json({ text: cur.join('\n\n'), route });
  },
};
