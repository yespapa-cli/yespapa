import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  openMemoryDatabase,
  createCommand,
  resolveCommand,
  getCommandStats,
} from '../db/index.js';

let db: Database.Database;

beforeEach(() => {
  db = openMemoryDatabase();
});

describe('getCommandStats', () => {
  it('returns zeros for empty database', () => {
    const stats = getCommandStats(db);
    expect(stats.total).toBe(0);
    expect(stats.approved).toBe(0);
    expect(stats.denied).toBe(0);
    expect(stats.approvalRate).toBe(0);
    expect(stats.avgResponseMs).toBe(0);
    expect(stats.busiestCommands).toHaveLength(0);
  });

  it('counts commands by status', () => {
    createCommand(db, 'cmd_1', 'rm -rf ./a');
    createCommand(db, 'cmd_2', 'rm -rf ./b');
    createCommand(db, 'cmd_3', 'git push -f');
    resolveCommand(db, 'cmd_1', 'approved', 'totp_stdin');
    resolveCommand(db, 'cmd_2', 'denied');
    resolveCommand(db, 'cmd_3', 'approved', 'app_approve');

    const stats = getCommandStats(db);
    expect(stats.total).toBe(3);
    expect(stats.approved).toBe(2);
    expect(stats.denied).toBe(1);
    expect(stats.pending).toBe(0);
  });

  it('computes approval rate correctly', () => {
    createCommand(db, 'cmd_1', 'rm -rf ./a');
    createCommand(db, 'cmd_2', 'rm -rf ./b');
    createCommand(db, 'cmd_3', 'rm -rf ./c');
    resolveCommand(db, 'cmd_1', 'approved', 'totp_stdin');
    resolveCommand(db, 'cmd_2', 'denied');
    resolveCommand(db, 'cmd_3', 'grace', 'grace_token');

    const stats = getCommandStats(db);
    // approved (1) + grace (1) = 2 out of 3 resolved = 66.7%
    expect(stats.approvalRate).toBe(66.7);
  });

  it('tracks approval sources', () => {
    createCommand(db, 'cmd_1', 'rm -rf ./a');
    createCommand(db, 'cmd_2', 'rm -rf ./b');
    createCommand(db, 'cmd_3', 'rm -rf ./c');
    resolveCommand(db, 'cmd_1', 'approved', 'totp_stdin');
    resolveCommand(db, 'cmd_2', 'approved', 'app_approve');
    resolveCommand(db, 'cmd_3', 'grace', 'grace_token');

    const stats = getCommandStats(db);
    expect(stats.bySource['totp_stdin']).toBe(1);
    expect(stats.bySource['app_approve']).toBe(1);
    expect(stats.bySource['grace_token']).toBe(1);
  });

  it('identifies busiest commands', () => {
    for (let i = 0; i < 5; i++) createCommand(db, `cmd_rm_${i}`, 'rm -rf ./dist');
    for (let i = 0; i < 3; i++) createCommand(db, `cmd_git_${i}`, 'git push -f');
    createCommand(db, 'cmd_sudo_1', 'sudo apt install');

    const stats = getCommandStats(db);
    expect(stats.busiestCommands[0].command).toBe('rm -rf ./dist');
    expect(stats.busiestCommands[0].count).toBe(5);
    expect(stats.busiestCommands[1].command).toBe('git push -f');
    expect(stats.busiestCommands[1].count).toBe(3);
  });

  it('filters by since parameter', () => {
    createCommand(db, 'cmd_old', 'rm -rf ./old');
    // Manually backdate the old command
    db.prepare("UPDATE command_log SET created_at = datetime('now', '-48 hours') WHERE id = 'cmd_old'").run();
    createCommand(db, 'cmd_new', 'rm -rf ./new');

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const stats = getCommandStats(db, since);
    expect(stats.total).toBe(1);

    const allStats = getCommandStats(db);
    expect(allStats.total).toBe(2);
  });

  it('handles pending commands in approval rate', () => {
    createCommand(db, 'cmd_1', 'rm -rf ./a');
    createCommand(db, 'cmd_2', 'rm -rf ./b');
    resolveCommand(db, 'cmd_1', 'approved', 'totp_stdin');
    // cmd_2 is still pending

    const stats = getCommandStats(db);
    expect(stats.pending).toBe(1);
    // Approval rate should only consider resolved commands: 1/1 = 100%
    expect(stats.approvalRate).toBe(100);
  });
});
