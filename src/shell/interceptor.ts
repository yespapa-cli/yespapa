import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SOCKET_PATH } from '../daemon/socket.js';
import { DEFAULT_DENY_RULES } from '../rules/index.js';

const MARKER_START = '# >>> YesPaPa Shell Interceptor (DO NOT EDIT)';
const MARKER_END = '# <<< YesPaPa Shell Interceptor';

/**
 * Generate the shell interceptor script.
 * Creates wrapper functions for each deny-listed command that route through the daemon.
 */
export function generateInterceptorScript(socketPath: string = SOCKET_PATH): string {
  const lines: string[] = [
    MARKER_START,
    '',
    '# Add yespapa CLI to PATH',
    'export PATH="$HOME/.yespapa/bin:$PATH"',
    '',
    '# Core intercept function — sends command to daemon via Unix socket',
    'yespapa_intercept() {',
    '  local full_cmd="$*"',
    `  local response=$(echo "{\\"command\\":\\"$1\\",\\"args\\":[\\"$(echo "\${@:2}" | sed \'s/ /\\",\\"/g\')\\"],\\"fullCommand\\":\\"$full_cmd\\"}" | nc -U ${socketPath} 2>/dev/null)`,
    '  if [ -z "$response" ]; then',
    '    echo "[YesPaPa] Daemon not running. Command blocked for safety." >&2',
    '    return 1',
    '  fi',
    '  local status=$(echo "$response" | grep -o \'"status":"[^"]*"\' | head -1 | cut -d\'"\' -f4)',
    '  if [ "$status" = "approved" ]; then',
    '    return 0',
    '  else',
    '    local message=$(echo "$response" | grep -o \'"message":"[^"]*"\' | head -1 | cut -d\'"\' -f4)',
    '    echo "[YesPaPa] Command denied: ${message:-no reason given}" >&2',
    '    echo "$response" >&2',
    '    return 1',
    '  fi',
    '}',
    '',
  ];

  // Generate wrapper for rm
  lines.push(
    'rm() {',
    '  case "$*" in',
    '    *-rf*|*-r*)',
    '      if yespapa_intercept rm "$@"; then',
    '        command rm "$@"',
    '      fi',
    '      ;;',
    '    *) command rm "$@" ;;',
    '  esac',
    '}',
    '',
  );

  // git wrapper — handles multiple subcommands
  lines.push(
    'git() {',
    '  case "$1" in',
    '    reset)',
    '      if yespapa_intercept git "$@"; then',
    '        command git "$@"',
    '      fi',
    '      ;;',
    '    push)',
    '      case "$*" in',
    '        *-f*|*--force*)',
    '          if yespapa_intercept git "$@"; then',
    '            command git "$@"',
    '          fi',
    '          ;;',
    '        *) command git "$@" ;;',
    '      esac',
    '      ;;',
    '    *) command git "$@" ;;',
    '  esac',
    '}',
    '',
  );

  // chmod wrapper
  lines.push(
    'chmod() {',
    '  case "$*" in',
    '    *777*|*o+w*)',
    '      if yespapa_intercept chmod "$@"; then',
    '        command chmod "$@"',
    '      fi',
    '      ;;',
    '    *) command chmod "$@" ;;',
    '  esac',
    '}',
    '',
  );

  // Simple always-intercept wrappers
  for (const cmd of ['sudo', 'dd', 'mkfs']) {
    lines.push(
      `${cmd}() {`,
      `  if yespapa_intercept ${cmd} "$@"; then`,
      `    command ${cmd} "$@"`,
      '  fi',
      '}',
      '',
    );
  }

  // kill wrapper — only intercept -9
  lines.push(
    'kill() {',
    '  case "$*" in',
    '    *-9*|*-SIGKILL*)',
    '      if yespapa_intercept kill "$@"; then',
    '        command kill "$@"',
    '      fi',
    '      ;;',
    '    *) command kill "$@" ;;',
    '  esac',
    '}',
    '',
  );

  // Daemon auto-start check
  lines.push(
    '# Auto-start daemon if not running',
    'if [ -S "' + socketPath + '" ]; then',
    '  : # Socket exists, daemon likely running',
    'else',
    '  # Try to start daemon in background',
    '  if command -v yespapa >/dev/null 2>&1; then',
    '    yespapa start --background 2>/dev/null || true',
    '  fi',
    'fi',
    '',
    MARKER_END,
  );

  return lines.join('\n');
}

/**
 * Get the paths to the user's shell profiles.
 */
export function getShellProfiles(): string[] {
  const home = homedir();
  const profiles: string[] = [];

  const candidates = ['.bashrc', '.zshrc', '.bash_profile'];
  for (const name of candidates) {
    const path = join(home, name);
    if (existsSync(path)) {
      profiles.push(path);
    }
  }

  // If none exist, default to .zshrc on macOS, .bashrc on Linux
  if (profiles.length === 0) {
    const shell = process.env.SHELL ?? '';
    if (shell.includes('zsh')) {
      profiles.push(join(home, '.zshrc'));
    } else {
      profiles.push(join(home, '.bashrc'));
    }
  }

  return profiles;
}

/**
 * Inject the interceptor script into shell profiles.
 */
export function injectInterceptor(socketPath: string = SOCKET_PATH): string[] {
  const script = generateInterceptorScript(socketPath);
  const profiles = getShellProfiles();
  const injected: string[] = [];

  for (const profile of profiles) {
    let content = '';
    if (existsSync(profile)) {
      content = readFileSync(profile, 'utf-8');
    }

    if (content.includes(MARKER_START)) {
      // Already injected — replace existing block
      const regex = new RegExp(
        escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END),
      );
      content = content.replace(regex, script);
    } else {
      // Append
      content = content.trimEnd() + '\n\n' + script + '\n';
    }

    writeFileSync(profile, content);
    injected.push(profile);
  }

  return injected;
}

/**
 * Remove the interceptor script from shell profiles.
 */
export function removeInterceptor(): string[] {
  const profiles = getShellProfiles();
  const removed: string[] = [];

  for (const profile of profiles) {
    if (!existsSync(profile)) continue;

    let content = readFileSync(profile, 'utf-8');
    if (content.includes(MARKER_START)) {
      const regex = new RegExp(
        '\\n*' + escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END) + '\\n*',
      );
      content = content.replace(regex, '\n');
      writeFileSync(profile, content);
      removed.push(profile);
    }
  }

  return removed;
}

/**
 * Check if the interceptor is installed in all shell profiles.
 */
export function isInterceptorInstalled(): boolean {
  const profiles = getShellProfiles();
  for (const profile of profiles) {
    if (!existsSync(profile)) return false;
    const content = readFileSync(profile, 'utf-8');
    if (!content.includes(MARKER_START)) return false;
  }
  return true;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
