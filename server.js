require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { data, save, hashPw, checkPw, sign, verify, sse, cleanImages, toOAI, toClaude, toGemini } = require('./lib');
data.reports ??= [];
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN !== '0';
const DAILY_LIMIT = +process.env.DAILY_LIMIT || 30;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '16mb' }));
app.use(express.static('public'));

const env = process.env;
const SYS = 'أنت bods AI، مساعد ذكاء اصطناعي متقدم وودود وذكي جداً. رد دائماً بنفس لغة المستخدم (عربي فصيح أو عامية حسب أسلوبه). خليك واضح ومباشر ومرتب، واستخدم قوائم وجداول لما تناسب. فكّر خطوة بخطوة في المسائل الصعبة. لو مش متأكد قول كده بصراحة. لو سألوك إنت مبني على إيه، قول إنك مساعد بيعتمد على مزيج من موديلات الذكاء الاصطناعي المتقدمة. ماتقولش إنك إنسان.' + (process.env.MAKER_NAME ? ' لو سألوك مين عمل التطبيق أو الموقع، قول إنه من تطوير ' + process.env.MAKER_NAME + '.' : '');
const KEYS = {
  chatgpt: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY', grok: 'XAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  'openai-image': 'OPENAI_API_KEY', 'nano-banana': 'GEMINI_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY'
};

// CORS (لتطبيق الموبايل) + حد للطلبات
const hits = new Map();
setInterval(() => hits.clear(), 60000).unref();
const rawOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
const allowAll = rawOrigins.includes('*');
const origins = allowAll ? [] : rawOrigins.concat(['https://localhost', 'http://localhost', 'capacitor://localhost', 'http://localhost:3000']);
app.use('/api', (req, res, next) => {
  const o = req.headers.origin || '';
  if (allowAll) {
    res.set({ 'Access-Control-Allow-Origin': o || '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', Vary: 'Origin' });
  } else if (o && origins.includes(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', Vary: 'Origin' });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
  if (n > (+env.RATE_LIMIT_PER_MIN || 30)) return res.status(429).json({ error: 'طلبات كتير، استنى دقيقة وجرّب تاني' });
  next();
});

async function call(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error?.message || d.message || d.detail?.message || 'HTTP ' + r.status); }
  return r;
}
const post = async (u, h, b) => (await call(u, h, b)).json();

// ===== موديلات المحادثة (رد مباشر) =====
async function* oai(url, key, model, m, sys = SYS) {
  const r = await call(url, { Authorization: 'Bearer ' + key }, { model, stream: true, messages: [{ role: 'system', content: sys }, ...toOAI(m)] });
  let cites;
  for await (const d of sse(r.body)) { if (d.citations) cites = d.citations; const t = d.choices?.[0]?.delta?.content; if (t) yield t; }
  if (cites?.length) yield '\n\n**المصادر:**\n\n' + cites.map(c => '- ' + c).join('\n');
}
const providers = {
  chatgpt: (m, s) => oai('https://api.openai.com/v1/chat/completions', env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o-mini', m, s),
  grok: (m, s) => oai('https://api.x.ai/v1/chat/completions', env.XAI_API_KEY, env.XAI_MODEL || 'grok-4', m, s),
  deepseek: (m, s) => oai('https://api.deepseek.com/chat/completions', env.DEEPSEEK_API_KEY, env.DEEPSEEK_MODEL || 'deepseek-chat', m, s),
  perplexity: (m, s) => oai('https://api.perplexity.ai/chat/completions', env.PERPLEXITY_API_KEY, env.PERPLEXITY_MODEL || 'sonar', m, s),
  claude: async function* (m, s = SYS) {
    const r = await call('https://api.anthropic.com/v1/messages', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 1500, stream: true, system: s, messages: toClaude(m) });
    for await (const d of sse(r.body)) if (d.type === 'content_block_delta' && d.delta?.text) yield d.delta.text;
  },
  gemini: async function* (m, s = SYS) {
    const model = env.GEMINI_MODEL || 'gemini-flash-latest';
    const r = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      { 'x-goog-api-key': env.GEMINI_API_KEY },
      { systemInstruction: { parts: [{ text: s }] }, contents: toGemini(m) });
    for await (const d of sse(r.body)) { const t = d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(''); if (t) yield t; }
  }
};

