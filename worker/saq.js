// SAQ marker API (exams.anantf.com/saq/): /api/saq/*. Marks a typed practice answer with the Anthropic Messages API
// and streams the result back (Server-Sent Events, passed through). D1 (binding DB, database exams-saq) holds the
// settings, the prompt material (loaded by tools/saq-load.mjs) and one row per use: time, hashed device and IP, essay
// number, score, model, tokens. Answers and stems are never stored.
// Secrets (Worker secrets, never in the repo): ANTHROPIC_API_KEY, ADMIN_CODE.
import { ESSAYS } from '../exams/saq/essays.js';

// US$ per million tokens [input, output]; cache reads cost 5% of input, cache writes 125%
export const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const PICKER = 'claude-haiku-5-5';
// held against the monthly cap while a call runs (replaced by the real cost when it ends)
const ESTIMATE = { 'claude-opus-5-5': 0.15, 'claude-sonnet-5-5': 0.08 };
export const DEFAULTS = {
  perDevice: 10, perIp: 30, monthlyCap: 30, enabled: true, message: '', ownQuestion: true, model: 'claude-opus-5-5',
};
const MAX_ANSWER = 15000, MAX_STEM = 3000, MAX_FAILS = 20, ADMIN_HOURS = 12, CREDIT_PAUSE_MS = 10 * 60e3;
const PBKDF2_ITER = 10000;   // the free Workers plan allows ~10 ms CPU a request
const API = 'https://api.anthropic.com/v1/messages';

// ---------- pure helpers (tested in worker/test/saq.test.mjs) ----------

export function cost(model, u = {}) {
  const [i, o] = PRICES[model] || PRICES['claude-opus-5-5'];
  return ((u.input_tokens || 0) * i + (u.cache_read_input_tokens || 0) * i * 0.05
    + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.output_tokens || 0) * o) / 1e6;
}

const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
// SGT day, and the spending month: it starts on the 16th (SGT), named by that date
export function sgt(ms) {
  const d = new Date(ms + 8 * 3600e3), y = d.getUTCFullYear(), m = d.getUTCMonth(), dd = d.getUTCDate();
  return { day: iso(y, m, dd), period: dd >= 16 ? iso(y, m, 16) : iso(y, m - 1, 16) };
}

export function parseScore(text) {
  const m = /Raw\W{0,6}(\d)\W{0,8}Adjusted\W{0,6}(\d)/i.exec(String(text).replace(/\*/g, ''));
  if (!m) return null;
  const c = n => Math.min(8, Math.max(3, Number(n)));
  return { raw: c(m[1]), adjusted: c(m[2]) };
}

export const normCode = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// constant-time comparison of two strings (hash both, compare the digests byte by byte)
export async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < p.length; i++) d |= p[i] ^ q[i];
  return d === 0;
}
async function pbkdf2(code, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITER }, k, 256));
}
const randomId = () => b64u(crypto.getRandomValues(new Uint8Array(18)));

// signed tokens "payload.signature"; the key comes from ADMIN_CODE, so changing it signs everyone out
const tokenKey = env => 'saq-session|' + env.ADMIN_CODE;
export async function signToken(env, payload) { return `${payload}.${await hmac(tokenKey(env), payload)}`; }
export async function readToken(env, token) {
  const t = String(token || ''), i = t.lastIndexOf('.');
  if (i < 1 || !env.ADMIN_CODE) return null;
  const payload = t.slice(0, i);
  return (await same(t.slice(i + 1), await hmac(tokenKey(env), payload))) ? payload : null;
}

