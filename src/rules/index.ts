import type Database from 'better-sqlite3';
import { getRulesByAction, addRule, type RuleRow } from '../db/index.js';

export interface EvalResult {
  action: 'deny' | 'allow' | 'pass';
  rule?: RuleRow;
}

// ── Allow-list: commands that are never intercepted ─────────

const ALLOW_LIST = new Set([
  'ls', 'cat', 'echo', 'pwd', 'cd', 'grep', 'find', 'man',
  'head', 'tail', 'wc', 'sort', 'less', 'more',
  'git status', 'git log', 'git diff', 'git branch', 'git add', 'git commit',
]);

// git checkout without -f is allowed
function isAllowListed(command: string, args: string[]): boolean {
  // Match command name alone (e.g., "ls" regardless of args)
  if (ALLOW_LIST.has(command)) return true;

  // Match command + first arg for subcommands (e.g., "git add", "git status")
  if (args.length > 0 && ALLOW_LIST.has(`${command} ${args[0]}`)) return true;

  // git checkout without -f
  if (command === 'git' && args[0] === 'checkout' && !args.includes('-f') && !args.includes('--force')) {
    return true;
  }

  return false;
}

// ── Default deny-list patterns (PRD §7.1) ───────────────────

export interface DefaultRule {
  pattern: string;
  bundle: string;
  reason: string;
  match: (command: string, args: string[]) => boolean;
}

export const DEFAULT_DENY_RULES: DefaultRule[] = [
  {
    pattern: 'rm',
    bundle: 'destructive',
    reason: 'Recursive deletion',
    match: (cmd, args) => cmd === 'rm' && (args.includes('-rf') || args.includes('-r') || args.some(a => a.startsWith('-') && a.includes('r') && a.includes('f'))),
  },
  {
    pattern: 'git reset',
    bundle: 'git-rewrite',
    reason: 'History rewrite',
    match: (cmd, args) => cmd === 'git' && args[0] === 'reset',
  },
  {
    pattern: 'git push -f',
    bundle: 'git-rewrite',
    reason: 'Force push',
    match: (cmd, args) => cmd === 'git' && args[0] === 'push' && (args.includes('-f') || args.includes('--force')),
  },
  {
    pattern: 'chmod',
    bundle: 'privilege',
    reason: 'World-writable permissions',
    match: (cmd, args) => cmd === 'chmod' && (args.includes('777') || args.some(a => /o\+w/.test(a))),
  },
  {
    pattern: 'curl | bash',
    bundle: 'network',
    reason: 'Blind remote execution',
    match: (_cmd, _args, fullCommand?: string) =>
      !!fullCommand && /curl\s+.*\|\s*(bash|sh|zsh)/.test(fullCommand),
  },
  {
    pattern: 'wget | sh',
    bundle: 'network',
    reason: 'Blind remote execution',
    match: (_cmd, _args, fullCommand?: string) =>
      !!fullCommand && /wget\s+.*\|\s*(bash|sh|zsh)/.test(fullCommand),
  },
  {
    pattern: 'sudo',
    bundle: 'privilege',
    reason: 'Privilege escalation',
    match: (cmd) => cmd === 'sudo',
  },
  {
    pattern: 'dd',
    bundle: 'destructive',
    reason: 'Block device write risk',
    match: (cmd) => cmd === 'dd',
  },
  {
    pattern: 'mkfs',
    bundle: 'destructive',
    reason: 'Disk format',
    match: (cmd) => cmd === 'mkfs' || cmd.startsWith('mkfs.'),
  },
  {
    pattern: 'kill -9',
    bundle: 'process',
    reason: 'Force-kill process',
    match: (cmd, args) => cmd === 'kill' && (args.includes('-9') || args.includes('-SIGKILL')),
  },
];

// ── Evaluation ──────────────────────────────────────────────

/**
 * Evaluate a command against the rule set.
 * Priority: allow-list > custom DB rules > default deny patterns.
 *
 * @param command - The base command (e.g., 'rm', 'git')
 * @param args - Command arguments
 * @param fullCommand - Optional full command string for pipe detection
 * @param db - Optional database for custom rules
 */
export function evaluateCommand(
  command: string,
  args: string[],
  fullCommand?: string,
  db?: Database.Database,
): EvalResult {
  // 1. Allow-list takes highest priority
  if (isAllowListed(command, args)) {
    return { action: 'allow' };
  }

  // 2. Custom DB rules (if database provided)
  if (db) {
    const customDeny = getRulesByAction(db, 'deny');
    for (const rule of customDeny) {
      if (matchesCustomRule(command, args, fullCommand, rule)) {
        return { action: 'deny', rule };
      }
    }

    const customAllow = getRulesByAction(db, 'allow');
    for (const rule of customAllow) {
      if (matchesCustomRule(command, args, fullCommand, rule)) {
        return { action: 'allow', rule };
      }
    }
  }

  // 3. Default deny patterns
  for (const defaultRule of DEFAULT_DENY_RULES) {
    if (defaultRule.match(command, args, fullCommand)) {
      return {
        action: 'deny',
        rule: {
          id: 0,
          pattern: defaultRule.pattern,
          bundle: defaultRule.bundle,
          action: 'deny',
          reason: defaultRule.reason,
          created_at: '',
        },
      };
    }
  }

  // 4. Not matched by any rule — pass through
  return { action: 'pass' };
}

function matchesCustomRule(
  command: string,
  args: string[],
  fullCommand: string | undefined,
  rule: RuleRow,
): boolean {
  const full = fullCommand ?? [command, ...args].join(' ');
  return full.includes(rule.pattern);
}

/**
 * Seed the database with default deny-list rules.
 */
export function seedDefaultRules(db: Database.Database): void {
  for (const rule of DEFAULT_DENY_RULES) {
    addRule(db, rule.pattern, 'deny', rule.reason, rule.bundle);
  }
}

/**
 * Get all unique bundle names from default rules.
 */
export function getBundleNames(): string[] {
  const bundles = new Set(DEFAULT_DENY_RULES.map((r) => r.bundle));
  return [...bundles];
}
