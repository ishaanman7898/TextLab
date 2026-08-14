// Static assets are served by the ASSETS binding; this handles the API routes.
const MODEL = '@cf/meta/m2m100-1.2b';
const CHECK_MODEL = '@cf/meta/llama-3.2-3b-instruct';
const LANGS = ['spanish','russian','french','german','japanese','portuguese','italian',
               'korean','turkish','dutch','polish','swedish','indonesian','vietnamese'];
const MAX_CHARS = 12000, CHUNK = 1200, MAX_CHUNKS = 16, LANES = 3, CHECK_SLICE = 1500;

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

// A hop that fails passes its text through untranslated rather than sinking the whole request.
async function hop(env, text, source_lang, target_lang) {
  try {
    const r = await env.AI.run(MODEL, { text, source_lang, target_lang });
    const out = (r && r.translated_text || '').trim();
    return out ? { text: out, ok: true } : { text, ok: false };
  } catch (err) {
    return { text, ok: false, err: String(err && err.message || err).slice(0, 120) };
  }
}

// A second, smaller model reads the before/after and flags translations that drifted off meaning.
// Best-effort: if this model is unavailable or errors, the translation itself still stands.
async function checkMeaning(env, original, translated) {
  try {
    const r = await env.AI.run(CHECK_MODEL, {
      messages: [
        { role: 'system', content: 'Compare an original passage with a translated-and-back version of it. ' +
          'Reply with exactly one line: "MATCH" if the general meaning still holds, or "DRIFT: " followed by ' +
          'a reason under 20 words if it does not. Minor rewording is fine; only flag real meaning changes.' },
        { role: 'user', content: 'ORIGINAL:\n' + original.slice(0, CHECK_SLICE) + '\n\nTRANSLATED:\n' + translated.slice(0, CHECK_SLICE) },
      ],
    });
    const out = (r && r.response || '').trim();
    if (!out) return null;
    const drift = /^drift/i.test(out);
    const note = out.replace(/^(match|drift)\s*:?\s*/i, '').trim();
    return { ok: !drift, note: note.slice(0, 160) };   // empty note means the model gave a bare verdict with no extra reasoning
  } catch {
    return null;
  }
}

// Workers AI throttles hard when everything is fired at once, so keep a few lanes open at most.
async function inLanes(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Lets the page tell "the API is missing" apart from "the model misbehaved".
    if (pathname === '/api/health') {
      return json({ ok: true, ai: typeof (env.AI && env.AI.run) === 'function', model: MODEL, checkModel: CHECK_MODEL, langs: LANGS.length });
    }

    if (pathname !== '/api/translate') return json({ error: 'no such route: ' + pathname }, 404);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
    const text = typeof body.text === 'string' ? body.text : '';
    const hops = (Array.isArray(body.langs) ? body.langs : []).filter(l => LANGS.includes(l)).slice(0, 2);

    if (!text.trim()) return json({ error: 'no text' }, 400);
    if (hops.length !== 2) return json({ error: 'need two supported languages' }, 400);
    if (text.length > MAX_CHARS) return json({ error: `text is ${text.length} characters, the round-trip limit is ${MAX_CHARS}` }, 413);
    if (!env.AI || typeof env.AI.run !== 'function') return json({ error: 'this deployment has no Workers AI binding' }, 503);

    const parts = chunk(text);
    if (parts.length > MAX_CHUNKS) return json({ error: `${parts.length} paragraphs is over the ${MAX_CHUNKS} the round-trip will take at once` }, 413);

    const route = ['english', ...hops, 'english'];
    let cur = parts, failed = 0, lastErr = null;
    for (let i = 1; i < route.length; i++) {
      const done = await inLanes(cur, p => hop(env, p, route[i - 1], route[i]));
      for (const d of done) if (!d.ok) { failed++; lastErr = d.err || lastErr; }
      cur = done.map(d => d.text);
    }

    // Every hop failing means nothing was translated, and the caller should hear about it.
    if (failed >= parts.length * 3) return json({ error: 'the translation model returned nothing' + (lastErr ? ': ' + lastErr : '') }, 502);

    const final = cur.join('\n\n');
    const check = await checkMeaning(env, text, final);
    return json({ text: final, route, chunks: parts.length, failed, check });
  },
};
