import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { homedir, hostname } from 'node:os';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateSeed, validateCode } from '../totp/index.js';
import { displayTotpQR } from '../totp/qr.js';
import { openDatabase, setConfig } from '../db/index.js';
import { hashPassword, encryptSeed } from '../crypto/index.js';
import { seedDefaultRules } from '../rules/index.js';
import { injectInterceptor } from '../shell/interceptor.js';
import { SOCKET_PATH } from '../daemon/socket.js';
import { initializeRemote, authenticateAnonymous, registerHost, generateHostFingerprint } from '../remote/index.js';
import { generatePairingToken, createCombinedPayload, generateCombinedQR, storePairingToken } from '../remote/pairing.js';

// Default remote server (YesPaPa management server)
const DEFAULT_REMOTE_URL = 'https://izvdpjcqrrcxhokwycgu.supabase.co';
const DEFAULT_REMOTE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml6dmRwamNxcnJjeGhva3d5Y2d1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMTI2OTgsImV4cCI6MjA4ODg4ODY5OH0.B-G2ZXIv5Tj8BXjgODN2V2mQdSXTpSQms-jxz62e00k';

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
      // Step 1: Generate TOTP seed (silent)
      console.log('Step 1/5: Generating TOTP seed...');
      const seed = generateSeed();
      const hostName = options.hostName ?? getDefaultHostName();

      // Step 2: Set master key (before QR, so user gets it out of the way)
      console.log('Step 2/5: Set a master key (for recovery if you lose your authenticator)');
      let password = '';
      while (true) {
        password = await promptPassword(rl, 'Set master key (min 8 chars): ');
        if (password.length < 8) {
          console.log('Password must be at least 8 characters.');
          continue;
        }
        const confirm = await promptPassword(rl, 'Confirm master key: ');
        if (password !== confirm) {
          console.log('Passwords do not match. Try again.');
          continue;
        }
        break;
      }

      // Step 3: Pair with mobile app? (default YES)
      console.log('\nStep 3/5: Pair with YesPaPa mobile app');
      const connectRemote = await prompt(rl, 'Pair with YesPaPa mobile app? (Y/n): ');
      const wantsMobile = connectRemote.trim().toLowerCase() !== 'n';

      let remoteUrl: string | undefined;
      let remoteKey: string | undefined;
      let remoteHostId: string | undefined;
      let remoteUserId: string | undefined;
      let remoteRefreshToken: string | undefined;

      if (wantsMobile) {
        // YES path: connect to remote, display combined QR, verify TOTP
        const urlInput = await prompt(rl, `Remote server URL [${DEFAULT_REMOTE_URL}]: `);
        remoteUrl = urlInput.trim() || DEFAULT_REMOTE_URL;
        const keyInput = await prompt(rl, `Remote server key [default]: `);
        remoteKey = keyInput.trim() || DEFAULT_REMOTE_KEY;

        try {
          console.log('\n  Connecting to remote server...');
          const remote = initializeRemote(remoteUrl, remoteKey);

          const { userId, refreshToken } = await authenticateAnonymous();
          console.log('  ✓ Authenticated with remote server');
          remoteUserId = userId;
          remoteRefreshToken = refreshToken;

          const hostRecord = await registerHost(hostName, generateHostFingerprint());
          console.log(`  ✓ Host registered (ID: ${hostRecord.id})`);
          remoteHostId = hostRecord.id;

          // Generate combined QR (TOTP seed + pairing data in one scan)
          const pairingToken = generatePairingToken();
          await storePairingToken(remote, hostRecord.id, pairingToken);
          const combinedPayload = createCombinedPayload(
            seed, hostName, remoteUrl, remoteKey,
            hostRecord.id, pairingToken, refreshToken,
          );
          const qrStr = await generateCombinedQR(combinedPayload);
          console.log('\n  Scan this QR code with the YesPaPa mobile app:');
          console.log('  (It contains both TOTP seed and pairing data — one scan does it all)\n');
          console.log(qrStr);

          // Also show text fallback for paste
          console.log(`\n  Can't scan? Paste this in the app: ${JSON.stringify(combinedPayload)}\n`);
        } catch (err) {
          console.log(`  ✗ Remote connection failed: ${err}`);
          console.log('  Falling back to standard TOTP QR. You can configure remote later.\n');
          remoteUrl = undefined;
          remoteKey = undefined;

          // Fall back to standard otpauth:// QR
          await displayTotpQR(seed, hostName);
        }
      } else {
        // NO path: standard otpauth:// QR
        console.log('\nScan this QR code with your authenticator app (Google Authenticator, Authy, etc.)');
        await displayTotpQR(seed, hostName);
      }

      // Verify TOTP (required regardless of path)
      console.log('Step 4/5: Verify your authenticator is set up correctly');
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

      // Step 5: Store everything, inject interceptor, start daemon
      console.log('Step 5/5: Setting up...');

      // Create directory
      if (!existsSync(YESPAPA_DIR)) {
        mkdirSync(YESPAPA_DIR, { recursive: true });
      }

      // Open database
      const db = openDatabase(DB_PATH);

      // Store config
      setConfig(db, 'host_id', hostName);

      // Encrypt and store seed
      const encryptedSeed = await encryptSeed(seed, password);
      setConfig(db, 'totp_seed', encryptedSeed);

      // Store master key hash
      const passwordHash = await hashPassword(password);
      setConfig(db, 'master_key_hash', passwordHash);

      // Store daemon PID
      setConfig(db, 'daemon_pid', process.pid.toString());

      // Create yespapa CLI wrapper in ~/.yespapa/bin/
      const binDir = join(YESPAPA_DIR, 'bin');
      if (!existsSync(binDir)) {
        mkdirSync(binDir, { recursive: true });
      }
      const cliEntryPoint = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
      const wrapperScript = `#!/bin/sh\nexec node "${cliEntryPoint}" "$@"\n`;
      const wrapperPath = join(binDir, 'yespapa');
      writeFileSync(wrapperPath, wrapperScript);
      chmodSync(wrapperPath, 0o755);
      setConfig(db, 'cli_entry_point', cliEntryPoint);
      console.log(`  ✓ CLI installed at ${wrapperPath}`);

      // Seed default rules
      seedDefaultRules(db);
      console.log('  ✓ Default deny-list rules installed (10 patterns)');

      // Inject shell interceptor
      const profiles = injectInterceptor();
      for (const p of profiles) {
        console.log(`  ✓ Shell interceptor injected into ${p}`);
      }

      // Store remote config (if connected) BEFORE starting daemon
      if (remoteUrl && remoteKey && remoteHostId) {
        setConfig(db, 'remote_url', remoteUrl);
        setConfig(db, 'remote_key', remoteKey);
        setConfig(db, 'remote_host_id', remoteHostId);
        if (remoteUserId) setConfig(db, 'remote_user_id', remoteUserId);
        if (remoteRefreshToken) setConfig(db, 'remote_refresh_token', remoteRefreshToken);
        console.log('  ✓ Remote server configured');
      }

      // Save password for daemon auto-restart (file permissions 0600)
      const passwordPath = join(YESPAPA_DIR, '.daemon_password');
      writeFileSync(passwordPath, password, { mode: 0o600 });

      // Start daemon once (remote config already in DB, no restart needed)
      db.close();
      const daemonScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'start.js');
      const child = spawn(process.execPath, [daemonScript, password], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`  ✓ Daemon started in background (PID: ${child.pid}, socket: ${SOCKET_PATH})`);

      rl.close();

      // Detect shell
      const shell = process.env.SHELL ?? '';
      const rcFile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';

      console.log('\n🎉 YesPaPa is active! Your shell is now guarded.');
      console.log(`\n   To activate interceptors in this terminal, run:`);
      console.log(`   source ${rcFile}\n`);
      console.log(`   Or open a new terminal window.\n`);
      console.log(`   Run "yespapa status" to check the current state.\n`);
      process.exit(0);
    } catch (error) {
      console.error('Initialization failed:', error);
      rl.close();
      process.exit(1);
    }
  });

function getDefaultHostName(): string {
  return hostname().toLowerCase().replace(/\.local$/, '');
}
