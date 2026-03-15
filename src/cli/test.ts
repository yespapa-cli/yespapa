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

    console.log('\n  ✓ All checks passed!\n');
    console.log('  Check your phone:');
    console.log('    - You should see a push notification (if push token is registered)');
    console.log('    - Open the app → Command Queue to see the test command');
    console.log('    - Try approving or denying it\n');

    // Note: Polling for resolution removed since we no longer expose raw Supabase client.
    // The daemon handles resolution via Realtime. For testing, manual verification is sufficient.
    console.log('  The daemon will receive the response via Realtime.');
    console.log('  Run "yespapa status" to verify.\n');

    db.close();
    process.exit(0);
  });
