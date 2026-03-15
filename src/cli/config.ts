import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig, setConfig } from '../db/index.js';
import { decryptSeed, verifyPassword } from '../crypto/index.js';
import { validateCode } from '../totp/index.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

const ALLOWED_KEYS = ['allow_password_bypass', 'default_timeout', 'allow_sudo_bypass', 'allow_remote_exec'];

const CONFIG_DEFAULTS: Record<string, { default: string; description: string }> = {
  allow_password_bypass: { default: 'true', description: 'Allow master key as TOTP bypass for command approval' },
  default_timeout: { default: '120', description: 'Approval timeout in seconds (0 = wait forever)' },
  allow_sudo_bypass: { default: 'true', description: 'Auto-approve sudo commands (false = require TOTP)' },
  allow_remote_exec: { default: 'false', description: 'Enable yespapa exec for programmatic access' },
};

/**
 * Validate a config value for a given key.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateConfigValue(key: string, value: string): string | null {
  switch (key) {
    case 'default_timeout': {
      const num = Number(value);
      if (!Number.isInteger(num) || num < 0) {
        return `Invalid value for default_timeout: "${value}"\n  Expected: non-negative integer (e.g., 0, 30, 120)`;
      }
      return null;
    }
    case 'allow_password_bypass':
    case 'allow_sudo_bypass':
    case 'allow_remote_exec': {
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for ${key}: "${value}"\n  Expected: true or false`;
      }
      return null;
    }
    default:
      return null;
  }
}

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

    const validationError = validateConfigValue(key, value);
    if (validationError) {
      console.log(validationError);
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

const listCommand = new Command('list')
  .description('List all config keys with current values and defaults')
  .action(() => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);
    console.log('\nYesPaPa Configuration\n');
    console.log('  Key                      Value             Default    Description');
    console.log('  ─────────────────────────────────────────────────────────────────────');
    for (const key of ALLOWED_KEYS) {
      const meta = CONFIG_DEFAULTS[key];
      const value = getConfig(db, key);
      const displayValue = value ?? `(${meta.default})`;
      const isDefault = !value;
      console.log(
        `  ${key.padEnd(25)}${displayValue.padEnd(18)}${meta.default.padEnd(11)}${meta.description}${isDefault ? '' : ''}`,
      );
    }
    console.log('');
    db.close();
  });

export const configCommand = new Command('config')
  .description('Manage YesPaPa configuration')
  .addCommand(setCommand)
  .addCommand(getCommand)
  .addCommand(listCommand);
