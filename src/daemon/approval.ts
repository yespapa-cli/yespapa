import { createInterface } from 'node:readline';
import { validateCode } from '../totp/index.js';
import { getConfig } from '../db/index.js';
import { decryptSeed } from '../crypto/index.js';
import { getActiveGracePeriods, type GracePeriodRow } from '../db/index.js';
import type Database from 'better-sqlite3';
import type { CommandStatus, ApprovalSource } from '../db/index.js';

const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 30_000;

export interface ApprovalResult {
  status: CommandStatus;
  source?: ApprovalSource;
  message?: string;
}

/**
 * Check if an active grace period covers this command's scope/bundle.
 */
export function checkGracePeriod(
  db: Database.Database,
  bundle?: string,
): GracePeriodRow | undefined {
  const active = getActiveGracePeriods(db);
  for (const gp of active) {
    if (gp.scope === 'all' || gp.scope === bundle) {
      return gp;
    }
  }
  return undefined;
}

/**
 * Format remaining time for grace period display.
 */
function formatRemaining(expiresAt: string): string {
  const remaining = new Date(expiresAt).getTime() - Date.now();
  if (remaining <= 0) return '0s';
  const minutes = Math.floor(remaining / 60_000);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

/**
 * Display the interception box and prompt for TOTP via stdin.
 * Returns the approval result.
 */
export async function promptForApproval(
  commandId: string,
  command: string,
  args: string[],
  seed: string,
  justification?: string,
  timeoutMs: number = 0,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<ApprovalResult> {
  const cmdStr = [command, ...args].join(' ');

  // Display interception box
  output.write('\n');
  output.write('┌─────────────────────────────────────────────────┐\n');
  output.write('│  🔒 YesPaPa — Command Intercepted               │\n');
  output.write('├─────────────────────────────────────────────────┤\n');
  output.write(`│  Command: ${cmdStr.slice(0, 38).padEnd(38)}│\n`);
  if (justification) {
    output.write(`│  Reason:  ${justification.slice(0, 38).padEnd(38)}│\n`);
  }
  output.write(`│  ID:      ${commandId.padEnd(38)}│\n`);
  output.write('└─────────────────────────────────────────────────┘\n');
  output.write('\n');

  const rl = createInterface({ input, output, terminal: false });

  let attempts = 0;
  let resolved = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      resolved = true;
      rl.close();
    }, timeoutMs);
  }

  output.write(`Enter TOTP code (attempt 1/${MAX_ATTEMPTS}): `);

  try {
    for await (const line of rl) {
      if (resolved) break;

      const code = line.trim();
      if (!code) continue;
      attempts++;

      if (validateCode(seed, code)) {
        output.write('[YesPaPa] ✓ Approved\n');
        if (timer) clearTimeout(timer);
        return { status: 'approved', source: 'totp_stdin' } as ApprovalResult;
      }

      output.write('[YesPaPa] ✗ Invalid code\n');

      if (attempts >= MAX_ATTEMPTS) {
        output.write(`[YesPaPa] ✗ Too many attempts. Cooldown ${COOLDOWN_MS / 1000}s.\n`);
        if (timer) clearTimeout(timer);
        return { status: 'denied', message: 'Too many failed TOTP attempts' } as ApprovalResult;
      }

      output.write(`Enter TOTP code (attempt ${attempts + 1}/${MAX_ATTEMPTS}): `);
    }

    // If we get here, either timeout or input closed
    if (timer) clearTimeout(timer);
    if (resolved) {
      return { status: 'timeout' } as ApprovalResult;
    }
    return { status: 'denied', message: 'Input closed' } as ApprovalResult;
  } finally {
    rl.close();
  }
}

/**
 * Create the full approval handler for the daemon.
 * Checks grace periods first, then prompts for TOTP.
 */
export function createApprovalHandler(
  db: Database.Database,
  seed: string,
): (
  commandId: string,
  command: string,
  args: string[],
  justification?: string,
) => Promise<ApprovalResult> {
  return async (commandId, command, args, justification) => {
    // Check grace periods first
    // TODO: determine bundle from matched rule (pass through from socket handler)
    const grace = checkGracePeriod(db);
    if (grace) {
      const remaining = formatRemaining(grace.expires_at);
      process.stdout.write(
        `[YesPaPa] ✓ Auto-bypass (${grace.scope}, expires in ${remaining})\n`,
      );
      return { status: 'grace', source: 'grace_token' };
    }

    // Prompt for TOTP
    return promptForApproval(commandId, command, args, seed, justification);
  };
}
