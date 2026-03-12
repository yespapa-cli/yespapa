import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { generateSeed, validateCode } from '../totp/index.js';
import { displayTotpQR } from '../totp/qr.js';
import { openDatabase, setConfig } from '../db/index.js';
import { hashPassword, encryptSeed } from '../crypto/index.js';
import { seedDefaultRules } from '../rules/index.js';
import { injectInterceptor } from '../shell/interceptor.js';
import { startDaemonServer, SOCKET_PATH } from '../daemon/socket.js';
import { createApprovalHandler } from '../daemon/approval.js';
import { decryptSeed } from '../crypto/index.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const DB_PATH = join(YESPAPA_DIR, 'yespapa.db');

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

function promptPassword(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    // Note: In a real terminal, we'd hide input. commander or inquirer can do this.
    // For MVP, we use plain prompt.
    rl.question(question, (answer) => resolve(answer));
  });
}

export const initCommand = new Command('init')
  .description('Initialize YesPaPa on this machine')
  .option('--host-name <name>', 'Host name for this machine')
  .action(async (options) => {
    console.log('\n🔒 YesPaPa — Initialization\n');

    // Check if already initialized
    if (existsSync(DB_PATH)) {
      console.log('YesPaPa is already initialized on this machine.');
      console.log(`Database: ${DB_PATH}`);
      console.log('Run "yespapa uninstall" first if you want to reinitialize.');
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      // Step 1: Generate TOTP seed
      console.log('Step 1/5: Generating TOTP seed...');
      const seed = generateSeed();

      // Step 2: Display QR code
      console.log('Step 2/5: Scan this QR code with your authenticator app');
      await displayTotpQR(seed, options.hostName ?? getDefaultHostName());

      // Step 3: Verify TOTP
      console.log('Step 3/5: Verify your authenticator is set up correctly');
      let verified = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const code = await prompt(rl, `Enter current TOTP code (attempt ${attempt}/3): `);
        if (validateCode(seed, code.trim())) {
          console.log('✓ TOTP verified successfully!\n');
          verified = true;
          break;
        }
        console.log('✗ Invalid code. Try again.');
      }

      if (!verified) {
        console.log('\n✗ Failed to verify TOTP. Initialization aborted.');
        process.exit(1);
      }

      // Step 4: Set removal password
      console.log('Step 4/5: Set a removal password (for recovery if you lose your authenticator)');
      let password = '';
      while (true) {
        password = await promptPassword(rl, 'Set removal password (min 8 chars): ');
        if (password.length < 8) {
          console.log('Password must be at least 8 characters.');
          continue;
        }
        const confirm = await promptPassword(rl, 'Confirm removal password: ');
        if (password !== confirm) {
          console.log('Passwords do not match. Try again.');
          continue;
        }
        break;
      }

      // Step 5: Store everything and set up
      console.log('\nStep 5/5: Setting up...');

      // Create directory
      if (!existsSync(YESPAPA_DIR)) {
        mkdirSync(YESPAPA_DIR, { recursive: true });
      }

      // Open database
      const db = openDatabase(DB_PATH);

      // Store config
      const hostName = options.hostName ?? getDefaultHostName();
      setConfig(db, 'host_id', hostName);

      // Encrypt and store seed
      const encryptedSeed = await encryptSeed(seed, password);
      setConfig(db, 'totp_seed', encryptedSeed);

      // Store removal password hash
      const passwordHash = await hashPassword(password);
      setConfig(db, 'removal_password_hash', passwordHash);

      // Store daemon PID
      setConfig(db, 'daemon_pid', process.pid.toString());

      // Seed default rules
      seedDefaultRules(db);
      console.log('  ✓ Default deny-list rules installed (10 patterns)');

      // Inject shell interceptor
      const profiles = injectInterceptor();
      for (const p of profiles) {
        console.log(`  ✓ Shell interceptor injected into ${p}`);
      }

      // Start daemon
      const approvalSeed = await decryptSeed(encryptedSeed, password);
      const handler = createApprovalHandler(db, approvalSeed);
      await startDaemonServer(db, handler);
      console.log(`  ✓ Daemon started (socket: ${SOCKET_PATH})`);

      console.log('\n🎉 YesPaPa is active! Your shell is now guarded.');
      console.log('   Open a new terminal for interceptors to take effect.');
      console.log(`   Run "yespapa status" to check the current state.\n`);

      // Keep daemon running (don't exit)
      // The daemon will run until killed or "yespapa stop" is called
    } catch (error) {
      console.error('Initialization failed:', error);
      rl.close();
      process.exit(1);
    }
  });

function getDefaultHostName(): string {
  const { hostname } = require('node:os');
  return hostname().toLowerCase().replace(/\.local$/, '');
}
