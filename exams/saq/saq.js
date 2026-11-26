// SAQ marker page: access code (once per device), pick a question, write (autosaved on this device), mark (streamed).
import { ESSAYS, TOPICS, ORDER } from './essays.js';
import { render } from './render.js';

const $ = id => document.getElementById(id);
const store = {
  get: k => { try { return localStorage.getItem('saq.' + k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem('saq.' + k) : localStorage.setItem('saq.' + k, v); } catch { /* private mode */ } },
};
let device = store.get('device');
if (!device) { device = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^\w-]/g, ''); store.set('device', device); }
const headers = () => ({ 'Content-Type': 'application/json', 'X-SAQ-Device': device, Authorization: 'Bearer ' + (store.get('token') || '') });

let status = null, current = null;   // current: { essay: n | 'own' }

function show(panel) {
  for (const p of ['code', 'pick', 'write', 'result']) $('p-' + p).hidden = p !== panel;
  if (panel !== 'result') scrollTo({ top: 0 });
}

function notice(text, stop) {
  $('notice').hidden = !text;
  $('notice').textContent = text || '';
  $('notice').classList.toggle('stop', !!stop);
}

function meter(left, perDay) {
  if (left == null) return;
  $('meter').hidden = false;
  $('meter-n').textContent = `${left} of ${perDay}`;
}

async function loadStatus() {
  try {
    const r = await fetch('/api/saq/status', { headers: headers() });
    status = await r.json();
    if (!r.ok) throw new Error(status.error || 'status');
  } catch (e) {
    notice('The marker is not available right now. Try again later.', true);
    return null;
  }
  meter(status.left, status.perDay);
  if (status.paused) notice(status.message || 'The marker is paused for now.', true);
  else if (status.capHit) notice(`This month's marking budget is used up. It resets on ${fmtDate(status.resets)}.`, true);
  else if (status.capNear) notice(`This month's marking budget is nearly used up (resets ${fmtDate(status.resets)}).`);
  else notice('');
  $('own-wrap').hidden = !status.ownQuestion;
  return status;
}
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }) : '';