// ---------- request handling ----------

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
});
const err = (status, error, extra = {}) => json({ error, ...extra }, status);

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), m = request.method;
  const routes = {
    '/api/saq/status': { GET: status },
    '/api/saq/login': { POST: login },
    '/api/saq/mark': { POST: (q, e, c) => run(q, e, c, 'mark') },
    '/api/saq/model': { POST: (q, e, c) => run(q, e, c, 'model') },
    '/api/saq/admin/login': { POST: adminLogin },
    '/api/saq/admin/settings': { GET: adminSettings, POST: adminSave },
    '/api/saq/admin/stats': { GET: adminStats },
  };
  const r = routes[path];
  if (!r) return err(404, 'Not found');
  const fn = r[m === 'HEAD' ? 'GET' : m];
  if (!fn) return new Response('Method not allowed', { status: 405, headers: { Allow: Object.keys(r).join(', ') } });
  if (m === 'POST') {
    // JSON only, from this site: a plain HTML form on another site cannot send this
    if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return err(415, 'Send JSON');
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return err(403, 'Wrong origin');
  }
  if (!env.DB || !env.ADMIN_CODE) return err(503, 'The marker is not set up yet.');
  try {
    return await fn(request, env, ctx || { waitUntil() {} });
  } catch (e) {
    console.error('saq', e && e.stack || e);
    return err(500, 'Something went wrong. Try again.');
  }
}

async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULTS };
  for (const r of results) { try { s[r.key] = JSON.parse(r.value); } catch { /* skip */ } }
  if (!s.idSalt) {
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('idSalt', JSON.stringify(randomId())).run();
    s.idSalt = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'idSalt'").first()).value);
  }
  return s;
}
const putSettings = (env, obj) => env.DB.batch(Object.entries(obj).map(([k, v]) =>
  env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, JSON.stringify(v))));

const ipOf = req => req.headers.get('CF-Connecting-IP') || 'local';
const bearer = req => (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
const deviceOf = req => { const d = req.headers.get('X-SAQ-Device') || ''; return /^[\w-]{16,64}$/.test(d) ? d : null; };
const idHash = (s, kind, v) => hmac(s.idSalt, `${kind}|${v}`);
async function body(req) { try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; } }
const creditPaused = (s, now) => !!s.creditError && s.creditError > (s.creditOk || 0) && now - s.creditError < CREDIT_PAUSE_MS;

async function usage(env, s, now, device, ip) {
  const { day, period } = sgt(now);
  const live = "status IN ('pending', 'ok')";
  const [d, i, sp] = await env.DB.batch([
    env.DB.prepare(`SELECT count(*) AS n FROM marks WHERE day = ? AND device = ? AND ${live}`).bind(day, device || ''),
    env.DB.prepare(`SELECT count(*) AS n FROM marks WHERE day = ? AND ip = ? AND ${live}`).bind(day, ip || ''),
    env.DB.prepare('SELECT coalesce(sum(cost), 0) AS c FROM marks WHERE period = ?').bind(period),
  ]);
  return { day, period, device: d.results[0].n, ip: i.results[0].n, spent: sp.results[0].c };
}

async function failed(env, s, req, now) {
  const ip = await idHash(s, 'ip', ipOf(req)), { day } = sgt(now);
  await env.DB.prepare('INSERT INTO fails (day, ip, n) VALUES (?, ?, 1) ON CONFLICT(day, ip) DO UPDATE SET n = n + 1').bind(day, ip).run();
}
async function tooManyFails(env, s, req, now) {
  const ip = await idHash(s, 'ip', ipOf(req)), { day } = sgt(now);
  const r = await env.DB.prepare('SELECT n FROM fails WHERE day = ? AND ip = ?').bind(day, ip).first();
  return r && r.n >= MAX_FAILS;
}

// ---------- residents ----------

async function residentOk(env, s, req) {
  const p = await readToken(env, bearer(req));
  return p === `r.${s.codeVersion || 0}` && !!s.codeHash;
}

