#!/usr/bin/env node

/**
 * Daemon entry point — runs as a detached background process.
 * Spawned by `yespapa init` or `yespapa start`.
 * Reads encrypted seed from DB, decrypts using password from argv, starts socket server.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { openDatabase, setConfig, getConfig, getActiveGracePeriods, createGracePeriod, revokeGracePeriod, upsertGracePeriod } from '../db/index.js';
import { decryptSeed, verifyPassword } from '../crypto/index.js';
import { validateCode } from '../totp/index.js';
import type { PasswordValidator } from './socket.js';
import { validateGraceToken, getGraceRemaining, type GraceToken } from '../crypto/grace.js';
import type { GraceMatch } from './socket.js';
import { startDaemonServer, SOCKET_PATH } from './socket.js';
import { startHeartbeat } from './heartbeat.js';
import { appendFileSync, statSync, renameSync, existsSync as fsExists, unlinkSync } from 'node:fs';
import { initializeRemote } from '../remote/index.js';
import { pushCommand, syncCommandResolution, subscribeToApprovals, fetchGracePeriods } from '../remote/sync.js';
import { createReconnectManager } from '../remote/reconnect.js';
import { injectInterceptor } from '../shell/interceptor.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');
const LOG_PATH = join(YESPAPA_DIR, 'daemon.log');

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    // Log rotation: if log exceeds 10MB, rotate to .old
    try {
      const stats = statSync(LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        const oldPath = LOG_PATH + '.old';
        if (fsExists(oldPath)) unlinkSync(oldPath);
        renameSync(LOG_PATH, oldPath);
      }
    } catch { /* file doesn't exist yet, fine */ }
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

    // Regenerate interceptor script (ensures on-disk version is current)
    try {
      injectInterceptor();
      log('Interceptor script regenerated');
    } catch (err) {
      log(`WARNING: Failed to regenerate interceptor: ${err}`);
    }

    // Clock skew warning: TOTP depends on accurate time
    const skewCheck = Math.abs(Date.now() % 30000);
    if (skewCheck < 100 || skewCheck > 29900) {
      log('WARNING: System clock may have sub-second precision issues — TOTP codes might fail at period boundaries');
    }

    // TOTP validator — closure over seed
    const totpValidator = (code: string): boolean => validateCode(seed, code);

    // Grace period checker — closure over db + seed, validates HMAC
    const graceChecker = (bundle?: string): GraceMatch | null => {
      const active = getActiveGracePeriods(db);
      for (const gp of active) {
        if (gp.scope === 'all' || gp.scope === bundle) {
          const token: GraceToken = {
            id: gp.id,
            scope: gp.scope,
            expires_at: gp.expires_at,
            hmac_signature: gp.hmac_signature,
            created_at: gp.created_at,
          };
          if (validateGraceToken(seed, token)) {
            return { scope: gp.scope, remaining: getGraceRemaining(token) };
          }
          log(`Grace period ${gp.id} failed HMAC validation — ignoring`);
        }
      }
      return null;
    };

    // Connect to remote if configured
    const remoteUrl = getConfig(db, 'remote_url');
    const remoteKey = getConfig(db, 'remote_key');
    const remoteHostId = getConfig(db, 'remote_host_id');

    let onCommandPending: ((id: string, cmd: string, justification?: string) => void) | undefined;
    let onCommandResolved: ((id: string, status: string, source?: string) => void) | undefined;

    if (remoteUrl && remoteKey && remoteHostId) {
      try {
        const remote = initializeRemote(remoteUrl, remoteKey);

        // Restore session — required for RLS policies to match user_id
        const refreshToken = getConfig(db, 'remote_refresh_token');
        if (refreshToken) {
          const { restoreSession } = await import('../remote/index.js');
          try {
            await restoreSession(refreshToken);
            log('Remote session restored successfully');
          } catch (authErr) {
            // Refresh token expired — try fresh anonymous auth as fallback
            log(`Session restore failed (${authErr}), trying fresh auth...`);
            const { authenticateAnonymous } = await import('../remote/index.js');
            const { refreshToken: newToken } = await authenticateAnonymous();
            setConfig(db, 'remote_refresh_token', newToken);
            log('Remote authenticated with new session (WARNING: user_id may have changed)');
          }
        } else {
          log('No refresh token stored — remote commands may fail due to RLS');
        }

        const reconnector = createReconnectManager(
          remote,
          remoteHostId,
          totpValidator,
          (state) => log(`Remote connection: ${state}`),
          (cmdId, status, message) => {
            log(`Remote resolution: ${cmdId} → ${status}${message ? ` (${message})` : ''}`);
          },
          (data) => {
            // Sync remote grace periods into local DB
            const id = data.id as string;
            const scope = data.scope as string;
            const expiresAt = data.expires_at as string;
            const hmac = data.hmac_signature as string;
            if (!id || !scope || !expiresAt || !hmac) return;

            // Check if expired (revocation sets expires_at = now)
            if (new Date(expiresAt) <= new Date()) {
              revokeGracePeriod(db, id);
              log(`Remote auto-bypass revoked: ${id}`);
              return;
            }

            upsertGracePeriod(db, id, scope, expiresAt, hmac);
            log(`Remote auto-bypass synced: ${id} (${scope}, expires ${expiresAt})`);
          },
          (msg) => log(`[sync] ${msg}`),
        );
        reconnector.connect();
        log(`Remote server connected (host: ${remoteHostId})`);

        // Periodic grace period sync to catch missed Realtime events (e.g. revocations)
        const GRACE_POLL_INTERVAL = 30_000; // 30s
        const gracePollHandler = (data: Record<string, unknown>) => {
          const id = data.id as string;
          const scope = data.scope as string;
          const expiresAt = data.expires_at as string;
          const hmac = data.hmac_signature as string;
          if (!id || !scope || !expiresAt || !hmac) return;

          if (new Date(expiresAt) <= new Date()) {
            revokeGracePeriod(db, id);
            return;
          }

          upsertGracePeriod(db, id, scope, expiresAt, hmac);
        };
        setInterval(() => {
          fetchGracePeriods(remote, remoteHostId, gracePollHandler).catch(() => {});
        }, GRACE_POLL_INTERVAL);

        // Push pending commands to remote
        onCommandPending = (cmdId, cmd, justification) => {
          pushCommand(remote, remoteHostId, cmdId, cmd, justification).catch((err) => {
            log(`Failed to push command to remote: ${err}`);
          });
        };

        // Sync locally-resolved commands to remote
        onCommandResolved = (cmdId, status, source) => {
          syncCommandResolution(remote, cmdId, status, source).catch((err) => {
            log(`Failed to sync resolution to remote: ${err}`);
          });
        };
      } catch (err) {
        log(`Remote connection failed: ${err}. Continuing in TOTP-only mode.`);
      }
    } else {
      log('No remote server configured. Running in TOTP-only mode.');
    }

    // Password bypass validator — always enabled when a password hash exists
    let passwordValidator: PasswordValidator | undefined;
    const passwordHash = getConfig(db, 'master_key_hash') ?? getConfig(db, 'removal_password_hash');
    if (passwordHash) {
      passwordValidator = (input: string) => verifyPassword(input, passwordHash);
    }

    // Start socket server (with optional remote hooks)
    await startDaemonServer(db, totpValidator, graceChecker, SOCKET_PATH, onCommandPending, onCommandResolved, passwordValidator);
    log(`Daemon started (PID: ${process.pid}, socket: ${SOCKET_PATH})`);

    // Start heartbeat
    startHeartbeat((result) => {
      log(`Tamper detected: interceptor repaired at ${result.timestamp}`);
    });

    // Handle graceful shutdown with socket cleanup
    const cleanup = (signal: string) => {
      log(`Daemon stopping (${signal})`);
      try {
        if (fsExists(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGTERM', () => cleanup('SIGTERM'));
    process.on('SIGINT', () => cleanup('SIGINT'));
    process.on('uncaughtException', (err) => {
      log(`Uncaught exception: ${err.message}`);
      cleanup('uncaughtException');
    });
  } catch (err) {
    log(`ERROR: ${err}`);
    process.exit(1);
  }
}

main();
