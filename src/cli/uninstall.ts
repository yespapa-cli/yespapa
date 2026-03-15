import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, rmSync } from 'node:fs';
import { openDatabase, getConfig } from '../db/index.js';
import { verifyPassword } from '../crypto/index.js';
import { removeInterceptor, INTERCEPTOR_FUNCTIONS } from '../shell/interceptor.js';
import { SOCKET_PATH } from '../daemon/socket.js';

function resolveHome(): string {
  // When running under sudo, homedir() returns root's home — use the original user's instead
  const sudoUser = process.env['SUDO_USER'];
  if (process.getuid?.() === 0 && sudoUser) {
    return join(process.platform === 'darwin' ? '/Users' : '/home', sudoUser);
  }
  return homedir();
}

const YESPAPA_DIR = join(resolveHome(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

export const uninstallCommand = new Command('uninstall')
  .description('Uninstall YesPaPa (requires TOTP or master key)')
  .action(async () => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not installed.');
      process.exit(0);
    }

    const db = openDatabase(DB_PATH);
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      console.log('\n🔒 YesPaPa — Uninstall\n');

      // Running as root (sudo) bypasses authentication — root can rm -rf ~/.yespapa anyway
      const isRoot = process.getuid?.() === 0;

      if (isRoot) {
        console.log('Running as root — skipping authentication.\n');
      } else {
        console.log('Authentication required to uninstall.\n');

        const passwordHash = getConfig(db, 'master_key_hash') ?? getConfig(db, 'removal_password_hash');
        const input = await prompt(rl, 'Enter TOTP code or master key: ');

        let authenticated = false;

        // Try as password
        if (passwordHash) {
          authenticated = await verifyPassword(input, passwordHash);
        }

        // Try as TOTP via daemon if password didn't match
        if (!authenticated) {
          try {
            const { createConnection } = await import('node:net');
            const resp = await new Promise<string>((resolve, reject) => {
              const client = createConnection(SOCKET_PATH);
              let buffer = '';
              client.on('connect', () => {
                client.write(JSON.stringify({ command: '__uninstall_check', args: [], fullCommand: '__uninstall_check' }) + '\n');
              });
              client.on('data', (data) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                for (const line of lines) {
                  if (line.trim()) {
                    client.end();
                    resolve(line);
                    return;
                  }
                }
              });
              client.on('error', () => reject(new Error('no daemon')));
              setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
            });

            const parsed = JSON.parse(resp);
            if (parsed.status === 'needs_totp') {
              // Send TOTP
              const totpResp = await new Promise<string>((resolve, reject) => {
                const client = createConnection(SOCKET_PATH);
                let buffer = '';
                client.on('connect', () => {
                  client.write(JSON.stringify({ totp: input.trim(), id: parsed.id }) + '\n');
                });
                client.on('data', (data) => {
                  buffer += data.toString();
                  const lines = buffer.split('\n');
                  for (const line of lines) {
                    if (line.trim()) {
                      client.end();
                      resolve(line);
                      return;
                    }
                  }
                });
                client.on('error', () => reject(new Error('no daemon')));
                setTimeout(() => { client.end(); reject(new Error('timeout')); }, 3000);
              });

              const totpParsed = JSON.parse(totpResp);
              authenticated = totpParsed.status === 'approved';
            }
          } catch {
            // Daemon not running — TOTP validation not possible without daemon
          }
        }

        if (!authenticated) {
          console.log('\n✗ Invalid TOTP code or password. Uninstall blocked.');
          console.log('  This attempt has been logged as a potential tampering event.\n');
          process.exit(1);
        }

        console.log('\n✓ Authentication successful. Uninstalling...\n');
      }

      // Stop daemon FIRST to prevent heartbeat from re-injecting interceptor
      const daemonPid = getConfig(db, 'daemon_pid');
      if (daemonPid) {
        try {
          process.kill(parseInt(daemonPid, 10), 'SIGTERM');
          console.log(`  ✓ Stopped daemon (PID: ${daemonPid})`);
          // Wait for daemon to fully exit before removing interceptor
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch {
          console.log(`  - Daemon not running (PID: ${daemonPid})`);
        }
      }

      // Remove source line from shell profiles
      const removedProfiles = removeInterceptor();
      for (const p of removedProfiles) {
        console.log(`  ✓ Removed source line from ${p}`);
      }

      // Close database before deleting
      db.close();

      // Remove socket
      if (existsSync(SOCKET_PATH)) {
        rmSync(SOCKET_PATH);
        console.log(`  ✓ Removed socket (${SOCKET_PATH})`);
      }

      // Delete entire ~/.yespapa/ directory
      if (existsSync(YESPAPA_DIR)) {
        rmSync(YESPAPA_DIR, { recursive: true, force: true });
        console.log(`  ✓ Removed ${YESPAPA_DIR}`);
      }

      console.log('\n🗑️  YesPaPa has been completely uninstalled.\n');
      console.log('Open a new terminal to complete cleanup, or run:');
      console.log(`  unset -f ${INTERCEPTOR_FUNCTIONS.join(' ')}\n`);
    } catch (error) {
      console.error('Uninstall failed:', error);
      process.exit(1);
    } finally {
      rl.close();
    }
  });