async function status(req, env) {
  const s = await loadSettings(env), now = Date.now(), dev = deviceOf(req);
  const u = await usage(env, s, now, dev && await idHash(s, 'dev', dev), await idHash(s, 'ip', ipOf(req)));
  const paused = !s.enabled || creditPaused(s, now);
  return json({
    authed: await residentOk(env, s, req),
    enabled: !!s.enabled,
    paused,
    message: !s.enabled ? (s.message || 'The marker is paused for now.') : creditPaused(s, now) ? 'The marker is paused for now (out of credit). Please try again later.' : '',
    ownQuestion: !!s.ownQuestion,
    perDay: s.perDevice,
    left: Math.max(0, s.perDevice - u.device),
    capNear: u.spent >= 0.8 * s.monthlyCap && u.spent < s.monthlyCap,
    capHit: u.spent >= s.monthlyCap,
    resets: nextReset(u.period),
  });
}
const nextReset = period => { const [y, m] = period.split('-').map(Number); return iso(y, m, 16); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const human = d => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

async function login(req, env) {
  const s = await loadSettings(env), now = Date.now();
  if (await tooManyFails(env, s, req, now)) return err(429, 'Too many tries today. Try again tomorrow.');
  if (!s.codeHash) return err(503, 'The marker is not set up yet.');
  const { code } = await body(req);
  if (!code || !(await same(await pbkdf2(code, s.codeSalt), s.codeHash))) {
    await failed(env, s, req, now);
    return err(401, 'That code is not right.');
  }
  return json({ token: await signToken(env, `r.${s.codeVersion || 0}`) });
}

// One mark (kind 'mark') or one generated model answer for an own question (kind 'model'), streamed
async function run(req, env, ctx, kind) {
  const s = await loadSettings(env), now = Date.now();
  if (!(await residentOk(env, s, req))) return err(401, 'Enter the access code first.', { code: 'auth' });
  if (!s.enabled) return err(503, s.message || 'The marker is paused for now.', { code: 'paused' });
  if (creditPaused(s, now)) return err(503, 'The marker is paused for now (out of credit). Please try again later.', { code: 'paused' });
  const dev = deviceOf(req);
  if (!dev) return err(400, 'Missing device id.');
  const b = await body(req);
  let essay = null, stem;
  if (b.essay === 'own') {
    if (!s.ownQuestion) return err(403, 'Own questions are switched off for now.', { code: 'own-off' });
    stem = String(b.stem || '').trim();
    if (stem.length < 15) return err(400, 'Paste the question stem first.');
    if (stem.length > MAX_STEM) return err(400, `The stem is too long (max ${MAX_STEM} characters).`);
  } else {
    essay = ESSAYS.find(e => e.n === Number(b.essay));
    if (!essay) return err(400, 'Pick a question.');
    stem = essay.stem;
    if (kind === 'model') return err(400, 'The model answer for this essay is its PDF.');
  }
  const answer = kind === 'mark' ? String(b.answer || '').trim() : '';
  if (kind === 'mark' && answer.length < 20) return err(400, 'Write an answer first.');
  if (answer.length > MAX_ANSWER) return err(400, `The answer is too long (max ${MAX_ANSWER} characters).`);

  // reserve the use (atomic: the row is only written while every cap has room)
  const model = MODELS.includes(s.model) ? s.model : DEFAULTS.model;
  const device = await idHash(s, 'dev', dev), ip = await idHash(s, 'ip', ipOf(req)), { day, period } = sgt(now);
  const live = "status IN ('pending', 'ok')";
  const row = await env.DB.prepare(`INSERT INTO marks (ts, day, period, device, ip, kind, essay, model, status, cost)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9
    WHERE (SELECT count(*) FROM marks WHERE day = ?2 AND device = ?4 AND ${live}) < ?10
      AND (SELECT count(*) FROM marks WHERE day = ?2 AND ip = ?5 AND ${live}) < ?11
      AND (SELECT coalesce(sum(cost), 0) FROM marks WHERE period = ?3) < ?12
    RETURNING id`).bind(now, day, period, device, ip, kind, essay ? String(essay.n) : 'own', model, ESTIMATE[model],
    s.perDevice, s.perIp, s.monthlyCap).first();
  if (!row) {
    const u = await usage(env, s, now, device, ip);
    if (u.spent >= s.monthlyCap) return err(429, `This month's marking budget is used up. It resets on ${human(nextReset(period))}.`, { code: 'cap' });
    if (u.device >= s.perDevice) return err(429, `No marks left today on this device (${s.perDevice} a day). Try again tomorrow.`, { code: 'device' });
    return err(429, 'Too many marks from this network today. Try again tomorrow.', { code: 'ip' });
  }
  const id = row.id;
  const tally = { in_tok: 0, out_tok: 0, cache_read: 0, cache_write: 0, cost: 0 };
  const add = (m, u) => {
    tally.in_tok += u.input_tokens || 0; tally.out_tok += u.output_tokens || 0;
    tally.cache_read += u.cache_read_input_tokens || 0; tally.cache_write += u.cache_creation_input_tokens || 0;
    tally.cost += cost(m, u);
  };
  const finish = (st, score) => env.DB.prepare(`UPDATE marks SET status = ?, raw = ?, adjusted = ?, in_tok = ?, out_tok = ?,
    cache_read = ?, cache_write = ?, cost = ? WHERE id = ?`).bind(st, score ? score.raw : null, score ? score.adjusted : null,
    tally.in_tok, tally.out_tok, tally.cache_read, tally.cache_write, tally.cost, id).run();

  try {
    // prompt material
    const keys = [kind === 'mark' ? 'mark_rules' : 'draft_rules', 'rubric', essay ? `essay:${essay.n}` : 'index'];
    const docs = await loadDocs(env, keys);
    if (!docs[keys[0]] || !docs.rubric) { await finish('error'); return err(503, 'The marker is not set up yet.'); }
    let refs = [];
    if (essay) refs = [essay.n];
    else if (docs.index) refs = await pick(env, docs.index, stem, add);
    const refDocs = essay ? docs : await loadDocs(env, refs.map(n => `essay:${n}`));
    const library = refs.map(n => refDocs[`essay:${n}`]).filter(Boolean).join('\n\n---\n\n');

    const system = [{ type: 'text', text: `${docs[keys[0]]}\n\n---\n\n${docs.rubric}`, cache_control: { type: 'ephemeral' } }];
    if (library) system.push({ type: 'text', text: `# Model answer library: closest essay${refs.length > 1 ? 's' : ''}\n\n${library}`, cache_control: { type: 'ephemeral' } });
    const user = kind === 'mark'
      ? `## Question stem\n${stem}\n\n## Candidate answer\n<candidate_answer>\n${answer}\n</candidate_answer>\n\nMark this answer in the fixed format.`
      : `## Question stem\n<stem>\n${stem}\n</stem>\n\nWrite the model answer.`;
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8000, stream: true, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) return await apiError(env, res, finish);
    return stream(env, ctx, res, model, add, finish, kind, s, device, day);
  } catch (e) {
    await finish('error');
    throw e;
  }
}

