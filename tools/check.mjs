// Repo checks. Run before merging: node tools/check.mjs
// 1. Every relative href/src/url() in the pages and CSS points at a file that exists.
// 2. Every PDF the pages name under reference/ exists.
// 3. wrangler.jsonc keeps preview links and the workers.dev address off.
// 4. The Worker's tests pass.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = m => errors.push(m);
const files = ['exams/index.html', 'exams/essays.html', ...fs.readdirSync(path.join(ROOT, 'exams/assets')).filter(f => f.endsWith('.css')).map(f => `exams/assets/${f}`)];

for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const refs = [...src.matchAll(/(?:href|src)="([^"#?$]+)[^"]*"|url\(['"]?([^'")?#]+)/g)].map(m => m[1] || m[2]);
  for (const r of refs) {
    if (/^(https?:|mailto:|data:|%|\/\/|\.\/?$)/.test(r) || r.includes('${')) continue;
    const target = path.join(ROOT, path.dirname(f), r);
    if (!fs.existsSync(target)) fail(`${f}: missing ${r}`);
  }
}
const page = fs.readFileSync(path.join(ROOT, 'exams/index.html'), 'utf8');
for (const m of page.matchAll(/reference\/([\w.-]+\.pdf)/g))
  if (!fs.existsSync(path.join(ROOT, 'exams/reference', m[1]))) fail(`exams/index.html: missing reference/${m[1]}`);

const wr = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
if (!/"preview_urls":\s*false/.test(wr)) fail('wrangler.jsonc: preview_urls must be false');
if (!/"workers_dev":\s*false/.test(wr)) fail('wrangler.jsonc: workers_dev must be false');

try { execFileSync('node', ['--test', ...fs.readdirSync(path.join(ROOT, 'worker/test')).map(f => `worker/test/${f}`)], { cwd: ROOT, stdio: 'pipe' }); }
catch (e) { fail(`worker tests failed:\n${e.stdout}${e.stderr}`); }

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('checks passed');
