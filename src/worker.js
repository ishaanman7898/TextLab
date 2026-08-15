// Static assets are served by the ASSETS binding; this handles the API routes.
// An instruct LLM reads more fluently than a dedicated seq2seq translation model and, at fp8,
// is billed cheaper per token too: https://developers.cloudflare.com/workers-ai/platform/pricing/
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const NEURONS_PER_M_INPUT = 13778, NEURONS_PER_M_OUTPUT = 26128;   // Cloudflare's published rate for MODEL
const LANGS = ['spanish','russian','french','german','japanese','portuguese','italian',
               'korean','turkish','dutch','polish','swedish','indonesian','vietnamese'];
const MAX_CHARS = 12000, CHUNK = 1200, MAX_CHUNKS = 16, LANES = 3;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const sysPrompt = (source_lang, target_lang) =>
  `Translate the user's message from ${source_lang} to ${target_lang}. ` +
  'Reply with only the translation itself: no preamble, no notes, no quotation marks, nothing else.';

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
    const r = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: sysPrompt(source_lang, target_lang) },
        { role: 'user', content: text },
      ],
      max_tokens: 2048,
      temperature: 0.2,
    });
    const out = (r && r.response || '').trim().replace(/^["'“‘]+|["'”’]+$/g, '');
    const usage = (r && r.usage) || {};
    const neurons = (usage.prompt_tokens || 0) / 1e6 * NEURONS_PER_M_INPUT +
                    (usage.completion_tokens || 0) / 1e6 * NEURONS_PER_M_OUTPUT;
    return out ? { text: out, ok: true, neurons } : { text, ok: false, neurons };
  } catch (err) {
    return { text, ok: false, neurons: 0, err: String(err && err.message || err).slice(0, 120) };
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
      return json({ ok: true, ai: typeof (env.AI && env.AI.run) === 'function', model: MODEL, langs: LANGS.length });
    }

    if (pathname !== '/api/translate') return json({ error: 'no such route: ' + pathname }, 404);
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
    const text = typeof body.text === 'string' ? body.text : '';
    const hops = (Array.isArray(body.langs) ? body.langs : []).filter(l => LANGS.includes(l)).slice(0, 1);

    if (!text.trim()) return json({ error: 'no text' }, 400);
    if (hops.length !== 1) return json({ error: 'need one supported language' }, 400);
    if (text.length > MAX_CHARS) return json({ error: `text is ${text.length} characters, the round-trip limit is ${MAX_CHARS}` }, 413);
    if (!env.AI || typeof env.AI.run !== 'function') return json({ error: 'this deployment has no Workers AI binding' }, 503);

    const parts = chunk(text);
    if (parts.length > MAX_CHUNKS) return json({ error: `${parts.length} paragraphs is over the ${MAX_CHUNKS} the round-trip will take at once` }, 413);

    const route = ['english', ...hops, 'english'];
    let cur = parts, failed = 0, lastErr = null, neurons = 0;
    for (let i = 1; i < route.length; i++) {
      const done = await inLanes(cur, p => hop(env, p, route[i - 1], route[i]));
      for (const d of done) { if (!d.ok) { failed++; lastErr = d.err || lastErr; } neurons += d.neurons || 0; }
      cur = done.map(d => d.text);
    }

    // Every hop failing means nothing was translated, and the caller should hear about it.
    if (failed >= parts.length * (route.length - 1)) return json({ error: 'the translation model returned nothing' + (lastErr ? ': ' + lastErr : '') }, 502);

    const final = cur.join('\n\n');
    return json({ text: final, route, chunks: parts.length, failed, usage: { neurons: Math.round(neurons), model: MODEL } });
  },
};
