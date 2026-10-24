# exams: notes

Lasting rules live in `AGENTS.md`. Points worth remembering (how to test, gotchas, why something is the way it is) go here.

- Installable web apps stay installable but are never prompted (see `AGENTS.md`).
- Pages use paths relative to `exams/` (`assets/`, `fonts/`, logo); links to other NTF pages are absolute https://anantf.com/ addresses.
- The Worker serves only `exams/` (root host); the repo's tools, worker code and config are never served (`.assetsignore`).
- Test: `node tools/check.mjs`; local Worker: `npx wrangler@4 dev --local --port 8799`, then curl the pages.
