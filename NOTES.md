# exams: notes

Lasting rules live in `AGENTS.md`. Points worth remembering (how to test, gotchas, why something is the way it is) go here.

- Installable web apps stay installable but are never prompted (see `AGENTS.md`).
- Pages use paths relative to `exams/` (`assets/`, `fonts/`, logo); links to other NTF pages are absolute https://anantf.com/ addresses.
- The Worker serves only `exams/` (root host); the repo's tools, worker code and config are never served (`.assetsignore`).
- Test: `node tools/check.mjs`; local Worker: `npx wrangler@4 dev --local --port 8799`, then curl the pages.

## SAQ marker (`exams/saq/`, `worker/saq.js`), added 26 Nov 2026

- Residents: one shared access code (entered once per device), pick one of the 29 sample essays or paste their own stem, write, get examiner-style marking streamed back (`Raw: X | Adjusted: Y` on the 3–8 scale). The model answer for a sample essay is its PDF; for an own stem one is generated on request (counts as a mark).
- Admins: `/saq/admin/`, admin code = Worker secret `ADMIN_CODE` (12-hour token, this tab only). Settings live in D1 and apply at once: marks per device and per IP per day, monthly US$ cap (the month starts on the 16th, SGT), marker on/off with a message, own questions on/off, resident code (stored as a salted hash), model.
- The Worker answers `/api/*` before the GET/HEAD-only rule and before `resolve()`; every other address is unchanged.
- D1 database `exams-saq` (binding `DB`), schema in `migrations/`. One row per use: time, hashed device and IP, essay number, score, model, tokens, estimated US$. Answers and stems are never stored.
- Prompt material (marking rules, rubric, model answer library) is in D1 only, loaded with `node tools/saq-load.mjs … --remote`; the files are in the private pair repo, never here (`tools/check.mjs` fails if the library appears).
- Secrets: `ANTHROPIC_API_KEY`, `ADMIN_CODE` (`wrangler secret put`). Out of credit: residents see "marker paused" for 10 minutes after each failed call; the admin page flags it.
- Local test: put `ADMIN_CODE` and `ANTHROPIC_API_KEY` in `.dev.vars` (ignored), then `npx wrangler@4 d1 migrations apply exams-saq --local`, load the docs with `--local`, `npx wrangler@4 dev --local --port 8799`; pages at `http://localhost:8799/exams/saq/`. `worker/test/saq.test.mjs` covers the API with an in-memory SQLite and a fake Anthropic API.
