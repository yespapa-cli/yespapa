import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig } from '../db/index.js';
import { initializeRemote, restoreSession, authenticateAnonymous } from '../remote/index.js';
import { pushCommand } from '../remote/sync.js';

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

    if (!remoteUrl || !remoteKey || !remoteHostId) {
      console.log('Remote server not configured. Run "yespapa init" with mobile app pairing.');
      db.close();
      process.exit(1);
    }

    console.log('\n  YesPaPa Connectivity Test\n');
    console.log('  1. Connecting to remote server...');
    const remote = initializeRemote(remoteUrl, remoteKey);

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
    const { data: host, error: hostErr } = await remote
      .from('hosts')
      .select('id, host_name, push_token')
      .eq('id', remoteHostId)
      .single();

    if (hostErr || !host) {
      console.log(`     ✗ Host not found: ${hostErr?.message ?? 'unknown error'}`);
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

    // Verify it's readable
    const { data: cmd, error: cmdErr } = await remote
      .from('commands')
      .select('*')
      .eq('id', testId)
      .single();

    if (cmdErr || !cmd) {
      console.log(`     ✗ Could not read back command: ${cmdErr?.message ?? 'not found'}`);
      console.log('     This suggests an RLS policy issue.');
      db.close();
      process.exit(1);
    }
    console.log('     ✓ Command verified in database');

    console.log('\n  ✓ All checks passed!\n');
    console.log('  Check your phone:');
    console.log('    - You should see a push notification (if push token is registered)');
    console.log('    - Open the app → Command Queue to see the test command');
    console.log('    - Try approving or denying it\n');

    // Wait for resolution
    console.log('  Waiting for your response (Ctrl+C to stop)...\n');
    const poll = setInterval(async () => {
      const { data: updated } = await remote
        .from('commands')
        .select('status, message, totp_code')
        .eq('id', testId)
        .single();

      if (updated && updated.status !== 'pending') {
        clearInterval(poll);
        if (updated.status === 'approved') {
          console.log(`  ✓ TEST APPROVED${updated.message ? ` — "${updated.message}"` : ''}`);
          console.log('  Mobile app → daemon communication is working!\n');
        } else {
          console.log(`  ✗ TEST DENIED${updated.message ? ` — "${updated.message}"` : ''}`);
          console.log('  Mobile app → daemon communication is working!\n');
        }

        // Clean up test command
        await remote.from('commands').delete().eq('id', testId);
        db.close();
        process.exit(0);
      }
    }, 1000);

    // Timeout after 2 minutes
    setTimeout(() => {
      clearInterval(poll);
      console.log('  ⏱ Timed out after 2 minutes. No response received.\n');
      console.log('  Troubleshooting:');
      console.log('    - Is the mobile app installed and paired?');
      console.log('    - Did you scan the pairing QR from "yespapa init"?');
      console.log('    - Check the Command Queue screen in the app');
      console.log('    - Ensure push notifications are enabled for the app\n');
      db.close();
      process.exit(1);
    }, 120_000);
  });
