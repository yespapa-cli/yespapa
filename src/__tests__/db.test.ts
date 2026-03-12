import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openMemoryDatabase,
  getConfig,
  setConfig,
  deleteConfig,
  getRules,
  getRulesByAction,
  addRule,
  removeRule,
  createCommand,
  resolveCommand,
  getCommand,
  getPendingCommands,
  getRecentCommands,
  createGracePeriod,
  getActiveGracePeriods,
  revokeGracePeriod,
} from '../db/index.js';

let db: Database.Database;

beforeEach(() => {
  db = openMemoryDatabase();
});

describe('config table', () => {
  it('set and get config value', () => {
    setConfig(db, 'host_id', 'test-host');
    expect(getConfig(db, 'host_id')).toBe('test-host');
  });

  it('returns undefined for missing key', () => {
    expect(getConfig(db, 'nonexistent')).toBeUndefined();
  });

  it('upserts on duplicate key', () => {
    setConfig(db, 'key', 'value1');
    setConfig(db, 'key', 'value2');
    expect(getConfig(db, 'key')).toBe('value2');
  });

  it('deletes config value', () => {
    setConfig(db, 'key', 'value');
    deleteConfig(db, 'key');
    expect(getConfig(db, 'key')).toBeUndefined();
  });
});

describe('rules table', () => {
  it('adds and retrieves rules', () => {
    addRule(db, 'rm -rf', 'deny', 'Recursive delete', 'destructive');
    const rules = getRules(db);
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe('rm -rf');
    expect(rules[0].action).toBe('deny');
    expect(rules[0].bundle).toBe('destructive');
  });

  it('filters rules by action', () => {
    addRule(db, 'rm -rf', 'deny', 'Recursive delete');
    addRule(db, 'ls', 'allow', 'Safe command');
    expect(getRulesByAction(db, 'deny')).toHaveLength(1);
    expect(getRulesByAction(db, 'allow')).toHaveLength(1);
  });

  it('removes a rule by pattern', () => {
    addRule(db, 'rm -rf', 'deny');
    expect(removeRule(db, 'rm -rf')).toBe(true);
    expect(getRules(db)).toHaveLength(0);
  });

  it('returns false when removing nonexistent rule', () => {
    expect(removeRule(db, 'nonexistent')).toBe(false);
  });
});

describe('command_log table', () => {
  it('creates a pending command', () => {
    const cmd = createCommand(db, 'cmd_001', 'rm -rf ./dist', 'clearing build');
    expect(cmd.id).toBe('cmd_001');
    expect(cmd.status).toBe('pending');
    expect(cmd.justification).toBe('clearing build');
    expect(cmd.resolved_at).toBeNull();
  });

  it('resolves a command as approved', () => {
    createCommand(db, 'cmd_002', 'git push -f');
    resolveCommand(db, 'cmd_002', 'approved', 'totp_stdin');
    const cmd = getCommand(db, 'cmd_002');
    expect(cmd?.status).toBe('approved');
    expect(cmd?.approval_source).toBe('totp_stdin');
    expect(cmd?.resolved_at).not.toBeNull();
  });

  it('resolves a command as denied with message', () => {
    createCommand(db, 'cmd_003', 'rm -rf /');
    resolveCommand(db, 'cmd_003', 'denied', undefined, 'Too dangerous');
    const cmd = getCommand(db, 'cmd_003');
    expect(cmd?.status).toBe('denied');
    expect(cmd?.denial_message).toBe('Too dangerous');
  });

  it('lists pending commands', () => {
    createCommand(db, 'cmd_a', 'cmd1');
    createCommand(db, 'cmd_b', 'cmd2');
    resolveCommand(db, 'cmd_a', 'approved', 'totp_stdin');
    expect(getPendingCommands(db)).toHaveLength(1);
    expect(getPendingCommands(db)[0].id).toBe('cmd_b');
  });

  it('lists recent commands with limit', () => {
    for (let i = 0; i < 10; i++) {
      createCommand(db, `cmd_${i}`, `command ${i}`);
    }
    expect(getRecentCommands(db, 3)).toHaveLength(3);
  });
});

describe('grace_periods table', () => {
  it('creates a grace period', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const gp = createGracePeriod(db, 'gp_001', 'all', future, 'hmac_abc');
    expect(gp.id).toBe('gp_001');
    expect(gp.scope).toBe('all');
    expect(gp.hmac_signature).toBe('hmac_abc');
  });

  it('lists active (non-expired) grace periods', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    const past = new Date(Date.now() - 3600000).toISOString();
    createGracePeriod(db, 'gp_active', 'all', future, 'hmac1');
    createGracePeriod(db, 'gp_expired', 'destructive', past, 'hmac2');
    const active = getActiveGracePeriods(db);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('gp_active');
  });

  it('revokes a grace period', () => {
    const future = new Date(Date.now() + 3600000).toISOString();
    createGracePeriod(db, 'gp_rev', 'all', future, 'hmac3');
    revokeGracePeriod(db, 'gp_rev');
    expect(getActiveGracePeriods(db)).toHaveLength(0);
  });
});