// ===== الحسابات =====
const userOf = req => { const p = verify((req.headers.authorization || '').slice(7)); return (p && data.users[p.e]) || null; };
const pub = u => ({ email: u.email, name: u.name });
const need = (req, res) => { const u = userOf(req); if (!u) res.status(401).json({ error: 'سجّل دخولك الأول' }); return u; };

app.post('/api/signup', (req, res) => {
  const { email = '', password = '', name = '' } = req.body || {};
  const e = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'الإيميل مش صحيح' });
  if (String(password).length < 8) return res.status(400).json({ error: 'الباسورد لازم يكون 8 حروف على الأقل' });
  if (data.users[e]) return res.status(409).json({ error: 'الإيميل ده مسجّل قبل كده' });
  const u = data.users[e] = { id: crypto.randomUUID(), email: e, name: String(name).trim().slice(0, 40), pw: hashPw(String(password)) };
  save(); res.json({ token: sign(e), user: pub(u) });
});
app.post('/api/login', (req, res) => {
  const e = String(req.body?.email || '').trim().toLowerCase(), u = data.users[e];
  if (!u || !checkPw(String(req.body?.password || ''), u.pw)) return res.status(401).json({ error: 'الإيميل أو الباسورد غلط' });
  res.json({ token: sign(e), user: pub(u) });
});
app.get('/api/me', (req, res) => { const u = need(req, res); if (u) res.json({ user: pub(u) }); });

// ===== المحادثات المحفوظة =====
app.get('/api/convs', (req, res) => {
  const u = need(req, res); if (!u) return;
  res.json(Object.values(data.convs).filter(c => c.uid === u.id).sort((a, b) => b.updated - a.updated)
    .map(({ id, title, model, updated }) => ({ id, title, model, updated })));
});
app.get('/api/convs/:id', (req, res) => {
  const u = need(req, res); if (!u) return;
  const c = data.convs[req.params.id];
  if (!c || c.uid !== u.id) return res.status(404).json({ error: 'المحادثة مش موجودة' });
  res.json(c);
});
app.delete('/api/convs/:id', (req, res) => {
  const u = need(req, res); if (!u) return;
  const c = data.convs[req.params.id];
  if (c && c.uid === u.id) { delete data.convs[req.params.id]; save(); }
  res.json({ ok: true });
});

// ===== الحماية: تسجيل دخول + حد يومي لكل مستخدم =====
const BUSY = 'الخدمة مشغولة دلوقتي، جرّب بعد شوية.';
const gate = (req, res, cost) => {
  const u = userOf(req);
  if (REQUIRE_LOGIN && !u) { res.status(401).json({ error: 'سجّل دخولك الأول علشان تستخدم bods AI' }); return null; }
  if (u) {
    const day = new Date().toISOString().slice(0, 10);
    if (!u.use || u.use.d !== day) u.use = { d: day, n: 0 };
    if (u.use.n + cost > DAILY_LIMIT) { res.status(429).json({ error: 'خلّصت حدّك اليومي. تعالى بكرة 👋' }); return null; }
    u.use.n += cost; save();
  }
  return u || {};
};

