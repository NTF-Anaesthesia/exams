# exams

The exams resource: past-paper essay and SAQ practice, reference PDFs and an essay bank for anaesthesia trainees, live at https://exams.anantf.com. Static pages in `exams/`, served by this repo's own Cloudflare Worker (`exams`). Split out of the NTF anaesthesia site repo (`anantf-site`) on 24 Oct 2026; `anantf.com/exams/` forwards here.

- `exams/`: the pages (`index.html`, `essays.html`), `reference/` PDFs, and the few shared assets and fonts they need, all relative.
- `worker/`: the Worker (`routes.js` picks the folder, `sites.js` serves it) with Node tests.
- `tools/check.mjs`: repo checks. Run `node tools/check.mjs`.
- Deploy: `wrangler deploy` (GitHub Actions `deploy.yml` when the organisation secrets exist, otherwise run by a maintainer). Never Workers Builds.
