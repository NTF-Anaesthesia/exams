// worker/saq.js: the SAQ marker API, with an in-memory SQLite standing in for D1 and a fake Anthropic API.
// Run: node --test 'worker/test/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../sites.js';
import { sgt, parseScore, cost, normCode } from '../saq.js';
import { ESSAYS, TOPICS, ORDER } from '../../exams/saq/essays.js';
import { render } from '../../exams/saq/render.js';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* older Node: the D1 tests are skipped */ }

test('spending month starts on the 16th (SGT); days are SGT', () => {
  assert.deepEqual(sgt(Date.parse('2026-11-15T16:30:00Z')), { day: '2026-11-16', period: '2026-11-16' });   // 00:30 SGT on the 16th
  assert.deepEqual(sgt(Date.parse('2026-11-15T15:30:00Z')), { day: '2026-11-15', period: '2026-10-16' });
  assert.deepEqual(sgt(Date.parse('2027-01-10T00:00:00Z')), { day: '2027-01-10', period: '2026-12-16' });
});

test('score parsing and cost', () => {
  assert.deepEqual(parseScore('### Score\n**Raw: 5 | Adjusted: 4**'), { raw: 5, adjusted: 4 });
  assert.deepEqual(parseScore('Raw: 9 | Adjusted: 2'), { raw: 8, adjusted: 3 });
  assert.equal(parseScore('no score'), null);
  // Opus 5.5: $4 in, $20 out; cache read 5%, write 125% of input
  assert.equal(cost('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  assert.equal(cost('claude-opus-5-5', { cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }), 0.2 + 5);
  assert.equal(cost('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 0.6);
  assert.equal(normCode('  Blue  Fox '), 'blue fox');
});

test('29 essays, each in one topic, all listed once, PDFs exist', () => {
  assert.equal(ESSAYS.length, 29);
  assert.deepEqual([...ORDER].sort((a, b) => a - b), ESSAYS.map(e => e.n));
  for (const e of ESSAYS) {
    assert.ok(TOPICS.includes(e.topic), e.title);
    assert.ok(e.stem.length > 40, e.title);
    assert.ok(fs.existsSync(new URL(`../../exams/reference/${e.pdf}`, import.meta.url)), e.pdf);
  }
});

test('renderer escapes HTML and highlights examiner comments', () => {
  const h = render('### Score\nIV dex <img src=x> [*No escalation.*]\n- **CVS**: ok');
  assert.ok(!h.includes('<img'));
  assert.ok(h.includes('<span class="ex">[No escalation.]</span>'));
  assert.ok(h.includes('<h3>Score</h3>') && h.includes('<li><strong>CVS</strong>: ok</li>'));
});

// ---------- API against a stand-in D1 ----------

function fakeD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../../migrations/0001_saq.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { db.prepare(sql).run(...args); return { success: true }; },
  });
  return { raw: db, prepare: sql => stmt(sql), batch: async list => Promise.all(list.map(s => s.all())) };
}

const ANSWER = 'I would extubate awake after reversal. SECRET-ANSWER-TEXT';
const STEM = 'A 30-year-old for an own question about something. SECRET-STEM-TEXT';
const MARKED = '### Annotated answer\nI would extubate awake [*No DAS plan.*]\n\n### Score\nRaw: 5 | Adjusted: 4\n\n### Examiner summary\nA. B. C.';

function sse(text) {
  const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const parts = [ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000, output_tokens: 1 } } })];
  for (const chunk of text.match(/[\s\S]{1,20}/g)) parts.push(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }));
  parts.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 800 } }), ev('message_stop', { type: 'message_stop' }));
  return new Response(parts.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('SAQ API: codes, marking, caps, admin', { skip: !sqlite && 'node:sqlite not available' }, async () => {
  const DB = fakeD1();
  const env = { DB, ADMIN_CODE: 'test admin words', ANTHROPIC_API_KEY: 'k', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  for (const [k, b] of [['mark_rules', 'RULES'], ['draft_rules', 'DRAFT'], ['rubric', 'RUBRIC'], ['index', '1. Difficult Extubation: ...'], ['essay:1', '## Essay 1: Difficult Extubation']])
    DB.raw.prepare('INSERT INTO docs (key, body, updated) VALUES (?, ?, ?)').run(k, b, 'now');
  let upstream = [], reply = () => sse(MARKED);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    upstream.push(JSON.parse(init.body));
    const b = JSON.parse(init.body);
    if (b.model === 'claude-haiku-5-5') return new Response(JSON.stringify({ content: [{ type: 'text', text: '1' }], usage: { input_tokens: 500, output_tokens: 2 } }));
    return reply();
  };
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const call = async (path, { method = 'GET', body, token, device = 'device-aaaaaaaaaaaaaaaa', ip = '1.1.1.1' } = {}) => {
    const headers = { 'CF-Connecting-IP': ip, 'X-SAQ-Device': device };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await worker.fetch(new Request('https://exams.anantf.com' + path, { method, headers, body: body && JSON.stringify(body) }), env, ctx);
    const text = await r.text();
    await Promise.all(waits.splice(0));
    let json = null; try { json = JSON.parse(text); } catch { /* stream */ }
    return { status: r.status, text, json };
  };
  try {
    // before a resident code is set
    let r = await call('/api/saq/status');
    assert.equal(r.status, 200);
    assert.equal(r.json.authed, false);
    assert.equal((await call('/api/saq/login', { method: 'POST', body: { code: 'anything' } })).status, 503);
    assert.equal((await call('/api/saq/admin/stats')).status, 401);
    assert.equal((await call('/api/saq/admin/login', { method: 'POST', body: { code: 'wrong' } })).status, 401);
    // form posts are refused
    r = await worker.fetch(new Request('https://exams.anantf.com/api/saq/login', { method: 'POST', body: 'code=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, ctx);
    assert.equal(r.status, 415);

    // admin signs in (case and spaces don't matter), sets the code and a small daily cap
    r = await call('/api/saq/admin/login', { method: 'POST', body: { code: ' Test  Admin words ' } });
    assert.equal(r.status, 200);
    const admin = r.json.token;
    r = await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { residentCode: 'Resident Code One', perDevice: 2, perIp: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.codeSet, true);
    assert.equal(r.json.perDevice, 2);
    assert.equal((await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { model: 'gpt' } })).status, 400);
    assert.ok(!JSON.stringify(DB.raw.prepare('SELECT * FROM settings').all()).includes('Resident Code One'.toLowerCase()), 'code stored hashed');

    // resident signs in
    assert.equal((await call('/api/saq/login', { method: 'POST', body: { code: 'nope' } })).status, 401);
    r = await call('/api/saq/login', { method: 'POST', body: { code: 'resident code one' } });
    assert.equal(r.status, 200);
    const res = r.json.token;
    r = await call('/api/saq/status', { token: res });
    assert.equal(r.json.authed, true);
    assert.equal(r.json.left, 2);
    assert.equal((await call('/api/saq/mark', { method: 'POST', body: { essay: 1, answer: ANSWER } })).status, 401);

    // a mark: the stream passes through, our own event closes it, one row lands without the answer
    upstream = [];
    r = await call('/api/saq/mark', { method: 'POST', token: res, body: { essay: 1, answer: ANSWER } });
    assert.equal(r.status, 200);
    assert.match(r.text, /content_block_delta/);
    const done = JSON.parse(r.text.split('event: saq_done\ndata: ')[1]);
    assert.deepEqual(done, { ok: true, raw: 5, adjusted: 4, left: 1 });
    assert.equal(upstream.length, 1);
    assert.equal(upstream[0].model, 'claude-opus-5-5');
    assert.equal(upstream[0].system[0].cache_control.type, 'ephemeral');
    assert.match(upstream[0].system[0].text, /RULES[\s\S]*RUBRIC/);
    assert.match(upstream[0].system[1].text, /Essay 1/);
    assert.match(upstream[0].messages[0].content, /Outline extubation strategies/);   // the server's own stem
    let rows = DB.raw.prepare('SELECT * FROM marks').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].essay, '1');
    assert.equal(rows[0].raw, 5);
    assert.equal(rows[0].out_tok, 800);
    assert.ok(Math.abs(rows[0].cost - cost('claude-opus-5-5', { input_tokens: 1000, cache_creation_input_tokens: 5000, output_tokens: 800 })) < 1e-9);
    assert.ok(!JSON.stringify(rows).includes('SECRET') && !rows[0].device.includes('device-'), 'no answer text, hashed ids');

    // own question: Haiku picks the closest essay first; then the model answer for it
    r = await call('/api/saq/mark', { method: 'POST', token: res, body: { essay: 'own', stem: STEM, answer: ANSWER } });
    assert.equal(r.status, 200);
    assert.equal(upstream.at(-2).model, 'claude-haiku-5-5');
    assert.match(upstream.at(-1).system[1].text, /Essay 1/);
    rows = DB.raw.prepare('SELECT * FROM marks').all();
    assert.ok(!JSON.stringify(rows).includes('SECRET'));
    assert.equal(rows[1].essay, 'own');

    // device cap (2 a day) reached
    r = await call('/api/saq/model', { method: 'POST', token: res, body: { essay: 'own', stem: STEM } });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'device');
    // another device on the same IP: IP cap is 3
    r = await call('/api/saq/model', { method: 'POST', token: res, device: 'device-bbbbbbbbbbbbbbbb', body: { essay: 'own', stem: STEM } });
    assert.equal(r.status, 200);
    assert.equal(upstream.at(-1).system[0].text.startsWith('DRAFT'), true);
    r = await call('/api/saq/mark', { method: 'POST', token: res, device: 'device-cccccccccccccccc', body: { essay: 1, answer: ANSWER } });
    assert.equal(r.json.code, 'ip');
    // monthly US$ cap
    await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { perIp: 100, monthlyCap: 0.01 } });
    r = await call('/api/saq/mark', { method: 'POST', token: res, ip: '2.2.2.2', device: 'device-dddddddddddddddd', body: { essay: 1, answer: ANSWER } });
    assert.equal(r.json.code, 'cap');
    assert.equal((await call('/api/saq/status', { token: res })).json.capHit, true);

    // out of credit: paused, flagged for admins, and the use is not counted
    await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { monthlyCap: 30 } });
    reply = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }), { status: 400 });
    r = await call('/api/saq/mark', { method: 'POST', token: res, ip: '3.3.3.3', device: 'device-eeeeeeeeeeeeeeee', body: { essay: 1, answer: ANSWER } });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'paused');
    r = await call('/api/saq/status', { token: res, device: 'device-eeeeeeeeeeeeeeee' });
    assert.equal(r.json.paused, true);
    assert.equal(r.json.left, 2);
    r = await call('/api/saq/admin/stats', { token: admin });
    assert.equal(r.json.credit.flagged, true);
    assert.equal(r.json.month.ok, 3);
    assert.equal(r.json.devices.today, 2);
    assert.deepEqual(r.json.scores, [{ raw: 5, n: 2 }]);

    // switched off by an admin; own questions off
    reply = () => sse(MARKED);
    await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { enabled: false, message: 'Back on Monday.' } });
    r = await call('/api/saq/status');
    assert.equal(r.json.paused, true);
    assert.equal(r.json.message, 'Back on Monday.');
    await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { enabled: true, ownQuestion: false } });
    DB.raw.prepare("UPDATE settings SET value = '0' WHERE key = 'creditError'").run();
    r = await call('/api/saq/mark', { method: 'POST', token: res, ip: '4.4.4.4', device: 'device-ffffffffffffffff', body: { essay: 'own', stem: STEM, answer: ANSWER } });
    assert.equal(r.json.code, 'own-off');

    // changing the resident code signs residents out
    await call('/api/saq/admin/settings', { method: 'POST', token: admin, body: { residentCode: 'second code here' } });
    assert.equal((await call('/api/saq/status', { token: res })).json.authed, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