// ===== التوجيه التلقائي بين الموديلات (من غير ما المستخدم يشوف الأسماء) =====
const PREF = {
  fast: ['gemini', 'chatgpt', 'deepseek', 'grok', 'claude', 'perplexity'],
  deep: ['claude', 'deepseek', 'chatgpt', 'gemini', 'grok', 'perplexity'],
  search: ['perplexity', 'gemini', 'chatgpt', 'deepseek', 'claude', 'grok']
};
const order = (mode, text, kind) => {
  let m = mode;
  if (!PREF[m]) m = (kind === 'code' || kind === 'agent') ? 'deep' : /اخبار|أخبار|النهارده|دلوقتي|آخر|سعر|طقس|news|today|latest|price/i.test(text) ? 'search'
    : /```|كود|برمج|function|bug|error|python|javascript|html|css|sql|code/i.test(text) ? 'deep' : 'fast';
  return PREF[m].filter(k => env[KEYS[k]]);
};

const EXTRA = {
  design: ' أنت مصمم ومطوّر ويب محترف. لما المستخدم يطلب صفحة أو عرض تقديمي أو بوستر أو تطبيق ويب: رجّع كود HTML واحد كامل داخل كتلة ```html واحدة (CSS وJS جواه، من غير أي مكتبات أو صور أو خطوط خارجية)، متجاوب مع الموبايل، RTL لو المحتوى عربي، بتصميم عصري وألوان متناسقة، وبعدها جملتين بس عن اللي عملته. للعروض التقديمية اعملها شرايح بأزرار تالي وسابق.',
  code: ' أنت في وضع المبرمج: اكتب كود نظيف وكامل داخل كتل كود، واشرح بإيجاز، ونبّه على أي أخطاء أو مخاطر أمنية.',
  agent: ' أنت في وضع الوكيل: قسّم المهمة لخطوات مرقّمة واضحة، ونفّذ اللي تقدر تنفّذه في ردك، واكتب بوضوح الخطوات اللي محتاجة المستخدم يعملها بنفسه. ماتدّعيش إنك نفّذت حاجة على الإنترنت أو على جهازه.'
};
app.post('/api/chat', async (req, res) => {
  const { mode = 'auto', messages, convId } = req.body || {};
  const kind = ['chat', 'code', 'agent', 'design'].includes(req.body?.kind) ? req.body.kind : 'chat';
  const ctx = String(req.body?.ctx || '').slice(0, 1800);
  const sys = SYS + (EXTRA[kind] || '') + (ctx ? ' تعليمات المستخدم: ' + ctx : '');
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'طلب غير صحيح' });
  const all = messages.slice(-100).map((x, i, a) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '').slice(0, i === a.length - 1 ? 40000 : 8000) }));
  const lastIn = messages[messages.length - 1];
  const imgs = lastIn && lastIn.role !== 'assistant' ? cleanImages(lastIn.images) : [];
  if (imgs.length) all[all.length - 1].images = imgs;
  let cands = order(mode, all[all.length - 1].content, kind);
  if (imgs.length) { cands = cands.filter(k => ['gemini', 'chatgpt', 'claude'].includes(k)); if (!cands.length) return res.status(503).json({ error: 'تحليل الصور مش متاح حاليًا' }); }
  if (!cands.length) return res.status(503).json({ error: BUSY });
  const user = gate(req, res, 1); if (!user) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const out = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  let full = '', started = false, lastErr;
  try {
    for (const k of cands) {
      try { for await (const t of providers[k](all.slice(-30), sys)) { started = true; full += t; out({ t }); } break; }
      catch (e) { lastErr = e; console.error('[chat]', k, e.message); if (started) break; }
    }
    if (!full) throw lastErr || new Error('empty');
    let id;
    if (user.id) {
      let c = data.convs[convId];
      if (!c || c.uid !== user.id) { id = crypto.randomUUID(); c = data.convs[id] = { id, uid: user.id, title: all[0].content.slice(0, 40) }; }
      c.kind = kind; c.messages = [...all.map(({ role, content }) => ({ role, content })), { role: 'assistant', content: full }]; c.updated = Date.now(); id = c.id; save();
    }
    out({ done: true, convId: id });
  } catch (e) { out({ error: BUSY }); }
  res.end();
});

