import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getCommandStats } from '../db/index.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

function parseSince(since: string): string {
  const now = new Date();
  const match = since.match(/^(\d+)(h|d)$/);
  if (!match) {
    console.error(`Invalid --since value: "${since}". Use format like 24h, 7d, 30d.`);
    process.exit(1);
  }
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') {
    now.setHours(now.getHours() - amount);
  } else {
    now.setDate(now.getDate() - amount);
  }
  return now.toISOString();
}

export const statsCommand = new Command('stats')
  .description('Show usage statistics')
  .option('--since <period>', 'Time period (e.g. 24h, 7d, 30d)', '7d')
  .action((opts) => {
    if (!existsSync(DB_PATH)) {
      console.log('YesPaPa is not initialized. Run "yespapa init" first.');
      process.exit(1);
    }

    const db = openDatabase(DB_PATH);
    const since = parseSince(opts.since);
    const stats = getCommandStats(db, since);

    console.log(`\n📊 YesPaPa Stats (last ${opts.since})\n`);
    console.log(`  Total commands:   ${stats.total}`);
    console.log(`  Approved:         ${stats.approved}`);
    console.log(`  Denied:           ${stats.denied}`);
    console.log(`  Timed out:        ${stats.timeout}`);
    console.log(`  Auto-bypassed:    ${stats.grace}`);
    console.log(`  Pending:          ${stats.pending}`);
    console.log(`  Approval rate:    ${stats.approvalRate}%`);
    console.log(`  Avg response:     ${stats.avgResponseMs > 0 ? `${stats.avgResponseMs}ms` : 'N/A'}`);

    if (Object.keys(stats.bySource).length > 0) {
      console.log('\n  Approval sources:');
      for (const [source, count] of Object.entries(stats.bySource)) {
        const label = source === 'totp_stdin' ? 'Terminal TOTP' : source === 'app_approve' ? 'Mobile app' : source === 'grace_token' ? 'Auto-bypass' : source;
        console.log(`    ${label}: ${count}`);
      }
    }

    if (stats.busiestCommands.length > 0) {
      console.log('\n  Most intercepted:');
      for (const { command, count } of stats.busiestCommands) {
        console.log(`    ${count}x  ${command.length > 50 ? command.slice(0, 47) + '...' : command}`);
      }
    }

    console.log('');
    db.close();
  });
