import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { openDatabase, getRules, addRule, removeRule } from '../db/index.js';
import { DEFAULT_DENY_RULES } from '../rules/index.js';
import { injectInterceptor, extractCommandNames } from '../shell/interceptor.js';

const DB_PATH = join(homedir(), '.yespapa', 'yespapa.db');

function ensureInitialized(): ReturnType<typeof openDatabase> {
  if (!existsSync(DB_PATH)) {
    console.log('YesPaPa is not initialized. Run "yespapa init" first.');
    process.exit(1);
  }
  return openDatabase(DB_PATH);
}

const listCommand = new Command('list')
  .description('List all active rules')
  .action(() => {
    const db = ensureInitialized();
    const rules = getRules(db);

    if (rules.length === 0) {
      console.log('No rules configured.');
      db.close();
      return;
    }

    console.log('\n  Active Rules:\n');
    console.log('  ID  | Action | Pattern                | Bundle       | Reason');
    console.log('  ----|--------|------------------------|--------------|------------------');
    for (const rule of rules) {
      const id = String(rule.id).padEnd(3);
      const action = rule.action.padEnd(6);
      const pattern = rule.pattern.padEnd(22);
      const bundle = (rule.bundle ?? '').padEnd(12);
      console.log(`  ${id} | ${action} | ${pattern} | ${bundle} | ${rule.reason ?? ''}`);
    }
    console.log('');
    db.close();
  });

const addCommand = new Command('add')
  .description('Add a custom rule')
  .requiredOption('--pattern <pattern>', 'Command pattern to match')
  .option('--reason <reason>', 'Human-readable reason')
  .option('--bundle <bundle>', 'Bundle name or add all rules in a bundle')
  .option('--action <action>', 'Rule action: deny or allow', 'deny')
  .action((options) => {
    const db = ensureInitialized();

    // If --bundle is provided without --pattern matching a specific command,
    // add all default rules from that bundle
    if (options.bundle && options.pattern === options.bundle) {
      const bundleRules = DEFAULT_DENY_RULES.filter((r) => r.bundle === options.bundle);
      if (bundleRules.length === 0) {
        console.log(`Unknown bundle: ${options.bundle}`);
        db.close();
        process.exit(1);
      }
      for (const rule of bundleRules) {
        addRule(db, rule.pattern, 'deny', rule.reason, rule.bundle);
      }
      console.log(`Added ${bundleRules.length} rules from bundle "${options.bundle}"`);
    } else {
      addRule(db, options.pattern, options.action, options.reason, options.bundle);
      console.log(`Added rule: ${options.action} "${options.pattern}"`);
    }

    // Regenerate interceptor with all custom rule commands
    const allRules = getRules(db);
    const customCmds = extractCommandNames(allRules.map((r) => r.pattern));
    injectInterceptor(undefined, customCmds);
    console.log('Shell interceptor updated.');
    db.close();
  });

const removeCommand = new Command('remove')
  .description('Remove a rule by pattern')
  .requiredOption('--pattern <pattern>', 'Pattern to remove')
  .action((options) => {
    const db = ensureInitialized();

    if (removeRule(db, options.pattern)) {
      console.log(`Removed rule: "${options.pattern}"`);
      const allRules = getRules(db);
      const customCmds = extractCommandNames(allRules.map((r) => r.pattern));
      injectInterceptor(undefined, customCmds);
      console.log('Shell interceptor updated.');
    } else {
      console.log(`No rule found with pattern: "${options.pattern}"`);
    }
    db.close();
  });

export const rulesCommand = new Command('rules')
  .description('Manage command interception rules')
  .addCommand(listCommand)
  .addCommand(addCommand)
  .addCommand(removeCommand);
