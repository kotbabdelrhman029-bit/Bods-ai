// bods AI — Cloudflare Worker (بيخبّي مفاتيحك ويشغّل الذكاء الاصطناعي للتطبيق من غير ما المستخدم يحط مفاتيح)
// الاستخدام: Cloudflare ← Workers & Pages ← Create ← Worker ← Edit code ← الصق الملف ده ← Deploy
// بعدها: Settings ← Variables and Secrets ← ضيف المفاتيح كـ Secrets (GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY)
// اختياري: MAKER_NAME, DAILY_LIMIT (الافتراضي 40), ALLOWED_ORIGINS, وأسماء الموديلات (GEMINI_MODEL, GEMINI_DEEP_MODEL, OPENAI_MODEL, ...)

const BUSY = 'الخدمة مشغولة دلوقتي، جرّب بعد شوية.';
const BASE = 'أنت bods AI، مساعد ذكاء اصطناعي ودود وذكي جدًا. رد بنفس لغة المستخدم. فكّر خطوة بخطوة في المسائل الصعبة، وخلّي إجابتك دقيقة ومباشرة ومرتبة، ولو مش متأكد قول كده بصراحة. استخدم أمثلة وأكواد كاملة لما تفيد. لو سألوك عن الموديل اللي بيشغّلك، قول إنك مساعد ذكاء اصطناعي بيشتغل على نماذج لغوية كبيرة. ماتقولش إنك إنسان.';
const EXTRA = {
  design: ' أنت مصمم ومطوّر ويب محترف. لما المستخدم يطلب صفحة أو عرض تقديمي أو بوستر أو تطبيق ويب: رجّع كود HTML واحد كامل داخل كتلة ```html واحدة (CSS وJS جواه، من غير أي مكتبات أو صور أو خطوط خارجية)، متجاوب مع الموبايل، RTL لو المحتوى عربي، بتصميم عصري وألوان متناسقة، وبعدها جملتين بس عن اللي عملته. للعروض التقديمية اعملها شرايح بأزرار تالي وسابق.',
  code: ' أنت في وضع المبرمج: اكتب كود نظيف وكامل داخل كتل كود، واشرح بإيجاز، ونبّه على أي أخطاء أو مخاطر أمنية.',
  agent: ' أنت في وضع الوكيل: قسّم المهمة لخطوات مرقّمة واضحة، ونفّذ اللي تقدر تنفّذه في ردك، واكتب بوضوح الخطوات اللي محتاجة المستخدم يعملها بنفسه. ماتدّعيش إنك نفّذت حاجة على الإنترنت أو على جهازه.'
};
const KEYS = { chatgpt: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY', perplexity: 'PERPLEXITY_API_KEY', grok: 'XAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' };
const PREF = {
  fast: ['gemini', 'chatgpt', 'deepseek', 'grok', 'claude', 'perplexity'],
  deep: ['claude', 'gemini', 'chatgpt', 'deepseek', 'grok', 'perplexity'],
  search: ['gemini', 'perplexity', 'chatgpt', 'deepseek', 'claude', 'grok']
};
const VISION = ['gemini', 'chatgpt', 'claude'];

const model = (env, k, tier) => ({
  chatgpt: tier === 'deep' ? (env.OPENAI_DEEP_MODEL || env.OPENAI_MODEL || 'gpt-4o') : (env.OPENAI_MODEL || 'gpt-4o-mini'),
  gemini: tier === 'deep' ? (env.GEMINI_DEEP_MODEL || 'gemini-pro-latest') : (env.GEMINI_MODEL || 'gemini-flash-latest'),
  claude: tier === 'deep' ? (env.CLAUDE_DEEP_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-5-5') : (env.CLAUDE_MODEL || 'claude-sonnet-5-5'),
  deepseek: tier === 'deep' ? (env.DEEPSEEK_DEEP_MODEL || 'deepseek-reasoner') : (env.DEEPSEEK_MODEL || 'deepseek-chat'),
  grok: env.XAI_MODEL || 'grok-4',
  perplexity: env.PERPLEXITY_MODEL || 'sonar'
})[k];

// ---------- مساعدات ----------
const imgRe = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const cleanImages = a => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x.length < 6e6 && imgRe.test(x)).slice(0, 4);
const parts = u => { const m = imgRe.exec(u); return { mime: m[1], data: m[2] }; };
const toOAI = m => m.map(x => x.images?.length ? { role: x.role, content: [{ type: 'text', text: x.content }, ...x.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] } : { role: x.role, content: x.content });
const toClaude = m => m.map(x => x.images?.length ? { role: x.role, content: [...x.images.map(u => { const p = parts(u); return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }; }), { type: 'text', text: x.content }] } : { role: x.role, content: x.content });
const toGemini = m => m.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }, ...(x.images || []).map(u => { const p = parts(u); return { inline_data: { mime_type: p.mime, data: p.data } }; })] }));

