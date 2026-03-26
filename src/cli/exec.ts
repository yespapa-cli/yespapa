import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SOCKET_PATH } from '../daemon/socket.js';
import { openDatabase, getConfig } from '../db/index.js';

function sendToDaemon(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(SOCKET_PATH);
    let buffer = '';

    client.on('connect', () => {
      client.write(JSON.stringify(msg) + '\n');
    });
    client.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          client.end();
          resolve(JSON.parse(line));
          return;
        }
      }
    });
    client.on('error', (err) => reject(err));
    setTimeout(() => { client.end(); reject(new Error('Timeout')); }, 5000);
  });
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

// ── yespapa exec ───────────────────────────────

export const execCommand = new Command('exec')
  .description('Execute a command through the YesPaPa gateway')
  .option('--justification <reason>', 'Reason for running this command')
  .option('--timeout <seconds>', 'Timeout in seconds (0 = wait forever)', '0')
  .argument('<command...>', 'The command to execute (use -- before command)')
  .action(async (args: string[], options) => {
    // Check if remote exec is enabled
    const dbPath = join(homedir(), '.yespapa', 'yespapa.db');
    if (existsSync(dbPath)) {
      const db = openDatabase(dbPath);
      const allowed = getConfig(db, 'allow_remote_exec');
      db.close();
      if (allowed !== 'true') {
        const json = { event: 'denied', reason: 'remote_exec_disabled', hint: 'Enable with: yespapa config set allow_remote_exec true' };
        process.stderr.write('Remote execution is disabled. Enable it with:\n  yespapa config set allow_remote_exec true\n');
        process.stderr.write(JSON.stringify(json) + '\n');
        process.exit(1);
      }
    }

    const fullCommand = args.join(' ');

    if (!existsSync(SOCKET_PATH)) {
      // Daemon not running — allow command to pass through
      try { execSync(fullCommand, { stdio: 'inherit' }); } catch { /* command failed */ }
      process.exit(0);
    }
    const cmdName = args[0];
    const cmdArgs = args.slice(1);

    try {
      // Phase 1: Send to daemon
      const response = await sendToDaemon({
        command: cmdName,
        args: cmdArgs,
        fullCommand,
        justification: options.justification ?? undefined,
      }) as Record<string, string>;

      if (response.status === 'approved') {
        // Auto-bypass or allow-listed — execute immediately
        if (response.message) {
          process.stderr.write(`[YesPaPa] ${response.message}\n`);
        }
        execSync(fullCommand, { stdio: 'inherit' });
        process.exit(0);
      }

      if (response.status !== 'needs_totp') {
        const json = {
          event: 'denied',
          command: fullCommand,
          reason: response.message ?? 'Command denied',
          ...(!options.justification && { hint: 'Retry with --justification "reason" to help the approver decide' }),
        };
        process.stderr.write(JSON.stringify(json) + '\n');
        process.exit(1);
      }

      // Phase 2: Wait for approval (TOTP or remote)
      const cmdId = response.id;
      const rule = response.rule;

      process.stderr.write('\n');
      process.stderr.write(`  [YesPaPa] Command intercepted: ${fullCommand}\n`);
      if (rule) process.stderr.write(`  Rule: ${rule}\n`);
      if (options.justification) {
        process.stderr.write(`  Justification: ${options.justification}\n`);
      } else {
        process.stderr.write(`  Tip: use --justification "reason" to help the approver decide\n`);
      }
      process.stderr.write('\n');

      const timeoutSec = parseInt(options.timeout, 10);
      const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : 0;

      // Poll for remote resolution while waiting for stdin
      const rl = createInterface({ input: process.stdin, output: process.stderr });

      let resolved = false;
      const pollInterval = setInterval(async () => {
        if (resolved) return;
        try {
          const pollResp = await sendToDaemon({ check: cmdId }) as Record<string, string>;
          if (pollResp.status === 'approved') {
            resolved = true;
            clearInterval(pollInterval);
            rl.close();
            process.stderr.write(`  [YesPaPa] Approved remotely${pollResp.message ? `: ${pollResp.message}` : ''}\n`);
            const json = { event: 'approved', command: fullCommand, source: 'remote', message: pollResp.message };
            process.stderr.write(JSON.stringify(json) + '\n');
            try { execSync(fullCommand, { stdio: 'inherit' }); } catch { /* command failed */ }
            process.exit(0);
          } else if (pollResp.status === 'denied') {
            resolved = true;
            clearInterval(pollInterval);
            rl.close();
            process.stderr.write(`  [YesPaPa] Denied remotely${pollResp.message ? `: ${pollResp.message}` : ''}\n`);
            const json = { event: 'denied', command: fullCommand, source: 'remote', message: pollResp.message };
            process.stderr.write(JSON.stringify(json) + '\n');
            process.exit(1);
          }
        } catch { /* poll failed, continue */ }

        // Check timeout
        if (deadline > 0 && Date.now() > deadline) {
          resolved = true;
          clearInterval(pollInterval);
          rl.close();
          const json = { event: 'timeout', command: fullCommand };
          process.stderr.write(`  [YesPaPa] Timeout — command denied.\n`);
          process.stderr.write(JSON.stringify(json) + '\n');
          process.exit(1);
        }
      }, 1000);

      // Also accept TOTP from stdin
      let attempts = 0;
      process.stderr.write(`  Enter TOTP code or password (attempt 1/3): `);

      for await (const line of rl) {
        if (resolved) break;
        const code = line.trim();
        if (!code) { resolved = true; clearInterval(pollInterval); break; }
        attempts++;

        try {
          const totpResp = await sendToDaemon({ totp: code, id: cmdId }) as Record<string, string>;
          if (totpResp.status === 'approved') {
            resolved = true;
            clearInterval(pollInterval);
            rl.close();
            process.stderr.write(`  [YesPaPa] Approved\n`);
            const json = { event: 'approved', command: fullCommand, source: 'totp_stdin' };
            process.stderr.write(JSON.stringify(json) + '\n');
            try { execSync(fullCommand, { stdio: 'inherit' }); } catch { /* command failed */ }
            process.exit(0);
          }
        } catch { /* send failed */ }

        process.stderr.write(`  [YesPaPa] Invalid code\n`);
        if (attempts >= 3) {
          resolved = true;
          clearInterval(pollInterval);
          const json = {
            event: 'denied',
            command: fullCommand,
            reason: 'Too many failed TOTP attempts',
            ...(!options.justification && { hint: 'Retry with --justification "reason"' }),
          };
          process.stderr.write(`  [YesPaPa] Too many attempts. Command denied.\n`);
          process.stderr.write(JSON.stringify(json) + '\n');
          process.exit(1);
        }
        process.stderr.write(`  Enter TOTP code or password (attempt ${attempts + 1}/3): `);
      }

      if (!resolved) {
        clearInterval(pollInterval);
        process.exit(1);
      }
    } catch (err) {
      const json = { event: 'error', command: fullCommand, reason: String(err) };
      process.stderr.write(JSON.stringify(json) + '\n');
      process.exit(1);
    }
  });

// ── yespapa approve ────────────────────────────

export const approveCommand = new Command('approve')
  .description('Approve a pending command by ID (requires TOTP or master key)')
  .argument('<command_id>', 'Command ID to approve (e.g., cmd_a1b2c3d4)')
  .action(async (commandId: string) => {
    if (!existsSync(SOCKET_PATH)) {
      console.log('Daemon is not running.');
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const input = await prompt(rl, 'Enter TOTP code or master key: ');

      // Send to daemon — it handles both TOTP and password validation
      const response = await sendToDaemon({ totp: input.trim(), id: commandId });
      const resp = response as Record<string, string>;
      if (resp.status === 'approved') {
        console.log(`Command ${commandId} approved.`);
      } else {
        console.log(`Failed: ${resp.message ?? resp.status}`);
        process.exit(1);
      }
    } finally {
      rl.close();
    }
  });
