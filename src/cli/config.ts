import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig, setConfig } from '../db/index.js';
import { decryptSeed, verifyPassword } from '../crypto/index.js';
import { validateCode } from '../totp/index.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

const ALLOWED_KEYS = ['allow_password_bypass', 'default_timeout'];

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

const setCommand = new Command('set')
  .description('Set a config value (requires TOTP)')
  .argument('<key>', `Config key (${ALLOWED_KEYS.join(', ')})`)
  .argument('<value>', 'Config value')
  .action(async (key: string, value: string) => {
    if (!ALLOWED_KEYS.includes(key)) {
      console.log(`Unknown config key: ${key}. Allowed: ${ALLOWED_KEYS.join(', ')}`);
      process.exit(1);
    }

    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      // Require TOTP or password to change config
      const encryptedSeed = getConfig(db, 'totp_seed');
      if (!encryptedSeed) {
        console.log('No TOTP seed found.');
        process.exit(1);
      }

      const input = await prompt(rl, 'Enter TOTP code or master key: ');
      let authenticated = false;

      // Try as password
      const passwordHash = getConfig(db, 'master_key_hash') ?? getConfig(db, 'removal_password_hash');
      if (passwordHash && await verifyPassword(input, passwordHash)) {
        authenticated = true;
      }

      if (!authenticated) {
        // Try as TOTP — need password to decrypt seed
        const password = await prompt(rl, 'Enter master key to decrypt seed: ');
        let seed: string;
        try {
          seed = await decryptSeed(encryptedSeed, password);
        } catch {
          console.log('Wrong password.');
          process.exit(1);
        }
        if (!validateCode(seed, input.trim())) {
          console.log('Invalid TOTP code.');
          process.exit(1);
        }
      }

      setConfig(db, key, value);
      console.log(`Config updated: ${key} = ${value}`);
      console.log('Restart the daemon for changes to take effect: yespapa restart');
    } finally {
      rl.close();
      db.close();
    }
  });

const getCommand = new Command('get')
  .description('Get a config value')
  .argument('<key>', 'Config key')
  .action((key: string) => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);
    const value = getConfig(db, key);
    console.log(value ?? '(not set)');
    db.close();
  });

export const configCommand = new Command('config')
  .description('Manage YesPaPa configuration')
  .addCommand(setCommand)
  .addCommand(getCommand);