function cors(req, env) {
  const o = req.headers.get('origin') || '';
  const allow = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
  const ok = allow.includes('*') || allow.includes(o) || ['https://localhost', 'http://localhost', 'capacitor://localhost'].includes(o);
  return { 'access-control-allow-origin': ok ? (allow.includes('*') ? '*' : o) : 'null', 'access-control-allow-headers': 'content-type, x-device, authorization', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', vary: 'origin' };
}
const json = (o, h, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...h, 'content-type': 'application/json; charset=utf-8' } });

const mem = new Map();
async function charge(req, env, cost) {
  const lim = +env.DAILY_LIMIT || 40, day = new Date().toISOString().slice(0, 10);
  const dev = (req.headers.get('x-device') || '').replace(/[^\w-]/g, '').slice(0, 64);
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const slots = [['d:' + dev, lim], ['i:' + ip, lim * 3]].filter(s => s[0] !== 'd:');
  const get = async k => env.KV ? (+(await env.KV.get(k)) || 0) : (mem.get(k) || 0);
  for (const [id, max] of slots) if ((await get('q:' + day + ':' + id)) + cost > max) return false;
  for (const [id] of slots) {
    const k = 'q:' + day + ':' + id, n = (await get(k)) + cost;
    if (env.KV) await env.KV.put(k, String(n), { expirationTtl: 172800 }); else { mem.set(k, n); if (mem.size > 5000) mem.clear(); }
  }
  return true;
}

