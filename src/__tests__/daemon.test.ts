import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import type { Server } from 'node:net';
import type Database from 'better-sqlite3';
import { openMemoryDatabase, getCommand } from '../db/index.js';
import { seedDefaultRules } from '../rules/index.js';
import { generateSeed, generateCode } from '../totp/index.js';
import { startDaemonServer, stopDaemonServer, type CommandRequest, type CommandResponse, type TotpSubmission } from '../daemon/socket.js';

const TEST_SOCKET = '/tmp/yespapa-test.sock';
const testSeed = generateSeed();

function sendMessage(msg: CommandRequest | TotpSubmission): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    const client = createConnection(TEST_SOCKET);
    let buffer = '';

    client.on('connect', () => {
      client.write(JSON.stringify(msg) + '\n');
    });

    client.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          client.end();
          resolve(JSON.parse(line));
        }
      }
    });

    client.on('error', reject);
    setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
  });
}

let db: Database.Database;
let server: Server;

describe('daemon socket server (two-phase protocol)', () => {
  beforeEach(async () => {
    db = openMemoryDatabase();
    seedDefaultRules(db);

    server = await startDaemonServer(
      db,
      (code) => code === generateCode(testSeed) || code === '999999', // accept test code
      () => false, // no grace periods
      TEST_SOCKET,
    );
  });

  afterEach(async () => {
    await stopDaemonServer(server, TEST_SOCKET);
  });

  it('allows allow-listed command immediately', async () => {
    const response = await sendMessage({ command: 'ls', args: ['-la'] });
    expect(response.status).toBe('approved');
  });

  it('allows pass-through command (not on any list)', async () => {
    const response = await sendMessage({ command: 'echo', args: ['hello'] });
    expect(response.status).toBe('approved');
  });

  it('returns needs_totp for deny-listed command', async () => {
    const response = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(response.status).toBe('needs_totp');
    expect(response.id).toMatch(/^cmd_/);
    expect(response.rule).toBeDefined();
  });

  it('approves after valid TOTP submission', async () => {
    // Phase 1: send command
    const phase1 = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(phase1.status).toBe('needs_totp');

    // Phase 2: send valid TOTP
    const phase2 = await sendMessage({ totp: '999999', id: phase1.id });
    expect(phase2.status).toBe('approved');

    // Verify in DB
    const cmd = getCommand(db, phase1.id);
    expect(cmd?.status).toBe('approved');
    expect(cmd?.approval_source).toBe('totp_stdin');
  });

  it('denies after invalid TOTP submission', async () => {
    const phase1 = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(phase1.status).toBe('needs_totp');

    const phase2 = await sendMessage({ totp: '000000', id: phase1.id });
    expect(phase2.status).toBe('denied');
    expect(phase2.message).toContain('Invalid');
  });

  it('stores justification in command log', async () => {
    const phase1 = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
      justification: 'clearing build artifacts',
    });
    const cmd = getCommand(db, phase1.id);
    expect(cmd?.justification).toBe('clearing build artifacts');
  });

  it('auto-approves when grace period is active', async () => {
    // Restart with grace checker that returns true
    await stopDaemonServer(server, TEST_SOCKET);
    server = await startDaemonServer(
      db,
      () => false,
      () => true, // grace period active
      TEST_SOCKET,
    );

    const response = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(response.status).toBe('approved');
  });
});
