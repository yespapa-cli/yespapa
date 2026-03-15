import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, accessSync, constants } from 'node:fs';
import { createConnection } from 'node:net';
import { openDatabase, getConfig } from '../db/index.js';
import { isInterceptorInstalled, WRAPPER_COMMANDS } from '../shell/interceptor.js';
import { SOCKET_PATH } from '../daemon/socket.js';
import { green, red, yellow, bold } from './color.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');
const BIN_DIR = join(YESPAPA_DIR, 'bin');

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export const doctorCommand = new Command('doctor')
  .description('Check all components and report issues')
  .action(async () => {
    console.log(`\n  ${bold('YesPaPa Doctor')}\n`);
    const checks: Check[] = [];

    // 1. Node.js version
    const nodeVersion = process.versions.node;
    const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
    checks.push({
      name: 'Node.js version',
      status: nodeMajor >= 18 ? 'ok' : 'fail',
      detail: nodeMajor >= 18
        ? `v${nodeVersion}`
        : `v${nodeVersion} (requires >= 18)`,
    });

    // 2. ~/.yespapa/ directory
    const dirExists = existsSync(YESPAPA_DIR);
    let dirWritable = false;
    if (dirExists) {
      try {
        accessSync(YESPAPA_DIR, constants.W_OK);
        dirWritable = true;
      } catch { /* not writable */ }
    }
    checks.push({
      name: 'Data directory',
      status: dirExists && dirWritable ? 'ok' : 'fail',
      detail: !dirExists
        ? `${YESPAPA_DIR} does not exist — run "yespapa init"`
        : dirWritable
          ? YESPAPA_DIR
          : `${YESPAPA_DIR} is not writable`,
    });

    // 3. SQLite database
    let dbOk = false;
    if (existsSync(DB_PATH)) {
      try {
        const db = openDatabase(DB_PATH);
        // Verify schema by checking key tables
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        const tableNames = tables.map((t) => t.name);
        const required = ['config', 'rules', 'command_log', 'grace_periods'];
        const missing = required.filter((t) => !tableNames.includes(t));
        if (missing.length === 0) {
          dbOk = true;
          checks.push({ name: 'Database', status: 'ok', detail: DB_PATH });
        } else {
          checks.push({ name: 'Database', status: 'fail', detail: `Missing tables: ${missing.join(', ')}` });
        }

        // 4. TOTP seed
        const seed = getConfig(db, 'totp_seed');
        checks.push({
          name: 'TOTP seed',
          status: seed ? 'ok' : 'fail',
          detail: seed ? 'Encrypted seed stored' : 'No TOTP seed found — run "yespapa init"',
        });

        // 5. Remote server
        const remoteUrl = getConfig(db, 'remote_url');
        const remoteHostId = getConfig(db, 'remote_host_id');
        if (remoteUrl && remoteHostId) {
          checks.push({ name: 'Remote server', status: 'ok', detail: `Host ID: ${remoteHostId}` });
        } else {
          checks.push({ name: 'Remote server', status: 'warn', detail: 'Not configured (TOTP-only mode)' });
        }

        db.close();
      } catch (err) {
        checks.push({ name: 'Database', status: 'fail', detail: `Cannot open: ${err}` });
      }
    } else {
      checks.push({ name: 'Database', status: 'fail', detail: `${DB_PATH} not found — run "yespapa init"` });
      checks.push({ name: 'TOTP seed', status: 'fail', detail: 'No database' });
    }

    // 6. Daemon running
    const socketExists = existsSync(SOCKET_PATH);
    if (socketExists) {
      // Try to connect and send a health check
      const daemonAlive = await checkDaemonHealth();
      checks.push({
        name: 'Daemon',
        status: daemonAlive ? 'ok' : 'warn',
        detail: daemonAlive
          ? `Running (socket: ${SOCKET_PATH})`
          : `Socket exists but daemon not responding`,
      });
    } else {
      checks.push({
        name: 'Daemon',
        status: 'fail',
        detail: `Not running (no socket at ${SOCKET_PATH}) — run "yespapa start"`,
      });
    }

    // 7. Shell interceptor
    const interceptorInstalled = isInterceptorInstalled();
    checks.push({
      name: 'Shell interceptor',
      status: interceptorInstalled ? 'ok' : 'fail',
      detail: interceptorInstalled
        ? 'Source line present in shell profiles'
        : 'Not installed — run "yespapa init" or restart daemon',
    });

    // 8. Binary wrappers
    let wrapperCount = 0;
    for (const cmd of WRAPPER_COMMANDS) {
      if (existsSync(join(BIN_DIR, cmd))) wrapperCount++;
    }
    checks.push({
      name: 'Binary wrappers',
      status: wrapperCount === WRAPPER_COMMANDS.length ? 'ok' : wrapperCount > 0 ? 'warn' : 'fail',
      detail: `${wrapperCount}/${WRAPPER_COMMANDS.length} commands wrapped in ${BIN_DIR}`,
    });

    // 9. PATH check
    const pathDirs = (process.env.PATH ?? '').split(':');
    const binInPath = pathDirs.some((d) => d.includes('.yespapa/bin'));
    checks.push({
      name: 'PATH setup',
      status: binInPath ? 'ok' : 'warn',
      detail: binInPath
        ? '~/.yespapa/bin is in PATH'
        : '~/.yespapa/bin not in current PATH — source your shell profile',
    });

    // Print results
    let failCount = 0;
    let warnCount = 0;
    for (const check of checks) {
      const icon = check.status === 'ok'
        ? green('  [ok]  ')
        : check.status === 'warn'
          ? yellow('  [!!]  ')
          : red('  [FAIL]');
      console.log(`${icon} ${check.name}: ${check.detail}`);
      if (check.status === 'fail') failCount++;
      if (check.status === 'warn') warnCount++;
    }

    console.log('');
    if (failCount > 0) {
      console.log(red(`  ${failCount} issue(s) found. Run "yespapa init" to fix.\n`));
      process.exit(1);
    } else if (warnCount > 0) {
      console.log(yellow(`  All critical checks passed. ${warnCount} warning(s).\n`));
    } else {
      console.log(green('  All checks passed.\n'));
    }
  });

function checkDaemonHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(SOCKET_PATH);
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 2000);

    client.on('connect', () => {
      clearTimeout(timeout);
      client.end();
      resolve(true);
    });

    client.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}