// ===== الصور والصوت =====
const images = {
  'openai-image': async (p) => {
    const d = await post('https://api.openai.com/v1/images/generations', { Authorization: 'Bearer ' + env.OPENAI_API_KEY },
      { model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt: p, size: '1024x1024' });
    const x = d.data[0]; return x.b64_json ? 'data:image/png;base64,' + x.b64_json : x.url;
  },
  'nano-banana': async (p) => {
    const model = env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const d = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { 'x-goog-api-key': env.GEMINI_API_KEY },
      { contents: [{ parts: [{ text: p }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
    const part = d.candidates[0].content.parts.find(x => x.inlineData);
    if (!part) throw new Error('no image');
    return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  }
};
const IMG_ORDER = ['nano-banana', 'openai-image'];
app.post('/api/image', async (req, res) => {
  const p = String(req.body?.prompt || '').slice(0, 2000).trim();
  if (!p) return res.status(400).json({ error: 'اكتب وصف الصورة الأول' });
  const c = IMG_ORDER.filter(k => env[KEYS[k]]);
  if (!c.length) return res.status(503).json({ error: 'الميزة دي مش متاحة حاليًا' });
  if (!gate(req, res, 3)) return;
  for (const k of c) { try { return res.json({ image: await images[k](p) }); } catch (e) { console.error('[image]', k, e.message); } }
  res.status(502).json({ error: BUSY });
});
app.post('/api/transcribe', async (req, res) => {
  const m = /^data:(audio\/[\w.+-]+)(?:;[^,]*)?;base64,(.+)$/.exec(String(req.body?.audio || ''));
  if (!m || m[2].length > 16e6) return res.status(400).json({ error: 'ملف الصوت مش صالح أو كبير' });
  if (!env.OPENAI_API_KEY) return res.status(503).json({ error: 'الميزة دي مش متاحة حاليًا' });
  if (!gate(req, res, 2)) return;
  try {
    const ext = /mp4|m4a/.test(m[1]) ? 'm4a' : /mpeg|mp3/.test(m[1]) ? 'mp3' : /wav/.test(m[1]) ? 'wav' : /ogg/.test(m[1]) ? 'ogg' : 'webm';
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), 'audio.' + ext);
    fd.append('model', env.OPENAI_STT_MODEL || 'whisper-1');
    const lang = String(req.body?.lang || '').slice(0, 2); if (/^[a-z]{2}$/.test(lang)) fd.append('language', lang);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: fd });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error?.message || 'HTTP ' + r.status);
    res.json({ text: String(d.text || '').slice(0, 20000) });
  } catch (e) { console.error('[stt]', e.message); res.status(502).json({ error: BUSY }); }
});
app.post('/api/tts', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 2500).trim();
  if (!text) return res.status(400).json({ error: 'اكتب النص الأول' });
  if (!env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'الميزة دي مش متاحة حاليًا' });
  if (!gate(req, res, 2)) return;
  try {
    const r = await call(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'}`,
      { 'xi-api-key': env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' }, { text, model_id: env.ELEVENLABS_MODEL || 'eleven_multilingual_v2' });
    res.json({ audio: 'data:audio/mpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64') });
  } catch (e) { console.error('[tts]', e.message); res.status(502).json({ error: BUSY }); }
});

// ===== إبلاغ عن محتوى + حذف الحساب (مطلوبين في Google Play) =====
app.post('/api/report', (req, res) => {
  const u = userOf(req);
  data.reports.push({ u: u ? u.email : null, text: String(req.body?.text || '').slice(0, 4000), note: String(req.body?.note || '').slice(0, 500), at: Date.now() });
  if (data.reports.length > 2000) data.reports.splice(0, data.reports.length - 2000);
  save(); res.json({ ok: true });
});
app.delete('/api/account', (req, res) => {
  const u = need(req, res); if (!u) return;
  for (const [id, c] of Object.entries(data.convs)) if (c.uid === u.id) delete data.convs[id];
  delete data.users[u.email]; save(); res.json({ ok: true });
});
app.get('/api/status', (req, res) => res.json({
  ok: true,
  chat: Object.keys(providers).some(k => env[KEYS[k]]),
  image: IMG_ORDER.some(k => env[KEYS[k]]),
  video: !!(env.ENABLE_VIDEO === '1' && env.GEMINI_API_KEY),
  audio: !!env.ELEVENLABS_API_KEY,
  stt: !!env.OPENAI_API_KEY,
  login: REQUIRE_LOGIN,
  limit: DAILY_LIMIT,
  maker: env.MAKER_NAME || ''
}));
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

const port = env.PORT || 3000;
app.listen(port, () => {
  const has = Object.keys(KEYS).filter(k => env[KEYS[k]] && !k.includes('image') && k !== 'elevenlabs');
  console.log('══════════════════════════════════════');
  console.log('  bods AI شغال على المنفذ ' + port);
  console.log('  الموديلات المتاحة: ' + (has.length ? has.join(', ') : 'لا يوجد — حط مفاتيح في .env'));
  console.log('  الصور: ' + (IMG_ORDER.some(k => env[KEYS[k]]) ? 'مفعّلة' : 'غير مفعّلة'));
  console.log('  الصوت: ' + (env.ELEVENLABS_API_KEY ? 'مفعّل' : 'غير مفعّل'));
  console.log('══════════════════════════════════════');
});