async function loadDocs(env, keys) {
  if (!keys.length) return {};
  const { results } = await env.DB.prepare(`SELECT key, body FROM docs WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all();
  return Object.fromEntries(results.map(r => [r.key, r.body]));
}

// Own question: a small model picks the 1–2 closest library essays from the index
async function pick(env, index, stem, add) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: PICKER, max_tokens: 20,
        system: 'You match an anaesthesia exam question to the closest essays in a model answer library. Reply with only the numbers of the 1 or 2 closest essays, comma-separated, nothing else.',
        messages: [{ role: 'user', content: `Library index:\n${index}\n\nQuestion:\n<stem>\n${stem}\n</stem>` }],
      }),
    });
    if (!res.ok) return [];
    const r = await res.json();
    add(PICKER, r.usage || {});
    const text = (r.content || []).map(c => c.text || '').join(' ');
    return [...new Set((text.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= ESSAYS.length))].slice(0, 2);
  } catch { return []; }
}

const isCredit = (status, text) => /credit balance|billing|insufficient.{0,20}(credit|fund)/i.test(text) || status === 402;
async function apiError(env, res, finish) {
  const text = await res.text().catch(() => '');
  console.error('saq anthropic', res.status, text.slice(0, 300));
  if (isCredit(res.status, text)) {
    await putSettings(env, { creditError: Date.now() });
    await finish('credit');
    return err(503, 'The marker is paused for now (out of credit). Please try again later.', { code: 'paused' });
  }
  await finish('error');
  if (res.status === 429 || res.status === 529 || res.status >= 500) return err(503, 'The marker is busy. Try again in a minute.', { code: 'busy' });
  return err(502, 'The marker could not mark this. Try again.', { code: 'api' });
}

// Pass Anthropic's event stream through to the browser, reading it as it goes for the token use and the score; at the
// end, log the row and add one event of our own: "event: saq_done" with the score and the marks left today.
function stream(env, ctx, res, model, add, finish, kind, s, device, day) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter(), reader = res.body.getReader(), dec = new TextDecoder();
  const send = chunk => writer.write(chunk).catch(() => {});
  const work = (async () => {
    let buf = '', text = '', usage = {}, failedMid = false;
    const onEvent = data => {
      let e; try { e = JSON.parse(data); } catch { return; }
      if (e.type === 'message_start') usage = { ...(e.message && e.message.usage) };
      else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') text += e.delta.text;
      else if (e.type === 'message_delta' && e.usage) usage = { ...usage, ...Object.fromEntries(Object.entries(e.usage).filter(([, v]) => v != null)) };
      else if (e.type === 'error') failedMid = true;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        send(value);
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (line.startsWith('data:')) onEvent(line.slice(5).trim());
        }
      }
    } catch { failedMid = true; }
    add(model, usage);
    const score = kind === 'mark' ? parseScore(text) : null;
    const ok = !failedMid && text.length > 0;
    let left = null;
    try {
      await finish(ok ? 'ok' : 'error', score);
      if (ok) await putSettings(env, { creditOk: Date.now() });
      const r = await env.DB.prepare("SELECT count(*) AS n FROM marks WHERE day = ? AND device = ? AND status IN ('pending', 'ok')").bind(day, device).first();
      left = Math.max(0, s.perDevice - r.n);
    } catch (e) { console.error('saq log', e); }
    send(enc.encode(`event: saq_done\ndata: ${JSON.stringify({ ok, raw: score && score.raw, adjusted: score && score.adjusted, left })}\n\n`));
    writer.close().catch(() => {});
  })();
  ctx.waitUntil(work);
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// ---------- admins ----------

async function adminOk(env, req) {
  const p = await readToken(env, bearer(req));
  return !!p && /^a\.\d+$/.test(p) && Number(p.slice(2)) > Date.now();
}

async function adminLogin(req, env) {
  const s = await loadSettings(env), now = Date.now();
  if (await tooManyFails(env, s, req, now)) return err(429, 'Too many tries today. Try again tomorrow.');
  const { code } = await body(req);
  if (!code || !(await same(normCode(code), normCode(env.ADMIN_CODE)))) {
    await failed(env, s, req, now);
    return err(401, 'That admin code is not right.');
  }
  const exp = now + ADMIN_HOURS * 3600e3;
  return json({ token: await signToken(env, `a.${exp}`), exp });
}

const publicSettings = s => ({
  perDevice: s.perDevice, perIp: s.perIp, monthlyCap: s.monthlyCap, enabled: !!s.enabled, message: s.message || '',
  ownQuestion: !!s.ownQuestion, model: s.model, models: MODELS, codeSet: !!s.codeHash,
});

async function adminSettings(req, env) {
  if (!(await adminOk(env, req))) return err(401, 'Sign in first.', { code: 'auth' });
  return json(publicSettings(await loadSettings(env)));
}

async function adminSave(req, env) {
  if (!(await adminOk(env, req))) return err(401, 'Sign in first.', { code: 'auth' });
  const s = await loadSettings(env), b = await body(req), out = {};
  const int = (k, lo, hi) => {
    if (b[k] == null) return true;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) return false;
    out[k] = n; return true;
  };
  if (!int('perDevice', 0, 1000) || !int('perIp', 0, 10000)) return err(400, 'Daily limits must be whole numbers.');
  if (b.monthlyCap != null) {
    const n = Number(b.monthlyCap);
    if (!Number.isFinite(n) || n < 0 || n > 10000) return err(400, 'The monthly cap must be a number of US dollars.');
    out.monthlyCap = Math.round(n * 100) / 100;
  }
  for (const k of ['enabled', 'ownQuestion']) if (b[k] != null) out[k] = !!b[k];
  if (b.message != null) out.message = String(b.message).slice(0, 300);
  if (b.model != null) { if (!MODELS.includes(b.model)) return err(400, 'Unknown model.'); out.model = b.model; }
  if (b.residentCode != null && b.residentCode !== '') {
    const code = normCode(b.residentCode);
    if (code.length < 6 || code.length > 100) return err(400, 'The resident code needs 6 to 100 characters.');
    out.codeSalt = randomId();
    out.codeHash = await pbkdf2(code, out.codeSalt);
    out.codeVersion = (s.codeVersion || 0) + 1;   // signs residents out: they enter the new code once
  }
  if (Object.keys(out).length) await putSettings(env, out);
  return json(publicSettings({ ...s, ...out }));
}

async function adminStats(req, env) {
  if (!(await adminOk(env, req))) return err(401, 'Sign in first.', { code: 'auth' });
  const s = await loadSettings(env), now = Date.now(), { day, period } = sgt(now);
  const from30 = sgt(now - 29 * 86400e3).day, from7 = sgt(now - 6 * 86400e3).day;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [perDay, perEssay, scores, devices, month, byModel] = (await env.DB.batch([
    q("SELECT day, count(*) AS n FROM marks WHERE day >= ? AND status = 'ok' GROUP BY day ORDER BY day", from30),
    q("SELECT essay, kind, count(*) AS n FROM marks WHERE status = 'ok' GROUP BY essay, kind"),
    q("SELECT raw, count(*) AS n FROM marks WHERE kind = 'mark' AND status = 'ok' AND raw IS NOT NULL GROUP BY raw ORDER BY raw"),
    q(`SELECT count(DISTINCT CASE WHEN day = ?1 THEN device END) AS today, count(DISTINCT CASE WHEN day >= ?2 THEN device END) AS week,
       count(DISTINCT CASE WHEN period = ?3 THEN device END) AS month FROM marks WHERE status = 'ok'`, day, from7, period),
    q(`SELECT count(CASE WHEN status = 'ok' THEN 1 END) AS ok, count(CASE WHEN status IN ('error', 'credit') THEN 1 END) AS errors,
       count(CASE WHEN status = 'pending' THEN 1 END) AS pending, coalesce(sum(in_tok), 0) AS in_tok, coalesce(sum(out_tok), 0) AS out_tok,
       coalesce(sum(cache_read), 0) AS cache_read, coalesce(sum(cache_write), 0) AS cache_write, coalesce(sum(cost), 0) AS cost
       FROM marks WHERE period = ?`, period),
    q("SELECT model, count(*) AS n, coalesce(sum(cost), 0) AS cost FROM marks WHERE period = ? GROUP BY model", period),
  ])).map(r => r.results);
  const docs = await env.DB.prepare("SELECT count(*) AS n, max(updated) AS updated FROM docs").first();
  return json({
    now, day, period, resets: nextReset(period), cap: s.monthlyCap,
    perDay, perEssay, scores, devices: devices[0], month: month[0], byModel,
    credit: { lastError: s.creditError || null, lastOk: s.creditOk || null, flagged: !!s.creditError && s.creditError > (s.creditOk || 0) },
    docs, keySet: !!env.ANTHROPIC_API_KEY,
  });
}
