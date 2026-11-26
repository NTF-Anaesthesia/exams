// worker/sites.js with a stand-in for the static assets. Run: node --test 'worker/test/*.test.mjs'
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../sites.js';

const FILES = { '/exams/index.html': '<h1>hi</h1>' };
const env = { ASSETS: { fetch: async req => {
  const p = new URL(req.url).pathname;
  return p in FILES ? new Response(FILES[p], { status: 200 }) : new Response('', { status: 404 });
} } };
const get = (url, method = 'GET') => worker.fetch(new Request(url, { method }), env);

test('serves the folder index, noindex', async () => {
  const r = await get('https://exams.anantf.com/');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<h1>hi</h1>');
  assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('folder without a slash redirects; missing files 404; unknown hosts 404', async () => {
  assert.equal((await get('https://exams.anantf.com/exams')).status, 301);
  assert.equal((await get('https://exams.anantf.com/nope.js')).status, 404);
  assert.equal((await get('https://x.workers.dev/exams/')).status, 404);
});

test('only GET and HEAD', async () => {
  assert.equal((await get('https://exams.anantf.com/', 'POST')).status, 405);
});

test('/api/ is answered before the GET/HEAD rule, only on known hosts', async () => {
  assert.equal((await get('https://exams.anantf.com/api/saq/nope', 'POST')).status, 404);
  assert.equal((await get('https://exams.anantf.com/api/saq/status', 'PUT')).status, 405);
  // no database bound here: the marker says it is not set up, and the pages still work
  assert.equal((await get('https://exams.anantf.com/api/saq/status')).status, 503);
  assert.equal((await get('https://x.workers.dev/api/saq/status')).status, 404);
  assert.equal((await get('https://exams.anantf.com/')).status, 200);
  assert.equal((await get('https://exams.anantf.com/apix', 'POST')).status, 405);
});
