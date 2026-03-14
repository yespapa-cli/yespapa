import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import type { Server } from 'node:net';
import type Database from 'better-sqlite3';
import { openMemoryDatabase, getCommand, setConfig } from '../db/index.js';
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
      () => null, // no grace periods
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
    expect(response.timeout).toBe(120); // default timeout
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

  it('approves after valid master key submission', async () => {
    // Restart with password validator
    await stopDaemonServer(server, TEST_SOCKET);
    server = await startDaemonServer(
      db,
      () => false, // TOTP always invalid
      () => null,
      TEST_SOCKET,
      undefined,
      undefined,
      async (input: string) => input === 'my-master-key',
    );

    const phase1 = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(phase1.status).toBe('needs_totp');

    const phase2 = await sendMessage({ totp: 'my-master-key', id: phase1.id });
    expect(phase2.status).toBe('approved');
  });

  it('denies after invalid master key submission', async () => {
    // Restart with password validator
    await stopDaemonServer(server, TEST_SOCKET);
    server = await startDaemonServer(
      db,
      () => false, // TOTP always invalid
      () => null,
      TEST_SOCKET,
      undefined,
      undefined,
      async (input: string) => input === 'my-master-key',
    );

    const phase1 = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(phase1.status).toBe('needs_totp');

    const phase2 = await sendMessage({ totp: 'wrong-password', id: phase1.id });
    expect(phase2.status).toBe('denied');
  });

  it('auto-approves when auto-bypass is active', async () => {
    // Restart with grace checker that returns a match
    await stopDaemonServer(server, TEST_SOCKET);
    server = await startDaemonServer(
      db,
      () => false,
      () => ({ scope: 'all', remaining: '1h 0m' }), // auto-bypass active
      TEST_SOCKET,
    );

    const response = await sendMessage({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(response.status).toBe('approved');
    expect(response.message).toContain('Auto-bypass');
    expect(response.message).toContain('1h 0m');
  });

  it('auto-approves sudo when allow_sudo_bypass is true (default)', async () => {
    const response = await sendMessage({
      command: 'sudo',
      args: ['rm', '-rf', '/tmp/test'],
      fullCommand: 'sudo rm -rf /tmp/test',
    });
    expect(response.status).toBe('approved');
    expect(response.message).toContain('sudo bypass');

    // Verify logged with sudo_bypass source
    const cmd = getCommand(db, response.id);
    expect(cmd?.status).toBe('approved');
    expect(cmd?.approval_source).toBe('sudo_bypass');
  });

  it('requires TOTP for sudo when allow_sudo_bypass is false', async () => {
    setConfig(db, 'allow_sudo_bypass', 'false');

    const response = await sendMessage({
      command: 'sudo',
      args: ['rm', '-rf', '/tmp/test'],
      fullCommand: 'sudo rm -rf /tmp/test',
    });
    expect(response.status).toBe('needs_totp');
  });
});
