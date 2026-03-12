#!/usr/bin/env node

/**
 * Daemon entry point — runs as a detached background process.
 * Spawned by `yespapa init` or `yespapa start`.
 * Reads encrypted seed from DB, decrypts using password from argv, starts socket server.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, setConfig, getConfig, getActiveGracePeriods } from '../db/index.js';
import { decryptSeed } from '../crypto/index.js';
import { validateCode } from '../totp/index.js';
import { startDaemonServer, SOCKET_PATH } from './socket.js';
import { startHeartbeat } from './heartbeat.js';
import { appendFileSync } from 'node:fs';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');
const LOG_PATH = join(YESPAPA_DIR, 'daemon.log');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // Can't log, ignore
  }
}

async function main(): Promise<void> {
  const password = process.argv[2];
  if (!password) {
    log('ERROR: No password provided');
    process.exit(1);
  }

  try {
    const db = openDatabase(DB_PATH);
    const encryptedSeed = getConfig(db, 'totp_seed');
    if (!encryptedSeed) {
      log('ERROR: No TOTP seed found in database');
      process.exit(1);
    }

    const seed = await decryptSeed(encryptedSeed, password);

    // Update PID
    setConfig(db, 'daemon_pid', process.pid.toString());

    // TOTP validator — closure over seed
    const totpValidator = (code: string): boolean => validateCode(seed, code);

    // Grace period checker — closure over db
    const graceChecker = (bundle?: string): boolean => {
      const active = getActiveGracePeriods(db);
      return active.some((gp) => gp.scope === 'all' || gp.scope === bundle);
    };

    // Start socket server
    await startDaemonServer(db, totpValidator, graceChecker);
    log(`Daemon started (PID: ${process.pid}, socket: ${SOCKET_PATH})`);

    // Start heartbeat
    startHeartbeat((result) => {
      log(`Tamper detected: interceptor repaired at ${result.timestamp}`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      log('Daemon stopping (SIGTERM)');
      process.exit(0);
    });
    process.on('SIGINT', () => {
      log('Daemon stopping (SIGINT)');
      process.exit(0);
    });
  } catch (err) {
    log(`ERROR: ${err}`);
    process.exit(1);
  }
}

main();