// ---------- code ----------
$('code-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('code-err').textContent = '';
  const r = await fetch('/api/saq/login', { method: 'POST', headers: headers(), body: JSON.stringify({ code: $('code').value }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('code-err').textContent = j.error || 'That did not work.'; return; }
  store.set('token', j.token);
  $('code').value = '';
  await loadStatus();
  route();
});

// ---------- pick ----------
function buildList() {
  const byN = Object.fromEntries(ESSAYS.map(e => [e.n, e]));
  const groups = new Map(TOPICS.map(t => [t, []]));
  for (const n of ORDER) groups.get(byN[n].topic).push(byN[n]);
  $('topics').innerHTML = '';
  for (const [topic, list] of groups) {
    const sec = document.createElement('section');
    sec.className = 'essay-topic';
    sec.innerHTML = `<h2></h2><ul></ul>`;
    sec.querySelector('h2').textContent = topic;
    for (const e of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'essay-title-link';
      b.innerHTML = '<span></span><span class="pdf-label">Write <span aria-hidden="true">→</span></span>';
      b.firstChild.textContent = e.title;
      b.addEventListener('click', () => open(e.n));
      li.append(b);
      sec.querySelector('ul').append(li);
    }
    $('topics').append(sec);
  }
}
$('own-btn').addEventListener('click', () => open('own'));

// ---------- write ----------
const draftKey = () => 'draft.' + current.essay;
function open(essay) {
  current = { essay };
  const e = ESSAYS.find(x => x.n === essay);
  $('stem-view').hidden = !e; $('stem-edit').hidden = !!e;
  if (e) { $('stem-title').textContent = `Essay ${e.n} · ${e.title}`; $('stem').textContent = e.stem; }
  else $('own-stem').value = store.get('draft.own.stem') || '';
  $('answer').value = store.get(draftKey()) || '';
  $('write-err').textContent = '';
  counter();
  history.replaceState(null, '', '?essay=' + essay);
  show('write');
}
let saveT;
$('answer').addEventListener('input', () => {
  counter();
  $('saved').textContent = 'Saving…';
  clearTimeout(saveT);
  saveT = setTimeout(() => { store.set(draftKey(), $('answer').value); $('saved').textContent = 'Saved on this device'; }, 400);
});
$('own-stem').addEventListener('input', () => store.set('draft.own.stem', $('own-stem').value));
function counter() {
  const w = ($('answer').value.match(/\S+/g) || []).length;
  $('count').textContent = `${w} word${w === 1 ? '' : 's'}`;
}

// 15-minute timer (optional, never blocks marking)
let timerEnd = null, timerT;
$('timer-btn').addEventListener('click', () => {
  if (timerEnd) { timerEnd = null; clearInterval(timerT); $('timer').hidden = true; $('timer-btn').textContent = 'Start 15-min timer'; return; }
  timerEnd = Date.now() + 15 * 60e3;
  $('timer').hidden = false; $('timer-btn').textContent = 'Stop timer';
  tick(); timerT = setInterval(tick, 500);
});
function tick() {
  const s = Math.round((timerEnd - Date.now()) / 1000), a = Math.abs(s);
  $('timer').textContent = `${s < 0 ? '+' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  $('timer').classList.toggle('over', s < 0);
  if (s === 0 && navigator.vibrate) navigator.vibrate(300);
}

// ---------- mark ----------
$('mark-btn').addEventListener('click', () => mark());
async function mark() {
  store.set(draftKey(), $('answer').value);
  const own = current.essay === 'own';
  const payload = { essay: current.essay, answer: $('answer').value, stem: own ? $('own-stem').value : undefined };
  $('write-err').textContent = '';
  if (own && payload.stem.trim().length < 15) { $('write-err').textContent = 'Paste the question stem first.'; return; }
  if (payload.answer.trim().length < 20) { $('write-err').textContent = 'Write an answer first.'; return; }
  const e = ESSAYS.find(x => x.n === current.essay);
  $('result-title').textContent = e ? `Essay ${e.n} · ${e.title}` : 'Own question';
  $('score-line').innerHTML = '';
  $('result-err').textContent = '';
  $('model-wrap').hidden = true;
  $('model-pdf').hidden = !e;
  if (e) $('model-pdf').href = '../reference/' + e.pdf;
  $('model-btn').hidden = true;
  show('result');
  scrollTo({ top: $('p-result').offsetTop - 12 });
  const done = await streamTo('/api/saq/mark', payload, $('out'), 'Marking (about a minute)');
  if (done && done.raw) $('score-line').innerHTML = `<p><span class="saq-score">Raw ${done.raw} | Adjusted ${done.adjusted}</span></p>`;
  $('model-btn').hidden = !(own && done && done.ok && status && status.ownQuestion);
}

$('model-btn').addEventListener('click', async () => {
  $('model-btn').hidden = true;
  $('model-wrap').hidden = false;
  await streamTo('/api/saq/model', { essay: 'own', stem: $('own-stem').value }, $('model-out'), 'Writing a model answer');
});

// POST, then read the event stream: text deltas are rendered as they come; our own "saq_done" event closes it
async function streamTo(url, payload, out, waiting) {
  out.innerHTML = `<p class="saq-wait">${waiting}</p>`;
  const errBox = $('result-err');
  let r;
  try { r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }); }
  catch { out.innerHTML = ''; errBox.textContent = 'No connection. Your answer is still saved: try again.'; return null; }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    out.innerHTML = '';
    errBox.textContent = j.error || 'Something went wrong. Try again.';
    if (j.code === 'auth') { store.set('token', null); }
    if (['auth', 'paused', 'cap', 'device'].includes(j.code)) await loadStatus();
    return null;
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', ev = '', done = null, pending = false;
  const paint = () => { pending = false; out.innerHTML = render(text) || `<p class="saq-wait">${waiting}</p>`; };
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { break; }
    if (chunk.done) break;
    buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('event:')) ev = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev === 'saq_done') done = d;
        else if (d.type === 'content_block_delta' && d.delta && d.delta.text) {
          text += d.delta.text;
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (d.type === 'error') errBox.textContent = 'The marker stopped part-way. Try again.';
      } else if (line === '') ev = '';
    }
  }
  paint();
  if (!done || !done.ok) errBox.textContent ||= 'The marker stopped part-way. Try again.';
  if (done && done.left != null) meter(done.left, status ? status.perDay : done.left);
  return done;
}

// ---------- navigation ----------
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.go === 'pick') { history.replaceState(null, '', './'); show('pick'); }
  else show(b.dataset.go);
}));

function route() {
  if (!status) return;
  if (!status.authed) { show('code'); return; }
  const q = new URLSearchParams(location.search).get('essay');
  const n = q === 'own' ? (status.ownQuestion ? 'own' : null) : Number(q);
  if (n === 'own' || ESSAYS.some(e => e.n === n)) open(n);
  else show('pick');
}

buildList();
loadStatus().then(route);
