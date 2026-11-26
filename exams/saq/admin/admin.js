// SAQ marker admin: sign in with the admin code (short-lived token, this tab only), settings, usage.
import { ESSAYS } from '../essays.js';

const $ = id => document.getElementById(id);
const tok = { get: () => sessionStorage.getItem('saq.admin'), set: v => v ? sessionStorage.setItem('saq.admin', v) : sessionStorage.removeItem('saq.admin') };
const api = async (path, opts = {}) => {
  const r = await fetch('/api/saq/admin/' + path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok.get() || '') } });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== 'login') { tok.set(null); show(false); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Something went wrong.'), { status: r.status });
  return j;
};
const usd = n => 'US$' + (Number(n) || 0).toFixed(2);
const num = n => (Number(n) || 0).toLocaleString('en-SG');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const notice = (t, stop) => { $('notice').hidden = !t; $('notice').textContent = t || ''; $('notice').classList.toggle('stop', !!stop); };

function show(signedIn) {
  $('p-login').hidden = signedIn; $('p-dash').hidden = !signedIn; $('signout').hidden = !signedIn;
  if (!signedIn) notice('');
}

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    const j = await api('login', { method: 'POST', body: JSON.stringify({ code: $('code').value }) });
    tok.set(j.token); $('code').value = '';
    await load();
  } catch (err) { $('login-err').textContent = err.message; }
});
$('signout').addEventListener('click', () => { tok.set(null); show(false); });

async function load() {
  try {
    const [settings, stats] = await Promise.all([api('settings'), api('stats')]);
    show(true);
    fillSettings(settings);
    fillStats(stats);
  } catch (err) { if (err.status !== 401) notice(err.message, true); }
}

function fillSettings(s) {
  const f = $('settings');
  f.enabled.checked = s.enabled; f.ownQuestion.checked = s.ownQuestion;
  f.message.value = s.message; f.perDevice.value = s.perDevice; f.perIp.value = s.perIp; f.monthlyCap.value = s.monthlyCap;
  f.model.innerHTML = s.models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  f.model.value = s.model;
  f.residentCode.value = '';
  $('code-state').textContent = s.codeSet ? 'A resident code is set. Saving a new one signs residents out until they enter it.' : 'No resident code yet: residents cannot sign in.';
}

$('settings').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    enabled: f.enabled.checked, ownQuestion: f.ownQuestion.checked, message: f.message.value,
    perDevice: Number(f.perDevice.value), perIp: Number(f.perIp.value), monthlyCap: Number(f.monthlyCap.value), model: f.model.value,
  };
  if (f.residentCode.value.trim()) body.residentCode = f.residentCode.value;
  $('saved').textContent = 'Saving…';
  try {
    fillSettings(await api('settings', { method: 'POST', body: JSON.stringify(body) }));
    $('saved').textContent = 'Saved. In effect now.';
  } catch (err) { $('saved').textContent = err.message; }
});

