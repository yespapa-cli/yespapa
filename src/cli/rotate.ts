import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { openDatabase, setConfig, getConfig, getActiveGracePeriods, revokeGracePeriod } from '../db/index.js';
import { decryptSeed, encryptSeed } from '../crypto/index.js';
import { generateSeed, validateCode } from '../totp/index.js';
import { displayTotpQR } from '../totp/qr.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');
const PASSWORD_PATH = join(homedir(), '.yespapa', '.daemon_password');

function ensureInitialized(): ReturnType<typeof openDatabase> {
  if (!existsSync(DB_PATH)) {
    console.log('YesPaPa is not initialized. Run "yespapa init" first.');
    process.exit(1);
  }
  return openDatabase(DB_PATH);
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

export const rotateCommand = new Command('rotate-seed')
  .description('Rotate the TOTP seed (generates new seed, invalidates old)')
  .action(async () => {
    const db = ensureInitialized();
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const encryptedSeed = getConfig(db, 'totp_seed');
      if (!encryptedSeed) {
        console.log('No TOTP seed found.');
        process.exit(1);
      }

      // Step 1: Verify current TOTP
      console.log('\n  Step 1: Verify current TOTP\n');
      const password = await prompt(rl, '  Enter removal password: ');
      let oldSeed: string;
      try {
        oldSeed = await decryptSeed(encryptedSeed, password);
      } catch {
        console.log('  Wrong password.');
        process.exit(1);
      }

      const currentCode = await prompt(rl, '  Enter current TOTP code: ');
      if (!validateCode(oldSeed, currentCode.trim())) {
        console.log('  Invalid TOTP code.');
        process.exit(1);
      }
      console.log('  Current TOTP verified.\n');

      // Step 2: Generate new seed and display QR
      console.log('  Step 2: Scan new QR code with your authenticator\n');
      const newSeed = generateSeed();
      const hostName = getConfig(db, 'host_name') ?? homedir().split('/').pop() ?? 'host';
      await displayTotpQR(newSeed, hostName);

      // Step 3: Verify new TOTP
      console.log('\n  Step 3: Verify new TOTP\n');
      let verified = false;
      for (let i = 0; i < 3; i++) {
        const newCode = await prompt(rl, `  Enter new TOTP code (attempt ${i + 1}/3): `);
        if (validateCode(newSeed, newCode.trim())) {
          verified = true;
          break;
        }
        console.log('  Invalid code.');
      }
      if (!verified) {
        console.log('  Seed rotation cancelled — could not verify new TOTP.');
        process.exit(1);
      }

      // Step 4: Encrypt and store new seed
      const encryptedNewSeed = await encryptSeed(newSeed, password);
      setConfig(db, 'totp_seed', encryptedNewSeed);

      // Step 5: Invalidate all grace periods
      const active = getActiveGracePeriods(db);
      for (const gp of active) {
        revokeGracePeriod(db, gp.id);
      }

      // Step 6: Update daemon password file for auto-restart
      if (existsSync(PASSWORD_PATH)) {
        writeFileSync(PASSWORD_PATH, password, { mode: 0o600 });
      }

      console.log('\n  Seed rotated successfully!');
      console.log(`  - Old TOTP codes will no longer work`);
      console.log(`  - ${active.length} grace period(s) invalidated`);
      console.log(`  - Restart the daemon for changes to take effect\n`);
      console.log('  Run: yespapa restart\n');
    } finally {
      rl.close();
      db.close();
    }
  });
