import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig } from '../db/index.js';
import { initializeRemote, restoreSession, authenticateAnonymous } from '../remote/index.js';
import { pushCommand } from '../remote/sync.js';
import type { RemoteProviderType } from '../remote/factory.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');

export const testCommand = new Command('test')
  .description('Send a test command to verify mobile app connectivity and push notifications')
  .action(async () => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized. Run "yespapa init" first.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);

    const remoteUrl = getConfig(db, 'remote_url');
    const remoteKey = getConfig(db, 'remote_key');
    const remoteHostId = getConfig(db, 'remote_host_id');
    const refreshToken = getConfig(db, 'remote_refresh_token');
    const remoteType = (getConfig(db, 'remote_type') ?? 'supabase') as RemoteProviderType;

    if (!remoteUrl || !remoteKey || !remoteHostId) {
      console.log('Remote server not configured. Run "yespapa init" with mobile app pairing.');
      db.close();
      process.exit(1);
    }

    console.log('\n  YesPaPa Connectivity Test\n');
    console.log('  1. Connecting to remote server...');
    const remote = await initializeRemote(remoteUrl, remoteKey, remoteType);

    // Authenticate
    console.log('  2. Authenticating...');
    try {
      if (refreshToken) {
        await restoreSession(refreshToken);
      } else {
        await authenticateAnonymous();
      }
      console.log('     ✓ Authenticated');
    } catch (err) {
      console.log(`     ✗ Auth failed: ${err}`);
      db.close();
      process.exit(1);
    }

    // Check host exists
    console.log('  3. Checking host record...');
    const host = await remote.getHostById(remoteHostId);

    if (!host) {
      console.log('     ✗ Host not found');
      db.close();
      process.exit(1);
    }
    console.log(`     ✓ Host: ${host.host_name}`);
    console.log(`     ${host.push_token ? '✓ Push token registered' : '✗ No push token — mobile app may not receive notifications'}`);

    // Insert test command
    const testId = `cmd_test_${Date.now().toString(36)}`;
    console.log('  4. Sending test command...');
    try {
      await pushCommand(remote, remoteHostId, testId, 'echo "YesPaPa test — approve or deny this from your phone"', 'Dry-run test to verify mobile app connectivity');
      console.log('     ✓ Command inserted into remote server');
    } catch (err) {
      console.log(`     ✗ Failed: ${(err as Error).message}`);
      db.close();
      process.exit(1);
    }

    console.log('\n  ✓ Command sent! Waiting for response from mobile app...');
    console.log('    Approve or deny from your phone (timeout: 60s)\n');

    // Subscribe to Realtime and wait for approval/denial
    const result = await new Promise<{ status: string; message?: string } | null>((resolve) => {
      const timeout = setTimeout(() => {
        sub.unsubscribe();
        resolve(null);
      }, 60_000);

      const sub = remote.subscribeToHostEvents(remoteHostId, {
        onCommandUpdate: (update) => {
          if (update.id === testId && (update.status === 'approved' || update.status === 'denied')) {
            clearTimeout(timeout);
            sub.unsubscribe();
            resolve({ status: update.status, message: update.message });
          }
        },
        onStatusChange: (status, err) => {
          if (err) {
            console.log(`     ⚠ Realtime: ${status} — ${err.message}`);
          }
        },
      });
    });

    if (result) {
      const icon = result.status === 'approved' ? '✓' : '✗';
      const label = result.status === 'approved' ? 'Approved' : 'Denied';
      console.log(`  ${icon} ${label}${result.message ? `: ${result.message}` : ''}`);
      console.log('\n  ✓ End-to-end connectivity verified!\n');
    } else {
      console.log('  ✗ Timed out — no response received in 60s.');
      console.log('    Check that the mobile app is open and connected.\n');
    }

    remote.removeAllSubscriptions();
    db.close();
    process.exit(result ? 0 : 1);
  });