function fillStats(st) {
  const m = st.month, pct = st.cap > 0 ? Math.min(100, (m.cost / st.cap) * 100) : 100;
  $('period').textContent = `(since ${st.period}; resets ${st.resets})`;
  if (st.credit.flagged) notice(`The last API call failed for lack of credit (${new Date(st.credit.lastError).toLocaleString('en-SG')}). Residents see "marker paused" for 10 minutes after each such failure.`, true);
  else if (!st.keySet) notice('No API key is set on the Worker.', true);
  else if (!st.docs || !st.docs.n) notice('The prompt material is not loaded into D1 yet (tools/saq-load.mjs).', true);
  else notice('');
  $('tiles').innerHTML = [
    [num(m.ok), 'marks this month', m.errors ? `${m.errors} failed` : ''],
    [usd(m.cost), `of ${usd(st.cap)} cap`, `<div class="saq-meterbar"><i style="width:${pct.toFixed(1)}%"></i></div>`],
    [num(st.devices.today), 'devices today', `${num(st.devices.week)} this week · ${num(st.devices.month)} this month`],
    [m.ok ? usd(m.cost / m.ok) : '–', 'per mark (average)', ''],
  ].map(([b, s, x]) => `<div class="saq-tile"><b>${b}</b><span>${s}</span>${x ? `<div class="saq-small">${x}</div>` : ''}</div>`).join('');

  // marks per day, last 30 days
  const days = [], byDay = Object.fromEntries(st.perDay.map(r => [r.day, r.n]));
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.parse(st.day + 'T00:00:00Z') - i * 86400e3).toISOString().slice(0, 10);
    days.push([d, byDay[d] || 0]);
  }
  $('chart-days').innerHTML = bars(days.map(([d, n]) => [d.slice(8), n, d]), 30);
  const sc = Object.fromEntries(st.scores.map(r => [r.raw, r.n]));
  $('chart-scores').innerHTML = bars([3, 4, 5, 6, 7, 8].map(s => [String(s), sc[s] || 0, `Raw ${s}`]), 6);

  const rows = {};
  for (const r of st.perEssay) { rows[r.essay] ||= { mark: 0, model: 0 }; rows[r.essay][r.kind] = r.n; }
  const title = k => k === 'own' ? 'Own question' : `${k}. ${(ESSAYS.find(e => String(e.n) === k) || {}).title || ''}`;
  const keys = Object.keys(rows).sort((a, b) => (rows[b].mark + rows[b].model) - (rows[a].mark + rows[a].model));
  $('essays').innerHTML = '<tr><th>Essay</th><th class="n">Marks</th><th class="n">Model answers</th></tr>' +
    (keys.length ? keys.map(k => `<tr><td>${esc(title(k))}</td><td class="n">${rows[k].mark}</td><td class="n">${rows[k].model}</td></tr>`).join('') : '<tr><td colspan="3">No marks yet.</td></tr>');

  $('tokens').innerHTML = [
    ['Input', m.in_tok], ['Output', m.out_tok], ['Cache read', m.cache_read], ['Cache write', m.cache_write],
  ].map(([k, v]) => `<tr><td>${k}</td><td class="n">${num(v)}</td></tr>`).join('') +
    st.byModel.map(r => `<tr><td>${esc(r.model)} (${r.n} uses)</td><td class="n">${usd(r.cost)}</td></tr>`).join('') +
    `<tr><td>Prompt material</td><td class="n">${st.docs ? `${st.docs.n} rows${st.docs.updated ? ', ' + esc(st.docs.updated.slice(0, 10)) : ''}` : '–'}</td></tr>`;
}

// simple SVG bar chart: items = [label, value, title]
function bars(items, n) {
  const W = 600, H = 160, pad = 18, max = Math.max(1, ...items.map(i => i[1])), bw = (W - 2) / n;
  const every = n > 12 ? 5 : 1;
  return `<svg class="saq-chart" viewBox="0 0 ${W} ${H + pad}" role="img" aria-label="Bar chart">` + items.map(([l, v, t], i) => {
    const h = Math.round((v / max) * (H - 16)), x = 1 + i * bw;
    return `<g><title>${esc(t)}: ${v}</title><rect x="${x + 2}" y="${H - h}" width="${Math.max(2, bw - 4)}" height="${h}" fill="#633d3c" rx="2"></rect>` +
      (v ? `<text x="${x + bw / 2}" y="${H - h - 4}" font-size="11" text-anchor="middle" fill="#272722">${v}</text>` : '') +
      ((i % every === 0 || i === items.length - 1) ? `<text x="${x + bw / 2}" y="${H + 14}" font-size="11" text-anchor="middle" fill="#68665f">${esc(l)}</text>` : '') + '</g>';
  }).join('') + `<line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="#c9c2b4"></line></svg>`;
}

if (tok.get()) load(); else show(false);
