-- SAQ marker (exams.anantf.com/saq/). Apply: npx wrangler@4 d1 migrations apply exams-saq --remote (or --local)
-- Answers and question stems are never stored: only counters, scores and token use.

-- Admin settings and the marker's own state (key -> JSON-encoded value)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Prompt material loaded by tools/saq-load.mjs: mark_rules, draft_rules, rubric, index, essay:1 … essay:29
CREATE TABLE docs (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- One row per use: a mark, or a generated model answer. Reserved before the model call (status 'pending',
-- estimated cost), then updated with the real tokens and score.
CREATE TABLE marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- ms since epoch
  day TEXT NOT NULL,              -- SGT date, YYYY-MM-DD
  period TEXT NOT NULL,           -- spending month: the SGT date of the 16th it started on
  device TEXT NOT NULL,           -- HMAC of the device id
  ip TEXT NOT NULL,               -- HMAC of the IP address
  kind TEXT NOT NULL,             -- 'mark' | 'model'
  essay TEXT NOT NULL,            -- '1'…'29' or 'own'
  model TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'pending' | 'ok' | 'error' | 'credit'
  raw INTEGER,
  adjusted INTEGER,
  in_tok INTEGER NOT NULL DEFAULT 0,
  out_tok INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0    -- estimated US$
);
CREATE INDEX marks_day_device ON marks (day, device);
CREATE INDEX marks_day_ip ON marks (day, ip);
CREATE INDEX marks_period ON marks (period);

-- Failed code attempts per IP hash per day (slows guessing)
CREATE TABLE fails (
  day TEXT NOT NULL,
  ip TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, ip)
);