async function call(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error?.message || d.message || 'HTTP ' + r.status); }
  return r;
}
async function* sseJson(body) {
  const rd = body.getReader(), dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const v = line.slice(5).trim(); if (!v || v === '[DONE]') continue;
      try { yield JSON.parse(v); } catch {}
    }
  }
}
async function* oai(url, key, mdl, m, sys) {
  const r = await call(url, { Authorization: 'Bearer ' + key }, { model: mdl, stream: true, messages: [{ role: 'system', content: sys }, ...toOAI(m)] });
  let cites;
  for await (const d of sseJson(r.body)) { if (d.citations) cites = d.citations; const t = d.choices?.[0]?.delta?.content; if (t) yield t; }
  if (cites?.length) yield '\n\n**المصادر:**\n\n' + cites.map(c => '- ' + c).join('\n');
}
const providers = {
  chatgpt: (env, m, sys, tier) => oai('https://api.openai.com/v1/chat/completions', env.OPENAI_API_KEY, model(env, 'chatgpt', tier), m, sys),
  grok: (env, m, sys, tier) => oai('https://api.x.ai/v1/chat/completions', env.XAI_API_KEY, model(env, 'grok', tier), m, sys),
  deepseek: (env, m, sys, tier) => oai('https://api.deepseek.com/chat/completions', env.DEEPSEEK_API_KEY, model(env, 'deepseek', tier), m, sys),
  perplexity: (env, m, sys, tier) => oai('https://api.perplexity.ai/chat/completions', env.PERPLEXITY_API_KEY, model(env, 'perplexity', tier), m, sys),
  async *claude(env, m, sys, tier) {
    const r = await call('https://api.anthropic.com/v1/messages', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: model(env, 'claude', tier), max_tokens: 2000, stream: true, system: sys, messages: toClaude(m) });
    for await (const d of sseJson(r.body)) if (d.type === 'content_block_delta' && d.delta?.text) yield d.delta.text;
  },
  async *gemini(env, m, sys, tier, mode) {
    const body = { systemInstruction: { parts: [{ text: sys }] }, contents: toGemini(m) };
    if (mode === 'search') body.tools = [{ google_search: {} }];
    const r = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model(env, 'gemini', tier)}:streamGenerateContent?alt=sse`, { 'x-goog-api-key': env.GEMINI_API_KEY }, body);
    for await (const d of sseJson(r.body)) { const t = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''); if (t) yield t; }
  }
};
const have = (env, k) => !!env[KEYS[k]];
const resolveMode = (mode, text, kind) => PREF[mode] ? mode
  : (kind === 'code' || kind === 'agent' || kind === 'design') ? 'deep'
  : /اخبار|أخبار|النهارده|دلوقتي|آخر|سعر|طقس|news|today|latest|price/i.test(text) ? 'search'
  : /```|كود|برمج|function|bug|error|python|javascript|html|css|sql|code|حلل|اشرح بالتفصيل|ليه|كيف|why|how|explain/i.test(text) && text.length > 60 ? 'deep'
  : /```|كود|برمج|function|bug|error|python|javascript|html|css|sql|code/i.test(text) ? 'deep' : 'fast';


// ================= الحسابات: دخول بجوجل وفيسبوك وجيت هوب وX + قاعدة بيانات (KV) =================
// مطلوب: ربط KV باسم KV، و Secret باسم SESSION_SECRET (أي نص عشوائي طويل)، و APP_URLS (روابط موقعك/تطبيقك المسموح الرجوع ليها).
const OAUTH = {
  google: { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', user: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET', map: u => ({ id: u.sub, name: u.name, email: u.email, avatar: u.picture }) },
  github: { auth: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', user: 'https://api.github.com/user', scope: 'read:user user:email', id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET', map: u => ({ id: String(u.id), name: u.name || u.login, email: u.email || '', avatar: u.avatar_url }) },
  facebook: { auth: 'https://www.facebook.com/dialog/oauth', token: 'https://graph.facebook.com/oauth/access_token', user: 'https://graph.facebook.com/me?fields=id,name,email,picture', scope: 'public_profile,email', id: 'FACEBOOK_CLIENT_ID', secret: 'FACEBOOK_CLIENT_SECRET', map: u => ({ id: u.id, name: u.name, email: u.email || '', avatar: u.picture?.data?.url }) },
  x: { auth: 'https://twitter.com/i/oauth2/authorize', token: 'https://api.twitter.com/2/oauth2/token', user: 'https://api.twitter.com/2/users/me?user.fields=profile_image_url', scope: 'users.read tweet.read', id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET', pkce: true, basic: true, map: u => ({ id: u.data.id, name: u.data.name || u.data.username, email: '', avatar: u.data.profile_image_url }) }
};
const providersOn = env => Object.keys(OAUTH).filter(p => env[OAUTH[p].id] && env[OAUTH[p].secret]);
const accountsOn = env => !!(env.KV && env.SESSION_SECRET && providersOn(env).length);
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
async function hmac(env, data) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}
async function signTok(env, uid) { const p = b64u(new TextEncoder().encode(JSON.stringify({ u: uid, e: Date.now() + 30 * 864e5 }))); return p + '.' + await hmac(env, p); }
async function userOf(req, env) {
  if (!accountsOn(env)) return null;
  const [p, m] = (req.headers.get('authorization') || '').replace(/^Bearer /, '').split('.');
  if (!p || !m || (await hmac(env, p)) !== m) return null;
  try {
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
    if (o.e < Date.now()) return null;
    const u = await env.KV.get('user:' + o.u, 'json'); return u ? { ...u, id: o.u } : null;
  } catch { return null; }
}
const pubUser = u => ({ name: u.name, email: u.email || u.id, avatar: u.avatar });
const okRedirect = (env, r) => [...String(env.APP_URLS || '').split(',').map(x => x.trim()).filter(Boolean), 'ai.bods.app://auth', 'https://localhost'].some(a => r === a || r.startsWith(a + '/') || r.startsWith(a + '?') || r.startsWith(a + '#'));
const back = (r, frag) => Response.redirect(r + (r.includes('#') ? '&' : '#') + frag, 302);

async function authStart(req, env, p) {
  const c = OAUTH[p], url = new URL(req.url), redirect = url.searchParams.get('redirect') || '';
  if (!c || !providersOn(env).includes(p) || !accountsOn(env)) return new Response('الدخول بالطريقة دي مش مفعّل', { status: 404 });
  if (!okRedirect(env, redirect)) return new Response('رابط الرجوع مش مسموح', { status: 400 });
  const state = rand(24), verifier = rand(32);
  await env.KV.put('s:' + state, JSON.stringify({ p, redirect, verifier }), { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env[c.id], redirect_uri: url.origin + '/auth/' + p + '/callback', response_type: 'code', scope: c.scope, state });
  if (c.pkce) { q.set('code_challenge', b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))); q.set('code_challenge_method', 'S256'); }
  return Response.redirect(c.auth + '?' + q, 302);
}
async function authCallback(req, env, p) {
  const c = OAUTH[p], url = new URL(req.url), st = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  const saved = st ? await env.KV.get('s:' + st, 'json') : null;
  if (!saved || saved.p !== p) return new Response('الجلسة انتهت، ارجع جرّب تاني', { status: 400 });
  await env.KV.delete('s:' + st);
  try {
    if (!code) throw new Error('no code');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: url.origin + '/auth/' + p + '/callback', client_id: env[c.id] });
    const hd = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (c.basic) hd.authorization = 'Basic ' + btoa(env[c.id] + ':' + env[c.secret]); else body.set('client_secret', env[c.secret]);
    if (c.pkce) body.set('code_verifier', saved.verifier);
    const tk = await (await fetch(c.token, { method: 'POST', headers: hd, body })).json();
    if (!tk.access_token) throw new Error('no token');
    const pr = c.map(await (await fetch(c.user, { headers: { authorization: 'Bearer ' + tk.access_token, 'user-agent': 'bods-ai', accept: 'application/json' } })).json());
    if (!pr.id) throw new Error('no profile');
    const uid = p + ':' + pr.id;
    await env.KV.put('user:' + uid, JSON.stringify({ provider: p, name: String(pr.name || '').slice(0, 60), email: String(pr.email || '').slice(0, 120), avatar: pr.avatar || '' }));
    return back(saved.redirect, 'token=' + encodeURIComponent(await signTok(env, uid)));
  } catch (e) { console.log('[auth]', p, e.message); return back(saved.redirect, 'error=login_failed'); }
}
async function saveConv(env, uid, id, kind, msgs, full) {
  const cid = id && /^[\w-]{6,40}$/.test(id) && await env.KV.get('conv:' + uid + ':' + id) ? id : rand(9);
  const messages = [...msgs.map(({ role, content }) => ({ role, content })), { role: 'assistant', content: full }];
  const title = String((msgs[0] && msgs[0].content) || 'محادثة').slice(0, 40), updated = Date.now();
  await env.KV.put('conv:' + uid + ':' + cid, JSON.stringify({ id: cid, kind, title, messages, updated }), { metadata: { title, kind, updated } });
  return cid;
}
async function accountApi(req, env, url, h) {
  const u = await userOf(req, env), p = url.pathname;
  if (p === '/api/report' && req.method === 'POST') { const b = await req.json().catch(() => ({})); await env.KV?.put('report:' + Date.now() + ':' + rand(4), JSON.stringify({ u: u?.id || null, text: String(b.text || '').slice(0, 4000), note: String(b.note || '').slice(0, 500) }), { expirationTtl: 2592000 }); return json({ ok: true }, h); }
  if (!u) return json({ error: 'سجّل دخولك الأول' }, h, 401);
  if (p === '/api/me') return json({ user: pubUser(u) }, h);
  if (p === '/api/account' && req.method === 'DELETE') {
    const ks = await env.KV.list({ prefix: 'conv:' + u.id + ':' }); for (const k of ks.keys) await env.KV.delete(k.name);
    await env.KV.delete('user:' + u.id); return json({ ok: true }, h);
  }
  if (p === '/api/convs' && req.method === 'GET') {
    const ks = await env.KV.list({ prefix: 'conv:' + u.id + ':' });
    return json(ks.keys.map(k => ({ id: k.name.split(':').pop(), ...(k.metadata || {}) })).sort((a, b) => (b.updated || 0) - (a.updated || 0)), h);
  }
  const m = /^\/api\/convs\/([\w-]+)$/.exec(p);
  if (m) {
    const key = 'conv:' + u.id + ':' + m[1];
    if (req.method === 'DELETE') { await env.KV.delete(key); return json({ ok: true }, h); }
    const c = await env.KV.get(key, 'json'); return c ? json(c, h) : json({ error: 'المحادثة مش موجودة' }, h, 404);
  }
  return json({ error: 'not found' }, h, 404);
}

async function chat(req, env, ctx, h) {
  const b = await req.json().catch(() => ({}));
  const kind = ['chat', 'code', 'agent', 'design'].includes(b.kind) ? b.kind : 'chat';
  const msgs = Array.isArray(b.messages) ? b.messages : [];
  if (!msgs.length) return json({ error: 'طلب غير صحيح' }, h, 400);
  const all = msgs.slice(-60).map((x, i, a) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, i === a.length - 1 ? 40000 : 8000) }));
  const last = msgs[msgs.length - 1], imgs = last && last.role !== 'assistant' ? cleanImages(last.images) : [];
  if (imgs.length) all[all.length - 1].images = imgs;
  const mode = resolveMode(b.mode, all[all.length - 1].content, kind), tier = mode === 'deep' ? 'deep' : 'fast';
  let cands = PREF[mode].filter(k => have(env, k));
  if (imgs.length) cands = cands.filter(k => VISION.includes(k));
  if (!cands.length) return json({ error: imgs.length ? 'تحليل الصور مش متاح حاليًا' : BUSY }, h, 503);
  if (!(await charge(req, env, 1))) return json({ error: 'خلّصت حدّك اليومي. تعالى بكرة 👋' }, h, 429);
  const user = await userOf(req, env);
  const cx = String(b.ctx || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 3000);
  const sys = BASE + (env.MAKER_NAME ? ' لو سألوك مين عمل التطبيق أو الموقع، قول إنه من تطوير ' + env.MAKER_NAME + '.' : '') + (EXTRA[kind] || '') + (cx ? ' ' + cx : '');
  const { readable, writable } = new TransformStream(), w = writable.getWriter(), enc = new TextEncoder();
  const out = o => w.write(enc.encode('data: ' + JSON.stringify(o) + '\n\n'));
  ctx.waitUntil((async () => {
    let started = false, lastErr, ok = false, full = '';
    try {
      for (const k of cands) {
        try { for await (const t of providers[k](env, all.slice(-30), sys, tier, mode)) { started = true; ok = true; full += t; await out({ t }); } break; }
        catch (e) { lastErr = e; console.log('[chat]', k, e.message); if (started) break; }
      }
      if (!ok) throw lastErr || new Error('empty');
      let cid; if (user && full) { try { cid = await saveConv(env, user.id, b.convId, kind, all, full); } catch (e) { console.log('[save]', e.message); } }
      await out({ done: true, convId: cid });
    } catch (e) { await out({ error: BUSY }); }
    finally { await w.close(); }
  })());
  return new Response(readable, { headers: { ...h, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}

async function videoStart(req, env, h) {
  if (env.ENABLE_VIDEO !== '1' || !have(env, 'gemini')) return json({ error: 'توليد الفيديو مش مفعّل' }, h, 503);
  const b = await req.json().catch(() => ({})), p = String(b.prompt || '').slice(0, 1500).trim();
  if (!p) return json({ error: 'اكتب وصف الفيديو الأول' }, h, 400);
  if (!(await charge(req, env, 20))) return json({ error: 'خلّصت حدّك اليومي. تعالى بكرة 👋' }, h, 429);
  try {
    const r = await call(`https://generativelanguage.googleapis.com/v1beta/models/${env.VEO_MODEL || 'veo-3.0-fast-generate-001'}:predictLongRunning`, { 'x-goog-api-key': env.GEMINI_API_KEY },
      { instances: [{ prompt: p }], parameters: { aspectRatio: b.ratio === '9:16' ? '9:16' : '16:9' } });
    const d = await r.json(); if (!d.name) throw new Error('no operation');
    return json({ op: d.name }, h);
  } catch (e) {
    console.log('[video]', e.message);
    return json({ error: /billing|quota|permission|not found|404|403|not supported/i.test(e.message) ? 'الفيديو محتاج مفتاح Gemini مفعّل عليه الفوترة، أو الموديل مش متاح.' : BUSY }, h, 502);
  }
}
async function videoPoll(url, env, h) {
  const op = url.searchParams.get('op') || '';
  if (env.ENABLE_VIDEO !== '1' || !have(env, 'gemini') || !/^models\/[\w.\-]+\/operations\/[\w\-]+$/.test(op)) return json({ error: 'طلب غير صحيح' }, h, 400);
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/' + op, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error?.message || 'HTTP ' + r.status);
    if (!d.done) return json({ done: false }, h);
    if (d.error) return json({ error: 'الفيديو فشل: ' + String(d.error.message || '').slice(0, 120) }, h, 502);
    const uri = d.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (!uri) return json({ error: 'الفيديو اتحجب أو مارجعش نتيجة. جرّب وصف تاني.' }, h, 502);
    const v = await fetch(uri, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    if (!v.ok) throw new Error('download ' + v.status);
    const buf = new Uint8Array(await v.arrayBuffer());
    if (buf.length > 25e6) return json({ error: 'الفيديو كبير قوي' }, h, 502);
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return json({ done: true, video: 'data:video/mp4;base64,' + btoa(s) }, h);
  } catch (e) { console.log('[video poll]', e.message); return json({ error: BUSY }, h, 502); }
}
async function image(req, env, h) {
  const b = await req.json().catch(() => ({})), p = String(b.prompt || '').slice(0, 2000).trim();
  if (!p) return json({ error: 'اكتب وصف الصورة الأول' }, h, 400);
  if (!have(env, 'gemini') && !have(env, 'chatgpt')) return json({ error: 'الميزة دي مش متاحة حاليًا' }, h, 503);
  if (!(await charge(req, env, 3))) return json({ error: 'خلّصت حدّك اليومي. تعالى بكرة 👋' }, h, 429);
  if (have(env, 'gemini')) {
    try {
      const r = await call(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image'}:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY },
        { contents: [{ parts: [{ text: p }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
      const d = await r.json(), part = d.candidates[0].content.parts.find(x => x.inlineData || x.inline_data), i = part.inlineData || part.inline_data;
      return json({ image: `data:${i.mimeType || i.mime_type};base64,${i.data}` }, h);
    } catch (e) { console.log('[image] gemini', e.message); }
  }
  if (have(env, 'chatgpt')) {
    try {
      const r = await call('https://api.openai.com/v1/images/generations', { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, { model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt: p, size: '1024x1024' });
      const x = (await r.json()).data[0];
      return json({ image: x.b64_json ? 'data:image/png;base64,' + x.b64_json : x.url }, h);
    } catch (e) { console.log('[image] openai', e.message); }
  }
  return json({ error: BUSY }, h, 502);
}

async function transcribe(req, env, h) {
  const b = await req.json().catch(() => ({})), m = /^data:(audio\/[\w.+-]+)(?:;[^,]*)?;base64,(.+)$/.exec(String(b.audio || ''));
  if (!m || m[2].length > 16e6) return json({ error: 'ملف الصوت مش صالح أو كبير' }, h, 400);
  if (!have(env, 'chatgpt')) return json({ error: 'الميزة دي مش متاحة حاليًا' }, h, 503);
  if (!(await charge(req, env, 2))) return json({ error: 'خلّصت حدّك اليومي. تعالى بكرة 👋' }, h, 429);
  try {
    const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0)), ext = /mp4|m4a/.test(m[1]) ? 'm4a' : /mpeg|mp3/.test(m[1]) ? 'mp3' : /wav/.test(m[1]) ? 'wav' : /ogg/.test(m[1]) ? 'ogg' : 'webm';
    const fd = new FormData(); fd.append('file', new Blob([bin], { type: m[1] }), 'audio.' + ext); fd.append('model', env.OPENAI_STT_MODEL || 'whisper-1');
    const lang = String(b.lang || '').slice(0, 2); if (/^[a-z]{2}$/.test(lang)) fd.append('language', lang);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: fd });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error?.message || 'HTTP ' + r.status);
    return json({ text: String(d.text || '').slice(0, 20000) }, h);
  } catch (e) { console.log('[stt]', e.message); return json({ error: BUSY }, h, 502); }
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req, env), url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      if (url.pathname === '/api/status') return json({ chat: Object.keys(KEYS).some(k => have(env, k)), image: have(env, 'gemini') || have(env, 'chatgpt'), video: env.ENABLE_VIDEO === '1' && have(env, 'gemini'), audio: false, stt: have(env, 'chatgpt'), login: false, accounts: accountsOn(env), providers: accountsOn(env) ? providersOn(env) : [], limit: +env.DAILY_LIMIT || 40 }, h);
      const am = /^\/auth\/(\w+)\/(start|callback)$/.exec(url.pathname);
      if (am && OAUTH[am[1]]) return am[2] === 'start' ? await authStart(req, env, am[1]) : await authCallback(req, env, am[1]);
      if (/^\/api\/(me|convs|account|report)/.test(url.pathname)) return await accountApi(req, env, url, h);
      if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, env, ctx, h);
      if (req.method === 'POST' && url.pathname === '/api/video') return await videoStart(req, env, h);
      if (req.method === 'GET' && url.pathname === '/api/video') return await videoPoll(url, env, h);
      if (req.method === 'POST' && url.pathname === '/api/image') return await image(req, env, h);
      if (req.method === 'POST' && url.pathname === '/api/transcribe') return await transcribe(req, env, h);
      if (url.pathname === '/' ) return new Response('bods AI API ✓', { headers: { ...h, 'content-type': 'text/plain; charset=utf-8' } });
      return json({ error: 'not found' }, h, 404);
    } catch (e) { console.log('[err]', e.message); return json({ error: BUSY }, h, 500); }
  }
};
