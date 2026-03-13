import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getConfig, getActiveGracePeriods, createGracePeriod, revokeGracePeriod } from '../db/index.js';
import { decryptSeed, verifyPassword } from '../crypto/index.js';
import { validateCode } from '../totp/index.js';
import { createGraceToken, getGraceRemaining, DURATION_1H, DURATION_24H, DURATION_7D } from '../crypto/grace.js';
import { initializeSupabase } from '../supabase/index.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

const DURATIONS: Record<string, number> = {
  '1h': DURATION_1H,
  '24h': DURATION_24H,
  '7d': DURATION_7D,
};

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

const activateCommand = new Command('activate')
  .description('Activate auto-bypass (skip TOTP for commands matching a scope)')
  .requiredOption('--scope <scope>', 'Scope: "all" or a bundle name (destructive, git-rewrite, etc.)')
  .requiredOption('--duration <duration>', 'Duration: 1h, 24h, or 7d')
  .action(async (options) => {
    const db = ensureInitialized();
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const durationMs = DURATIONS[options.duration];
      if (!durationMs) {
        console.log(`Invalid duration: ${options.duration}. Use: 1h, 24h, or 7d`);
        process.exit(1);
      }

      // Get seed for HMAC
      const encryptedSeed = getConfig(db, 'totp_seed');
      if (!encryptedSeed) {
        console.log('No TOTP seed found. Run "yespapa init" first.');
        process.exit(1);
      }

      const input = await prompt(rl, 'Enter TOTP code or master key: ');
      let seed!: string;

      // Try as password first — gives us both auth and seed decryption
      const passwordHash = getConfig(db, 'master_key_hash') ?? getConfig(db, 'removal_password_hash');
      let authenticated = false;
      if (passwordHash && await verifyPassword(input, passwordHash)) {
        try {
          seed = await decryptSeed(encryptedSeed, input);
          authenticated = true;
        } catch {
          console.log('Password verified but seed decryption failed.');
          process.exit(1);
        }
      }

      if (!authenticated) {
        // Input might be TOTP — need master key to decrypt seed for HMAC
        const password = await prompt(rl, 'Enter master key to decrypt seed: ');
        try {
          seed = await decryptSeed(encryptedSeed, password);
        } catch {
          console.log('Wrong password.');
          process.exit(1);
        }
        if (!validateCode(seed!, input.trim())) {
          console.log('Invalid TOTP code.');
          process.exit(1);
        }
      }

      // Create HMAC-signed grace token
      const token = createGraceToken(seed, options.scope, durationMs);

      // Store locally
      createGracePeriod(db, token.id, token.scope, token.expires_at, token.hmac_signature);

      // Sync to Supabase if configured
      const supabaseUrl = getConfig(db, 'supabase_url');
      const supabaseAnonKey = getConfig(db, 'supabase_anon_key');
      const supabaseHostId = getConfig(db, 'supabase_host_id');

      if (supabaseUrl && supabaseAnonKey && supabaseHostId) {
        try {
          const supabase = initializeSupabase(supabaseUrl, supabaseAnonKey);
          await supabase.auth.signInAnonymously();
          await supabase.from('grace_periods').insert({
            id: token.id,
            host_id: supabaseHostId,
            scope: token.scope,
            expires_at: token.expires_at,
            hmac_signature: token.hmac_signature,
          });
        } catch {
          console.log('  (Failed to sync to remote — auto-bypass active locally only)');
        }
      }

      console.log(`\n  ✓ Auto-bypass activated`);
      console.log(`    Scope:   ${token.scope}`);
      console.log(`    Expires: ${getGraceRemaining(token)}`);
      console.log(`    ID:      ${token.id}\n`);
    } finally {
      rl.close();
      db.close();
    }
  });

const listCommand = new Command('list')
  .description('List active auto-bypasses')
  .action(() => {
    const db = ensureInitialized();
    const active = getActiveGracePeriods(db);

    if (active.length === 0) {
      console.log('No active auto-bypasses.');
      db.close();
      return;
    }

    console.log('\n  Active Auto-Bypasses:\n');
    console.log('  ID                  | Scope        | Remaining   ');
    console.log('  --------------------|--------------|-------------');
    for (const gp of active) {
      const remaining = new Date(gp.expires_at).getTime() - Date.now();
      const mins = Math.floor(remaining / 60_000);
      const hrs = Math.floor(mins / 60);
      const display = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
      console.log(`  ${gp.id.padEnd(20)}| ${gp.scope.padEnd(13)}| ${display}`);
    }
    console.log('');
    db.close();
  });

const revokeCommand = new Command('revoke')
  .description('Revoke an auto-bypass')
  .option('--id <id>', 'Auto-bypass ID to revoke (revokes all if omitted)')
  .action(async (options) => {
    const db = ensureInitialized();
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      const active = getActiveGracePeriods(db);
      if (active.length === 0) {
        console.log('No active auto-bypasses to revoke.');
        return;
      }

      // Require TOTP or master key
      const passwordHash = getConfig(db, 'master_key_hash') ?? getConfig(db, 'removal_password_hash');
      const input = await prompt(rl, 'Enter TOTP code or master key: ');
      let authenticated = false;

      // Try as password
      if (passwordHash && await verifyPassword(input, passwordHash)) {
        authenticated = true;
      }

      if (!authenticated) {
        // Try as TOTP via decrypted seed
        const encryptedSeed = getConfig(db, 'totp_seed');
        if (!encryptedSeed) {
          console.log('No TOTP seed found.');
          process.exit(1);
        }
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

      const supabaseUrl = getConfig(db, 'supabase_url');
      const supabaseAnonKey = getConfig(db, 'supabase_anon_key');
      const supabaseHostId = getConfig(db, 'supabase_host_id');

      const toRevoke = options.id
        ? active.filter((gp) => gp.id === options.id)
        : active;

      if (toRevoke.length === 0) {
        console.log(`No auto-bypass found with ID: ${options.id}`);
        return;
      }

      for (const gp of toRevoke) {
        revokeGracePeriod(db, gp.id);

        // Sync revocation to Supabase
        if (supabaseUrl && supabaseAnonKey && supabaseHostId) {
          try {
            const supabase = initializeSupabase(supabaseUrl, supabaseAnonKey);
            await supabase.auth.signInAnonymously();
            await supabase.from('grace_periods')
              .update({ expires_at: new Date().toISOString() })
              .eq('id', gp.id);
          } catch { /* ignore sync failure */ }
        }
      }

      console.log(`\n  ✓ Revoked ${toRevoke.length} auto-bypass(es). TOTP required again.\n`);
    } finally {
      rl.close();
      db.close();
    }
  });

export const graceCommand = new Command('bypass')
  .description('Manage auto-bypass (temporarily skip TOTP for approved scopes)')
  .addCommand(activateCommand)
  .addCommand(listCommand)
  .addCommand(revokeCommand);
