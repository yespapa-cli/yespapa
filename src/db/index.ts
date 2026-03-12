import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type CommandStatus = 'pending' | 'approved' | 'denied' | 'timeout' | 'grace';
export type ApprovalSource = 'totp_stdin' | 'app_approve' | 'grace_token';
export type RuleAction = 'deny' | 'allow';

export interface ConfigRow {
  key: string;
  value: string;
}

export interface RuleRow {
  id: number;
  pattern: string;
  bundle: string | null;
  action: RuleAction;
  reason: string | null;
  created_at: string;
}

export interface CommandLogRow {
  id: string;
  command: string;
  justification: string | null;
  status: CommandStatus;
  approval_source: ApprovalSource | null;
  denial_message: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface GracePeriodRow {
  id: string;
  scope: string;
  expires_at: string;
  hmac_signature: string;
  created_at: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    bundle TEXT,
    action TEXT NOT NULL CHECK(action IN ('deny', 'allow')),
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS command_log (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    justification TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'timeout', 'grace')),
    approval_source TEXT CHECK(approval_source IN ('totp_stdin', 'app_approve', 'grace_token')),
    denial_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS grace_periods (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    hmac_signature TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

export function openDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function openMemoryDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ── Config ──────────────────────────────────────────────────

export function getConfig(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

export function deleteConfig(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
}

// ── Rules ───────────────────────────────────────────────────

export function getRules(db: Database.Database): RuleRow[] {
  return db.prepare('SELECT * FROM rules ORDER BY id').all() as RuleRow[];
}

export function getRulesByAction(db: Database.Database, action: RuleAction): RuleRow[] {
  return db.prepare('SELECT * FROM rules WHERE action = ? ORDER BY id').all(action) as RuleRow[];
}

export function addRule(
  db: Database.Database,
  pattern: string,
  action: RuleAction,
  reason?: string,
  bundle?: string,
): RuleRow {
  const info = db
    .prepare('INSERT INTO rules (pattern, action, reason, bundle) VALUES (?, ?, ?, ?)')
    .run(pattern, action, reason ?? null, bundle ?? null);
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid) as RuleRow;
}

export function removeRule(db: Database.Database, pattern: string): boolean {
  const info = db.prepare('DELETE FROM rules WHERE pattern = ?').run(pattern);
  return info.changes > 0;
}

// ── Command Log ─────────────────────────────────────────────

export function createCommand(
  db: Database.Database,
  id: string,
  command: string,
  justification?: string,
): CommandLogRow {
  db.prepare(
    'INSERT INTO command_log (id, command, justification, status) VALUES (?, ?, ?, ?)',
  ).run(id, command, justification ?? null, 'pending');
  return db.prepare('SELECT * FROM command_log WHERE id = ?').get(id) as CommandLogRow;
}

export function resolveCommand(
  db: Database.Database,
  id: string,
  status: CommandStatus,
  approvalSource?: ApprovalSource,
  denialMessage?: string,
): void {
  db.prepare(
    `UPDATE command_log
     SET status = ?, approval_source = ?, denial_message = ?, resolved_at = datetime('now')
     WHERE id = ?`,
  ).run(status, approvalSource ?? null, denialMessage ?? null, id);
}

export function getCommand(db: Database.Database, id: string): CommandLogRow | undefined {
  return db.prepare('SELECT * FROM command_log WHERE id = ?').get(id) as CommandLogRow | undefined;
}

export function getPendingCommands(db: Database.Database): CommandLogRow[] {
  return db
    .prepare("SELECT * FROM command_log WHERE status = 'pending' ORDER BY created_at")
    .all() as CommandLogRow[];
}

export function getRecentCommands(db: Database.Database, limit: number = 5): CommandLogRow[] {
  return db
    .prepare('SELECT * FROM command_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as CommandLogRow[];
}

// ── Grace Periods ───────────────────────────────────────────

export function createGracePeriod(
  db: Database.Database,
  id: string,
  scope: string,
  expiresAt: string,
  hmacSignature: string,
): GracePeriodRow {
  db.prepare(
    'INSERT INTO grace_periods (id, scope, expires_at, hmac_signature) VALUES (?, ?, ?, ?)',
  ).run(id, scope, expiresAt, hmacSignature);
  return db.prepare('SELECT * FROM grace_periods WHERE id = ?').get(id) as GracePeriodRow;
}

export function getActiveGracePeriods(db: Database.Database): GracePeriodRow[] {
  const now = new Date().toISOString();
  return db
    .prepare('SELECT * FROM grace_periods WHERE expires_at > ? ORDER BY created_at')
    .all(now) as GracePeriodRow[];
}

export function revokeGracePeriod(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE grace_periods SET expires_at = ? WHERE id = ?').run(now, id);
}
