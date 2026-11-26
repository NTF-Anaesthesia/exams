// Loads the SAQ marker's prompt material into D1 (database exams-saq, table docs). The files themselves live in the
// private pair repo (ask the maintainers), never in this public repo.
//
//   node tools/saq-load.mjs --library <library.md> --rubric <rubric.md> --mark-rules <mark.md> --draft-rules <draft.md> --local
//   (--remote for the live database, with Cloudflare credentials in the environment; --dry-run only writes the SQL file)
//
// The library is split at its "## Essay N: Title" headings into one row per essay (essay:N), plus an index row (essay
// number, title and the start of its question) that the own-question picker reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const files = { library: opt('--library'), rubric: opt('--rubric'), mark_rules: opt('--mark-rules'), draft_rules: opt('--draft-rules') };
const where = args.includes('--remote') ? '--remote' : args.includes('--local') ? '--local' : null;
const db = opt('--db') || 'exams-saq';
if (Object.values(files).some(f => !f) || (!where && !args.includes('--dry-run'))) {
  console.error('usage: node tools/saq-load.mjs --library F --rubric F --mark-rules F --draft-rules F (--local | --remote | --dry-run) [--db exams-saq]');
  process.exit(2);
}
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

function splitLibrary(md) {
  const heads = [...md.matchAll(/^## Essay (\d+):\s*(.+)$/gm)];
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    const body = md.slice(h.index, end).replace(/\n-{3,}\s*$/, '').trim();
    const first = body.split('\n').slice(1).join(' ').replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 260);
    return { n: Number(h[1]), title: h[2].trim(), body, first };
  });
}

const essays = splitLibrary(read(files.library));
if (essays.length < 1) { console.error('no "## Essay N:" headings found in the library'); process.exit(1); }
const rows = [
  ['rubric', read(files.rubric).trim()],
  ['mark_rules', read(files.mark_rules).trim()],
  ['draft_rules', read(files.draft_rules).trim()],
  ['index', essays.map(e => `${e.n}. ${e.title}: ${e.first}`).join('\n')],
  ...essays.map(e => [`essay:${e.n}`, e.body]),
];
const q = s => `'${s.replace(/'/g, "''")}'`;
const now = new Date().toISOString();
const stmts = rows.map(([k, b]) => `INSERT INTO docs (key, body, updated) VALUES (${q(k)}, ${q(b)}, ${q(now)}) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated = excluded.updated;`);
const big = stmts.findIndex(s => Buffer.byteLength(s) > 95000);
if (big >= 0) { console.error(`row ${rows[big][0]} is too big for one D1 statement (100 kB)`); process.exit(1); }
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saq-load-')), 'docs.sql');
fs.writeFileSync(out, `DELETE FROM docs WHERE key LIKE 'essay:%';\n${stmts.join('\n')}\n`);
console.log(`${essays.length} essays, ${rows.length} rows -> ${out}`);
if (where) execFileSync('npx', ['--yes', 'wrangler@4', 'd1', 'execute', db, where, `--file=${out}`], { stdio: 'inherit' });
