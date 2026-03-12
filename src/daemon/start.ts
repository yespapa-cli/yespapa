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
import { initializeSupabase } from '../supabase/index.js';
import { pushCommand, syncCommandResolution, subscribeToApprovals } from '../supabase/sync.js';
import { createReconnectManager } from '../supabase/reconnect.js';

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

    // Connect to Supabase if configured
    const supabaseUrl = getConfig(db, 'supabase_url');
    const supabaseAnonKey = getConfig(db, 'supabase_anon_key');
    const supabaseHostId = getConfig(db, 'supabase_host_id');

    let onCommandPending: ((id: string, cmd: string, justification?: string) => void) | undefined;
    let onCommandResolved: ((id: string, status: string, source?: string) => void) | undefined;

    if (supabaseUrl && supabaseAnonKey && supabaseHostId) {
      try {
        const supabase = initializeSupabase(supabaseUrl, supabaseAnonKey);
        const reconnector = createReconnectManager(
          supabase,
          supabaseHostId,
          totpValidator,
          (state) => log(`Remote connection: ${state}`),
          (cmdId, status, message) => {
            log(`Remote resolution: ${cmdId} → ${status}${message ? ` (${message})` : ''}`);
          },
        );
        reconnector.connect();
        log(`Remote server connected (host: ${supabaseHostId})`);

        // Push pending commands to Supabase
        onCommandPending = (cmdId, cmd, justification) => {
          pushCommand(supabase, supabaseHostId, cmdId, cmd, justification).catch((err) => {
            log(`Failed to push command to remote: ${err}`);
          });
        };

        // Sync locally-resolved commands to Supabase
        onCommandResolved = (cmdId, status, source) => {
          syncCommandResolution(supabase, cmdId, status, source).catch((err) => {
            log(`Failed to sync resolution to remote: ${err}`);
          });
        };
      } catch (err) {
        log(`Remote connection failed: ${err}. Continuing in TOTP-only mode.`);
      }
    } else {
      log('No remote server configured. Running in TOTP-only mode.');
    }

    // Start socket server (with optional Supabase hooks)
    await startDaemonServer(db, totpValidator, graceChecker, SOCKET_PATH, onCommandPending, onCommandResolved);
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
