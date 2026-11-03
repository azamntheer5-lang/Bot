// ─── قاعدة البيانات المحلية للرشق (bun:sqlite) ───
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DATA_DIR = join(import.meta.dir, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "rashq.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

db.exec(`
CREATE TABLE IF NOT EXISTS members (
  user_id TEXT PRIMARY KEY,
  access_hash TEXT,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  username TEXT,
  phone TEXT,
  origin TEXT DEFAULT 'scrape',
  source_peer TEXT,
  status TEXT DEFAULT 'new',
  error TEXT,
  updated_at INTEGER
);`);
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  peer_id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT,
  access_hash TEXT,
  last_scrape INTEGER,
  last_count INTEGER
);`);
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
db.exec(`
CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT,
  title TEXT,
  usage_limit INTEGER,
  created_at INTEGER
);`);
db.exec(`
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  level TEXT,
  msg TEXT
);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_members_status_origin ON members(status, origin);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_members_source ON members(source_peer);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_members_updated ON members(updated_at);`);

// ─── الإعدادات ───

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.query("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    JSON.stringify(value)
  );
}

// ─── السجلات ───

export type LogLevel = "info" | "warn" | "error" | "success";

export function log(level: LogLevel, msg: string): void {
  try {
    db.query("INSERT INTO logs(ts, level, msg) VALUES(?, ?, ?)").run(Date.now(), level, msg);
    db.query("DELETE FROM logs WHERE id <= (SELECT MAX(id) - 500 FROM logs)").run();
  } catch {
    /* لا نوقف العمل بسبب السجل */
  }
  const tag = { info: "•", warn: "⚠", error: "✖", success: "✔" }[level];
  console.log(`${tag} [${new Date().toLocaleTimeString("sv")}] ${msg}`);
}

export interface LogRow {
  id: number;
  ts: number;
  level: string;
  msg: string;
}

export function getLogs(limit = 300, level?: string): LogRow[] {
  const q = level
    ? "SELECT id, ts, level, msg FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?"
    : "SELECT id, ts, level, msg FROM logs ORDER BY id DESC LIMIT ?";
  const stmt = db.query(q);
  return (level ? stmt.all(level, limit) : stmt.all(limit)) as LogRow[];
}

// ─── أدوات وقت (توقيت عدن UTC+3) ───

export function todayStr(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Aden" }).format(new Date());
}

export function msUntilMidnight(): number {
  const now = Date.now();
  const utcDayStart = Math.floor(now / 86_400_000) * 86_400_000;
  let midnight = utcDayStart + 21 * 3_600_000; // 21:00 UTC = منتصف الليل بتوقيت عدن
  if (midnight <= now) midnight += 86_400_000;
  return midnight - now;
}

export function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
