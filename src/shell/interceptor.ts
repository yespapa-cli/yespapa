import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SOCKET_PATH } from '../daemon/socket.js';

const MARKER_START = '# >>> YesPaPa Shell Interceptor (DO NOT EDIT)';
const MARKER_END = '# <<< YesPaPa Shell Interceptor';

/**
 * Generate the shell interceptor script.
 * Two-phase protocol: daemon returns needs_totp, interceptor prompts user, sends TOTP back.
 */
export function generateInterceptorScript(socketPath: string = SOCKET_PATH): string {
  // Using a plain string to avoid all the escaping issues with string arrays
  return `${MARKER_START}

# Add yespapa CLI to PATH
export PATH="$HOME/.yespapa/bin:$PATH"

# Send JSON to daemon and read response
yespapa_send() {
  echo "$1" | nc -U ${socketPath} 2>/dev/null
}

# Extract a JSON string field value
yespapa_json_field() {
  local input="$1" field="$2"
  # Works in both bash and zsh
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get(sys.argv[2],''))" "$input" "$field" 2>/dev/null
  else
    echo "$input" | sed -n 's/.*"'"$field"'":"\\([^"]*\\)".*/\\1/p'
  fi
}

# Core intercept function — two-phase protocol with daemon
yespapa_intercept() {
  local full_cmd="$*"
  local cmd_name="$1"
  shift
  local args_json=""
  local first=1
  for arg in "$@"; do
    if [ $first -eq 1 ]; then first=0; else args_json="$args_json,"; fi
    args_json="$args_json\\"$arg\\""
  done
  local json="{\\"command\\":\\"$cmd_name\\",\\"args\\":[$args_json],\\"fullCommand\\":\\"$full_cmd\\"}"

  # Phase 1: Send command to daemon
  local response
  response=$(yespapa_send "$json")
  if [ -z "$response" ]; then
    echo "[YesPaPa] Daemon not running. Command blocked for safety." >&2
    return 1
  fi

  local yp_status
  yp_status=$(yespapa_json_field "$response" "status")
  if [ "$yp_status" = "approved" ]; then
    return 0
  fi

  if [ "$yp_status" != "needs_totp" ]; then
    local yp_message
    yp_message=$(yespapa_json_field "$response" "message")
    echo "[YesPaPa] Command denied: $yp_message" >&2
    return 1
  fi

  # Phase 2: TOTP prompt in user terminal
  local cmd_id rule
  cmd_id=$(yespapa_json_field "$response" "id")
  rule=$(yespapa_json_field "$response" "rule")
  echo "" >&2
  echo "  [YesPaPa] Command intercepted: $full_cmd" >&2
  if [ -n "$rule" ]; then
    echo "  Rule: $rule" >&2
  fi
  echo "" >&2

  local attempts=0
  while [ $attempts -lt 3 ]; do
    attempts=$((attempts + 1))
    printf "  Enter TOTP code (attempt %d/3): " "$attempts" >&2
    read -r totp_code
    if [ -z "$totp_code" ]; then
      echo "  [YesPaPa] Cancelled" >&2
      return 1
    fi
    local totp_response
    totp_response=$(yespapa_send "{\\"totp\\":\\"$totp_code\\",\\"id\\":\\"$cmd_id\\"}")
    local yp_totp_status
    yp_totp_status=$(yespapa_json_field "$totp_response" "status")
    if [ "$yp_totp_status" = "approved" ]; then
      echo "  [YesPaPa] Approved" >&2
      return 0
    fi
    echo "  [YesPaPa] Invalid code" >&2
  done

  echo "  [YesPaPa] Too many attempts. Command denied." >&2
  return 1
}

rm() {
  case "$*" in
    *-rf*|*-r*)
      if yespapa_intercept rm "$@"; then
        command rm "$@"
      fi
      ;;
    *) command rm "$@" ;;
  esac
}

git() {
  case "$1" in
    reset)
      if yespapa_intercept git "$@"; then
        command git "$@"
      fi
      ;;
    push)
      case "$*" in
        *-f*|*--force*)
          if yespapa_intercept git "$@"; then
            command git "$@"
          fi
          ;;
        *) command git "$@" ;;
      esac
      ;;
    *) command git "$@" ;;
  esac
}

chmod() {
  case "$*" in
    *777*|*o+w*)
      if yespapa_intercept chmod "$@"; then
        command chmod "$@"
      fi
      ;;
    *) command chmod "$@" ;;
  esac
}

sudo() {
  if yespapa_intercept sudo "$@"; then
    command sudo "$@"
  fi
}

dd() {
  if yespapa_intercept dd "$@"; then
    command dd "$@"
  fi
}

mkfs() {
  if yespapa_intercept mkfs "$@"; then
    command mkfs "$@"
  fi
}

kill() {
  case "$*" in
    *-9*|*-SIGKILL*)
      if yespapa_intercept kill "$@"; then
        command kill "$@"
      fi
      ;;
    *) command kill "$@" ;;
  esac
}

# Auto-start daemon if not running
if [ -S "${socketPath}" ]; then
  : # Socket exists, daemon likely running
else
  if command -v yespapa >/dev/null 2>&1; then
    yespapa start --background 2>/dev/null || true
  fi
fi

${MARKER_END}`;
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
      const regex = new RegExp(
        escapeRegex(MARKER_START) + '[\\s\\S]*?' + escapeRegex(MARKER_END),
      );
      content = content.replace(regex, script);
    } else {
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
