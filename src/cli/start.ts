import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, getConfig } from '../db/index.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');
const PASSWORD_PATH = join(YESPAPA_DIR, '.daemon_password');

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

function isDaemonRunning(db: ReturnType<typeof openDatabase>): boolean {
  const pidStr = getConfig(db, 'daemon_pid');
  if (!pidStr) return false;
  try {
    process.kill(parseInt(pidStr, 10), 0);
    return true;
  } catch {
    return false;
  }
}

function spawnDaemon(password: string): void {
  const daemonScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'start.js');
  const child = spawn(process.execPath, [daemonScript, password], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export const startCommand = new Command('start')
  .description('Start the YesPaPa daemon')
  .option('--background', 'Start silently (for auto-start)')
  .action(async (options) => {
    if (!existsSync(DB_PATH)) {
      if (!options.background) console.log('YesPaPa is not initialized. Run "yespapa init" first.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);

    // Check if already running
    if (isDaemonRunning(db)) {
      if (!options.background) console.log('Daemon is already running.');
      db.close();
      return;
    }

    // Try saved password first (for auto-start)
    if (existsSync(PASSWORD_PATH)) {
      const password = readFileSync(PASSWORD_PATH, 'utf-8').trim();
      if (password) {
        spawnDaemon(password);
        if (!options.background) console.log('Daemon started.');
        db.close();
        return;
      }
    }

    // Interactive mode — prompt for password
    if (options.background) {
      // Can't prompt in background mode
      db.close();
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const password = await prompt(rl, 'Enter master key to start daemon: ');
      spawnDaemon(password);

      // Save password for future auto-starts
      writeFileSync(PASSWORD_PATH, password, { mode: 0o600 });
      console.log('Daemon started.');
    } finally {
      rl.close();
      db.close();
    }
  });

export const restartCommand = new Command('restart')
  .description('Restart the YesPaPa daemon')
  .action(async () => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);

    // Kill existing daemon
    const pidStr = getConfig(db, 'daemon_pid');
    if (pidStr) {
      try {
        process.kill(parseInt(pidStr, 10), 'SIGTERM');
        // Wait briefly for shutdown
        await new Promise((r) => setTimeout(r, 500));
      } catch { /* not running */ }
    }

    // Try saved password
    if (existsSync(PASSWORD_PATH)) {
      const password = readFileSync(PASSWORD_PATH, 'utf-8').trim();
      if (password) {
        spawnDaemon(password);
        console.log('Daemon restarted.');
        db.close();
        return;
      }
    }

    // Prompt
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const password = await prompt(rl, 'Enter master key: ');
      spawnDaemon(password);
      writeFileSync(PASSWORD_PATH, password, { mode: 0o600 });
      console.log('Daemon restarted.');
    } finally {
      rl.close();
      db.close();
    }
  });
