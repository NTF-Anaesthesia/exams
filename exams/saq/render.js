// A small, safe markdown renderer for the marker's output: everything is escaped first, then headings, bullet lists,
// **bold**, *italic*, and examiner comments in [square brackets] (shown highlighted, also when a comment runs over
// several lines). No links, no raw HTML.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emph = s => s
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
  .replace(/(^|\W)_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
const ex = s => `<span class="ex">${emph(s.replace(/^(\[?)\s*[*_]+/, '$1').replace(/[*_]+\s*(\]?)$/, '$1'))}</span>`;

// state.ex: inside a comment that opened on an earlier line
function inline(s, state) {
  let t = esc(s), head = '';
  if (state.ex) {
    const j = t.indexOf(']');
    if (j < 0) return ex(t);
    state.ex = false;
    head = ex(t.slice(0, j + 1));
    t = t.slice(j + 1);
  }
  const parts = t.split(/(\[[^\[\]]*\])/);
  let out = parts.map((p, i) => i % 2 ? ex(p) : p);
  const last = out.length - 1, open = out[last].lastIndexOf('[');
  if (open >= 0) { state.ex = true; out[last] = emph(out[last].slice(0, open)) + ex(out[last].slice(open)); }
  else out[last] = emph(out[last]);
  return head + out.map((p, i) => i === last || i % 2 ? p : emph(p)).join('');
}

export function render(md) {
  const out = [], state = { ex: false };
  let para = [], list = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list.length) out.push(`<ul>${list.map(i => `<li>${i}</li>`).join('')}</ul>`); list = []; };
  for (const raw of String(md || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (!state.ex && (m = /^\s{0,3}(#{1,4})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      const tag = m[1].length >= 4 ? 'h4' : 'h3';
      out.push(`<${tag}>${inline(m[2].replace(/^\*\*|\*\*$/g, ''), state)}</${tag}>`);
    } else if ((m = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)) && !/^\s*\*\*/.test(line)) {
      flushPara();
      list.push(inline(m[1], state));
    } else if (/^\s*-{3,}\s*$/.test(line) || /^\s*\|?\s*:?-{3,}/.test(line)) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(inline(/^\s*\|/.test(line) ? line.replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, ' · ') : line, state));
    }
  }
  flushPara(); flushList();
  return out.join('');
}
