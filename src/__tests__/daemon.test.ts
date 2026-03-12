import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import type { Server } from 'node:net';
import type Database from 'better-sqlite3';
import { openMemoryDatabase, getCommand } from '../db/index.js';
import { seedDefaultRules } from '../rules/index.js';
import { startDaemonServer, stopDaemonServer, type CommandRequest, type CommandResponse } from '../daemon/socket.js';

const TEST_SOCKET = '/tmp/yespapa-test.sock';

function sendCommand(request: CommandRequest): Promise<CommandResponse> {
  return new Promise((resolve, reject) => {
    const client = createConnection(TEST_SOCKET);
    let buffer = '';

    client.on('connect', () => {
      client.write(JSON.stringify(request) + '\n');
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

describe('daemon socket server', () => {
  beforeEach(async () => {
    db = openMemoryDatabase();
    seedDefaultRules(db);

    // Auto-approve handler for testing
    server = await startDaemonServer(
      db,
      async (commandId) => {
        return { status: 'approved' as const, source: 'totp_stdin' as const };
      },
      TEST_SOCKET,
    );
  });

  afterEach(async () => {
    await stopDaemonServer(server, TEST_SOCKET);
  });

  it('allows allow-listed command immediately', async () => {
    const response = await sendCommand({ command: 'ls', args: ['-la'] });
    expect(response.status).toBe('approved');
  });

  it('allows pass-through command (not on any list)', async () => {
    const response = await sendCommand({ command: 'echo', args: ['hello'] });
    expect(response.status).toBe('approved');
  });

  it('intercepts deny-listed command and resolves via handler', async () => {
    const response = await sendCommand({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
    });
    expect(response.status).toBe('approved');
    expect(response.id).toMatch(/^cmd_/);

    // Verify command was logged in DB
    const cmd = getCommand(db, response.id);
    expect(cmd).toBeDefined();
    expect(cmd?.status).toBe('approved');
    expect(cmd?.approval_source).toBe('totp_stdin');
  });

  it('stores justification in command log', async () => {
    const response = await sendCommand({
      command: 'rm',
      args: ['-rf', './dist'],
      fullCommand: 'rm -rf ./dist',
      justification: 'clearing build artifacts',
    });
    const cmd = getCommand(db, response.id);
    expect(cmd?.justification).toBe('clearing build artifacts');
  });

  it('handles denial from approval handler', async () => {
    // Restart with denying handler
    await stopDaemonServer(server, TEST_SOCKET);
    server = await startDaemonServer(
      db,
      async () => ({
        status: 'denied' as const,
        message: 'Too dangerous',
      }),
      TEST_SOCKET,
    );

    const response = await sendCommand({
      command: 'rm',
      args: ['-rf', '/'],
      fullCommand: 'rm -rf /',
    });
    expect(response.status).toBe('denied');
    expect(response.message).toBe('Too dangerous');
  });
});
