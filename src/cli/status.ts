import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig, getPendingCommands, getRecentCommands, getActiveGracePeriods } from '../db/index.js';
import { isInterceptorInstalled } from '../shell/interceptor.js';
import { SOCKET_PATH } from '../daemon/socket.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

export const statusCommand = new Command('status')
  .description('Show YesPaPa status')
  .action(() => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized. Run "yespapa init" first.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);

    const hostId = getConfig(db, 'host_id') ?? 'unknown';
    const daemonPid = getConfig(db, 'daemon_pid');
    const daemonRunning = daemonPid ? isProcessRunning(parseInt(daemonPid, 10)) : false;
    const socketExists = existsSync(SOCKET_PATH);
    const interceptorInstalled = isInterceptorInstalled();
    const pending = getPendingCommands(db);
    const graceActive = getActiveGracePeriods(db);
    const recent = getRecentCommands(db, 5);

    console.log('\n🔒 YesPaPa Status\n');
    console.log(`  Host:          ${hostId}`);
    console.log(`  Daemon:        ${daemonRunning ? '✓ running' : '✗ stopped'} (PID: ${daemonPid ?? 'none'})`);
    console.log(`  Socket:        ${socketExists ? '✓ active' : '✗ not found'} (${SOCKET_PATH})`);
    console.log(`  Interceptor:   ${interceptorInstalled ? '✓ installed' : '✗ not installed'}`);
    const remoteUrl = getConfig(db, 'remote_url');
    const remoteHostId = getConfig(db, 'remote_host_id');
    const channelCount = getConfig(db, 'realtime_channels');
    if (remoteUrl && remoteHostId) {
      const channelInfo = channelCount ? `, ${channelCount} channel(s)` : '';
      console.log(`  Remote:        ✓ configured (host: ${remoteHostId}${channelInfo})`);
    } else {
      console.log(`  Remote:        offline (not configured)`);
    }
    console.log(`  Pending:       ${pending.length} command(s)`);
    console.log(`  Auto-bypass:   ${graceActive.length} active`);

    if (recent.length > 0) {
      console.log('\n  Recent commands:');
      for (const cmd of recent) {
        const icon = cmd.status === 'approved' || cmd.status === 'grace' ? '✓' : '✗';
        console.log(`    ${icon} [${cmd.status}] ${cmd.command.slice(0, 50)} (${cmd.id})`);
      }
    }

    console.log('');
    db.close();
  });

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
