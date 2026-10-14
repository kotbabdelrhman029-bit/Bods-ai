const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });
let data = { users: {}, convs: {} };
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
data.users ??= {}; data.convs ??= {}; data.secret ??= crypto.randomBytes(32).toString('hex');
let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, FILE); }, 200);
}
save();
const hashPw = (pw) => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, h) => {
  const [s, x] = String(h).split(':'); if (!s || !x) return false;
  const y = crypto.scryptSync(pw, s, 64), xb = Buffer.from(x, 'hex');
  return xb.length === y.length && crypto.timingSafeEqual(xb, y);
};
const mac = (s) => crypto.createHmac('sha256', data.secret).update(s).digest('base64url');
const sign = (e) => { const p = Buffer.from(JSON.stringify({ e, x: Date.now() + 30 * 864e5 })).toString('base64url'); return p + '.' + mac(p); };
const verify = (tok) => {
  const [p, m] = String(tok).split('.'); if (!p || !m) return null;
  const a = Buffer.from(mac(p)), b = Buffer.from(m);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o.x > Date.now() ? o : null; } catch { return null; }
};
async function* sse(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const ch of body) {
    buf += dec.decode(ch, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const v = line.slice(5).trim();
      if (!v || v === '[DONE]') continue;
      try { yield JSON.parse(v); } catch {}
    }
  }
}
const imgRe = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const cleanImages = (a) => (Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && x.length < 6e6 && imgRe.test(x)).slice(0, 4);
const parts = (u) => { const m = imgRe.exec(u); return { mime: m[1], data: m[2] }; };
const toOAI = (m) => m.map(x => x.images?.length ? { role: x.role, content: [{ type: 'text', text: x.content }, ...x.images.map(u => ({ type: 'image_url', image_url: { url: u } }))] } : { role: x.role, content: x.content });
const toClaude = (m) => m.map(x => x.images?.length ? { role: x.role, content: [...x.images.map(u => { const p = parts(u); return { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }; }), { type: 'text', text: x.content }] } : { role: x.role, content: x.content });
const toGemini = (m) => m.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }, ...(x.images || []).map(u => { const p = parts(u); return { inline_data: { mime_type: p.mime, data: p.data } }; })] }));
module.exports = { cleanImages, toOAI, toClaude, toGemini, data, save, hashPw, checkPw, sign, verify, sse };
