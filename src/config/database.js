const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const dataDir = path.join(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'pocketwise.sqlite');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  type TEXT NOT NULL CHECK(type IN ('income','expense')), category TEXT NOT NULL,
  payment_method TEXT NOT NULL, date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  recurring_id INTEGER REFERENCES recurring_transactions(id) ON DELETE SET NULL,
  occurrence_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(recurring_id, occurrence_date)
);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), month TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, category, month)
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, target_cents INTEGER NOT NULL CHECK(target_cents > 0), saved_cents INTEGER NOT NULL DEFAULT 0 CHECK(saved_cents >= 0),
  target_date TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS recurring_transactions (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  type TEXT NOT NULL CHECK(type IN ('income','expense')), category TEXT NOT NULL,
  payment_method TEXT NOT NULL, frequency TEXT NOT NULL CHECK(frequency IN ('daily','weekly','monthly','yearly')),
  start_date TEXT NOT NULL, end_date TEXT, last_generated_date TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_user_category ON transactions(user_id, category);
CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, month);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_transactions(active, last_generated_date);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expired INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

module.exports = db;
