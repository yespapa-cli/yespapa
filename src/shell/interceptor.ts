import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { SOCKET_PATH } from '../daemon/socket.js';

const YESPAPA_DIR = join(homedir(), '.yespapa');
const INTERCEPTOR_PATH = join(YESPAPA_DIR, 'interceptor.sh');
const BIN_DIR = join(YESPAPA_DIR, 'bin');
const SOURCE_LINE = '[ -f ~/.yespapa/interceptor.sh ] && source ~/.yespapa/interceptor.sh # YesPaPa';
const BASH_ENV_LINE = 'export BASH_ENV="$HOME/.yespapa/interceptor.sh" # YesPaPa';
const FISH_CONF_DIR_NAME = '.config/fish/conf.d';

/**
 * List of shell functions defined by the interceptor.
 * Used for cleanup during uninstall.
 */
export const INTERCEPTOR_FUNCTIONS = [
  'rm', 'git', 'chmod', 'sudo', 'dd', 'mkfs', 'kill',
  'yespapa_intercept', '_yp_intercept_inner', '_yp_exec', 'yespapa_send', 'yespapa_json_field',
];

/**
 * Commands that get PATH-based binary wrappers in ~/.yespapa/bin/.
 * These wrappers intercept commands in non-interactive shells (scripts, cron, subprocesses).
 * Each entry maps command name -> real binary path (resolved at install time).
 */
export const WRAPPER_COMMANDS = ['rm', 'git', 'chmod', 'sudo', 'dd', 'mkfs', 'kill'];

/**
 * Resolve the absolute path of a real binary, skipping any yespapa wrappers.
 */
function resolveRealBinary(command: string): string | null {
  try {
    // Use 'which -a' to get all matches, skip our own wrapper
    const allPaths = execSync(`which -a ${command} 2>/dev/null`, { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter((p) => p && !p.includes('.yespapa/bin'));
    return allPaths[0] ?? null;
  } catch {
    // Fallback: try common paths
    const commonPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/sbin', '/usr/sbin'];
    for (const dir of commonPaths) {
      const fullPath = join(dir, command);
      if (existsSync(fullPath)) return fullPath;
    }
    return null;
  }
}

/**
 * Generate a PATH-based wrapper script for a single command.
 * The wrapper sends the command to the daemon for rule evaluation.
 * If denied, it prompts for TOTP. If approved (or no rule matches), it runs the real binary.
 */
function generateWrapperScript(command: string, realBinaryPath: string, socketPath: string): string {
  return `#!/bin/sh
# YesPaPa PATH wrapper for "${command}" — DO NOT EDIT
# This file is managed by yespapa. Changes will be overwritten.
# Real binary: ${realBinaryPath}

# Avoid recursive interception if sourced interceptor already handled it
if [ -n "$_YP_INTERCEPTING" ]; then
  exec "${realBinaryPath}" "$@"
fi
export _YP_INTERCEPTING=1

# Build JSON payload
_yp_args_json=""
_yp_first=1
_yp_full="${command}"
for _yp_arg in "$@"; do
  _yp_full="$_yp_full $_yp_arg"
  if [ $_yp_first -eq 1 ]; then _yp_first=0; else _yp_args_json="$_yp_args_json,"; fi
  _yp_args_json="$_yp_args_json\\"$_yp_arg\\""
done

_yp_json="{\\"command\\":\\"${command}\\",\\"args\\":[$_yp_args_json],\\"fullCommand\\":\\"$_yp_full\\"}"

# Send to daemon via Unix socket
_yp_response=""
if command -v nc >/dev/null 2>&1; then
  _yp_response=$(printf '%s\\n' "$_yp_json" | nc -U ${socketPath} 2>/dev/null)
fi

if [ -z "$_yp_response" ]; then
  # Daemon not running — block for safety
  echo "[YesPaPa] Daemon not running. Command blocked for safety." >&2
  unset _YP_INTERCEPTING
  exit 1
fi

# Extract status field
_yp_status=""
if command -v python3 >/dev/null 2>&1; then
  _yp_status=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('status',''))" "$_yp_response" 2>/dev/null)
else
  _yp_status=$(echo "$_yp_response" | sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p')
fi

if [ "$_yp_status" = "approved" ]; then
  unset _YP_INTERCEPTING
  exec "${realBinaryPath}" "$@"
fi

if [ "$_yp_status" = "needs_totp" ]; then
  # In non-interactive mode, check headless_action config
  if [ ! -t 0 ]; then
    _yp_headless="approve"
    if [ -f "$HOME/.yespapa/headless_action" ]; then
      _yp_headless=$(cat "$HOME/.yespapa/headless_action" 2>/dev/null)
    fi
    case "$_yp_headless" in
      block)
        echo "[YesPaPa] Command requires approval but no terminal is available. Blocked." >&2
        echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$_yp_full\\",\\"reason\\":\\"no_terminal\\"}" >&2
        unset _YP_INTERCEPTING
        exit 1
        ;;
      allow)
        echo "[YesPaPa] ✓ Approved (no terminal — headless bypass)" >&2
        unset _YP_INTERCEPTING
        exec "${realBinaryPath}" "$@"
        ;;
      log_only)
        unset _YP_INTERCEPTING
        exec "${realBinaryPath}" "$@"
        ;;
      approve|*)
        # Poll for remote/terminal approval (no TOTP prompt — no TTY)
        _yp_id=""
        _yp_rule=""
        _yp_timeout=""
        if command -v python3 >/dev/null 2>&1; then
          _yp_id=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('id',''))" "$_yp_response" 2>/dev/null)
          _yp_rule=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('rule',''))" "$_yp_response" 2>/dev/null)
          _yp_timeout=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('timeout','120'))" "$_yp_response" 2>/dev/null)
        else
          _yp_id=$(echo "$_yp_response" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
          _yp_rule=$(echo "$_yp_response" | sed -n 's/.*"rule":"\\([^"]*\\)".*/\\1/p')
          _yp_timeout=120
        fi
        _yp_timeout=\${_yp_timeout:-120}
        _yp_max_polls=$_yp_timeout
        if [ "$_yp_timeout" = "0" ]; then
          _yp_max_polls=999999
        fi

        echo "" >&2
        echo "  [YesPaPa] Command requires approval (headless): $_yp_full" >&2
        [ -n "$_yp_rule" ] && echo "  Rule: $_yp_rule" >&2
        echo "  ID: $_yp_id" >&2
        echo "  Approve from another terminal: yespapa approve $_yp_id" >&2
        echo "  Or approve from the YesPaPa mobile app." >&2
        echo "  STATUS: PENDING — waiting for human approval..." >&2
        echo "" >&2

        _yp_poll=0
        while [ $_yp_poll -lt $_yp_max_polls ]; do
          sleep 1
          _yp_poll_resp=""
          if command -v nc >/dev/null 2>&1; then
            _yp_poll_resp=$(printf '%s\\n' "{\\"check\\":\\"$_yp_id\\"}" | nc -U ${socketPath} 2>/dev/null)
          fi
          _yp_poll_status=""
          if [ -n "$_yp_poll_resp" ]; then
            if command -v python3 >/dev/null 2>&1; then
              _yp_poll_status=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('status',''))" "$_yp_poll_resp" 2>/dev/null)
            else
              _yp_poll_status=$(echo "$_yp_poll_resp" | sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p')
            fi
          fi
          if [ "$_yp_poll_status" = "approved" ]; then
            echo "  [YesPaPa] Approved" >&2
            unset _YP_INTERCEPTING
            exec "${realBinaryPath}" "$@"
          elif [ "$_yp_poll_status" = "denied" ]; then
            echo "  [YesPaPa] Denied" >&2
            unset _YP_INTERCEPTING
            exit 1
          fi

          _yp_poll=$((_yp_poll + 1))
          if [ "$_yp_timeout" != "0" ]; then
            _yp_rem=$((_yp_timeout - _yp_poll))
            if [ $((_yp_poll % 15)) -eq 0 ] && [ $_yp_rem -gt 0 ]; then
              echo "  [YesPaPa] Still waiting for approval... (\${_yp_rem}s remaining)" >&2
            fi
          fi
        done

        echo "  [YesPaPa] Timed out waiting for approval (\${_yp_timeout}s)." >&2
        echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$_yp_full\\",\\"reason\\":\\"timeout\\"}" >&2
        unset _YP_INTERCEPTING
        exit 1
        ;;
    esac
  fi

  # Interactive terminal available — prompt for TOTP
  _yp_id=""
  _yp_rule=""
  if command -v python3 >/dev/null 2>&1; then
    _yp_id=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('id',''))" "$_yp_response" 2>/dev/null)
    _yp_rule=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('rule',''))" "$_yp_response" 2>/dev/null)
  else
    _yp_id=$(echo "$_yp_response" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
    _yp_rule=$(echo "$_yp_response" | sed -n 's/.*"rule":"\\([^"]*\\)".*/\\1/p')
  fi

  echo "" >&2
  echo "  [YesPaPa] Waiting for human approval: $_yp_full" >&2
  [ -n "$_yp_rule" ] && echo "  Rule: $_yp_rule" >&2
  echo "  ID: $_yp_id" >&2
  echo "  STATUS: PENDING — the human owner has been notified." >&2
  echo "  This process will block until approved (exit 0) or denied (exit 1)." >&2
  echo "  >>> DO NOT close, retry, or work around. Wait for the result. <<<" >&2
  echo "" >&2

  _yp_attempts=0
  while [ $_yp_attempts -lt 3 ]; do
    printf "  Waiting for human approval... | Enter TOTP code or master key: " >&2
    read -r _yp_code
    if [ -n "$_yp_code" ]; then
      _yp_attempts=$((_yp_attempts + 1))
      _yp_totp_json="{\\"totp\\":\\"$_yp_code\\",\\"id\\":\\"$_yp_id\\"}"
      _yp_totp_resp=$(printf '%s\\n' "$_yp_totp_json" | nc -U ${socketPath} 2>/dev/null)
      _yp_totp_status=""
      if command -v python3 >/dev/null 2>&1; then
        _yp_totp_status=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('status',''))" "$_yp_totp_resp" 2>/dev/null)
      else
        _yp_totp_status=$(echo "$_yp_totp_resp" | sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p')
      fi
      if [ "$_yp_totp_status" = "approved" ]; then
        echo "  [YesPaPa] Approved" >&2
        unset _YP_INTERCEPTING
        exec "${realBinaryPath}" "$@"
      fi
      echo "  Invalid code (attempt $_yp_attempts/3)." >&2
    fi
  done
  echo "  [YesPaPa] Too many attempts. Command denied." >&2
  unset _YP_INTERCEPTING
  exit 1
fi

# Any other status (denied, error)
_yp_message=""
if command -v python3 >/dev/null 2>&1; then
  _yp_message=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(d.get('message',''))" "$_yp_response" 2>/dev/null)
fi
echo "[YesPaPa] Command denied: $_yp_message" >&2
unset _YP_INTERCEPTING
exit 1
`;
}

/**
 * Install PATH-based binary wrappers into ~/.yespapa/bin/.
 * These shadow real binaries so non-interactive shells are also intercepted.
 * Returns list of installed wrapper paths.
 */
export function installBinaryWrappers(socketPath: string = SOCKET_PATH, extraCommands: string[] = []): string[] {
  if (!existsSync(BIN_DIR)) {
    mkdirSync(BIN_DIR, { recursive: true });
  }

  // Combine default wrapper commands with custom rule commands
  const allCommands = [...new Set([...WRAPPER_COMMANDS, ...extraCommands])];

  const installed: string[] = [];
  for (const cmd of allCommands) {
    // Don't overwrite the yespapa CLI wrapper
    if (cmd === 'yespapa') continue;

    const realPath = resolveRealBinary(cmd);
    if (!realPath) continue; // Command not available on this system

    const wrapperPath = join(BIN_DIR, cmd);
    const script = generateWrapperScript(cmd, realPath, socketPath);
    writeFileSync(wrapperPath, script, { mode: 0o755 });
    installed.push(wrapperPath);
  }

  return installed;
}

/**
 * Remove all binary wrappers from ~/.yespapa/bin/ (except the yespapa CLI wrapper).
 */
export function removeBinaryWrappers(): string[] {
  if (!existsSync(BIN_DIR)) return [];

  const removed: string[] = [];
  for (const cmd of WRAPPER_COMMANDS) {
    const wrapperPath = join(BIN_DIR, cmd);
    if (existsSync(wrapperPath)) {
      unlinkSync(wrapperPath);
      removed.push(wrapperPath);
    }
  }
  return removed;
}

/**
 * Generate the shell interceptor script.
 * Two-phase protocol: daemon returns needs_totp, interceptor prompts user, sends TOTP back.
 *
 * @param socketPath - Unix socket path for daemon communication
 * @param extraCommands - Additional command names to wrap (from custom rules in the DB)
 */
export function generateInterceptorScript(socketPath: string = SOCKET_PATH, extraCommands: string[] = []): string {
  // Generate dynamic shell functions for custom rule commands
  const extraFunctions = extraCommands
    .filter((cmd) => !['rm', 'git', 'chmod', 'sudo', 'dd', 'mkfs', 'kill'].includes(cmd))
    .map((cmd) => `
${cmd}() {
  if yespapa_intercept ${cmd} "$@"; then
    _yp_exec ${cmd} "$@"
  fi
}`)
    .join('\n');

  return `#!/bin/sh
# YesPaPa Shell Interceptor — DO NOT EDIT
# This file is managed by yespapa. Changes will be overwritten.

# Add yespapa CLI to PATH
export PATH="$HOME/.yespapa/bin:$PATH"

# Send JSON to daemon and read response
# zsocket (zsh) properly blocks until the response arrives, handling both
# sync (TOTP) and async (argon2 password) validation with zero overhead.
# Falls back to nc for bash (master key bypass unavailable in bash).
if zmodload zsh/net/socket 2>/dev/null; then
  yespapa_send() {
    local _yp_fd _yp_line
    zsocket ${socketPath} 2>/dev/null || return 1
    _yp_fd=$REPLY
    print -u $_yp_fd "$1"
    read -r _yp_line <&$_yp_fd || true
    exec {_yp_fd}>&-
    printf '%s' "$_yp_line"
  }
else
  yespapa_send() {
    printf '%s\\n' "$1" | nc -U ${socketPath} 2>/dev/null
  }
fi

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

# Core intercept function — wraps inner to suppress all trace noise
yespapa_intercept() {
  local _yp_save_opts=""
  case "$-" in *x*) _yp_save_opts="\${_yp_save_opts}x";; esac
  case "$-" in *v*) _yp_save_opts="\${_yp_save_opts}v";; esac
  [ -n "$_yp_save_opts" ] && set +$_yp_save_opts
  # fd 9 = real stderr (intentional output); fd 2 = /dev/null (silences all trace noise)
  { _yp_intercept_inner "$@"; } 9>&2 2>/dev/null
  local _yp_rc=$?
  [ -n "$_yp_save_opts" ] && set -$_yp_save_opts
  return $_yp_rc
}

_yp_intercept_inner() {
  # NOTE: fd 2 is /dev/null here (set by yespapa_intercept wrapper).
  # All intentional output uses >&9 (real stderr, also set by wrapper).
  local full_cmd="$*"
  local cmd_name="$1"
  shift

  # Extract --justification from args (if present)
  local justification=""
  local clean_args=""
  local skip_next=0
  for arg in "$@"; do
    if [ $skip_next -eq 1 ]; then
      justification="$arg"
      skip_next=0
      continue
    fi
    if [ "$arg" = "--justification" ]; then
      skip_next=1
      continue
    fi
    clean_args="$clean_args $arg"
  done
  # Re-set positional params to cleaned args (without --justification)
  eval set -- $clean_args

  local args_json=""
  local first=1
  for arg in "$@"; do
    if [ $first -eq 1 ]; then first=0; else args_json="$args_json,"; fi
    args_json="$args_json\\"$arg\\""
  done
  local json="{\\"command\\":\\"$cmd_name\\",\\"args\\":[$args_json],\\"fullCommand\\":\\"$full_cmd\\""
  if [ -n "$justification" ]; then
    json="$json,\\"justification\\":\\"$justification\\""
  fi
  json="$json}"

  # Phase 1: Send command to daemon
  local response
  response=$(yespapa_send "$json")
  if [ -z "$response" ]; then
    echo "[YesPaPa] Daemon not running. Command blocked for safety." >&9
    echo "{\\"event\\":\\"error\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"daemon_not_running\\"}" >&9
    return 1
  fi

  local yp_status yp_message
  yp_status=$(yespapa_json_field "$response" "status")
  yp_message=$(yespapa_json_field "$response" "message")

  if [ "$yp_status" = "approved" ]; then
    if [ -n "$yp_message" ]; then
      echo "[YesPaPa] $yp_message" >&9
    fi
    return 0
  fi

  if [ "$yp_status" != "needs_totp" ]; then
    echo "[YesPaPa] Command denied: $yp_message" >&9
    echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"$yp_message\\"}" >&9
    return 1
  fi

  # Check if we have a terminal — if not, apply headless_action policy
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    local _yp_headless="approve"
    if [ -f "$HOME/.yespapa/headless_action" ]; then
      _yp_headless=$(cat "$HOME/.yespapa/headless_action" 2>/dev/null)
    fi
    case "$_yp_headless" in
      block)
        echo "[YesPaPa] Command requires approval but no terminal is available. Blocked." >&9
        echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"no_terminal\\"}" >&9
        return 1
        ;;
      allow)
        echo "[YesPaPa] ✓ Approved (no terminal — headless bypass)" >&9
        return 0
        ;;
      log_only)
        return 0
        ;;
      approve|*)
        # Poll for remote/terminal approval (no TOTP prompt — no TTY available)
        local _yp_hcmd_id _yp_hrule _yp_htimeout
        _yp_hcmd_id=$(yespapa_json_field "$response" "id")
        _yp_hrule=$(yespapa_json_field "$response" "rule")
        _yp_htimeout=$(yespapa_json_field "$response" "timeout")
        _yp_htimeout=\${_yp_htimeout:-120}
        local _yp_hmax_polls=$_yp_htimeout
        if [ "$_yp_htimeout" = "0" ]; then
          _yp_hmax_polls=999999
        fi

        echo "" >&9
        echo "  ┌─────────────────────────────────────────────────────────────────┐" >&9
        echo "  │  YesPaPa — Waiting for Human Approval (headless)               │" >&9
        echo "  ├─────────────────────────────────────────────────────────────────┤" >&9
        echo "  │  Command: $full_cmd" >&9
        if [ -n "$_yp_hrule" ]; then
          echo "  │  Rule:    $_yp_hrule" >&9
        fi
        echo "  │  ID:      $_yp_hcmd_id" >&9
        echo "  ├─────────────────────────────────────────────────────────────────┤" >&9
        echo "  │  STATUS: PENDING — the human owner has been notified.          │" >&9
        echo "  │                                                                │" >&9
        echo "  │  Approve from another terminal:                                │" >&9
        echo "  │    yespapa approve $_yp_hcmd_id" >&9
        echo "  │                                                                │" >&9
        echo "  │  Or approve from the YesPaPa mobile app.                      │" >&9
        echo "  │                                                                │" >&9
        echo "  │  >>> DO NOT close this process, retry, or work around it. <<<  │" >&9
        echo "  └─────────────────────────────────────────────────────────────────┘" >&9
        echo "" >&9

        local _yp_hpoll=0
        while [ $_yp_hpoll -lt $_yp_hmax_polls ]; do
          sleep 1
          local _yp_hresp _yp_hstatus _yp_hmsg
          _yp_hresp=$(yespapa_send "{\\"check\\":\\"$_yp_hcmd_id\\"}")
          _yp_hstatus=$(yespapa_json_field "$_yp_hresp" "status")
          if [ "$_yp_hstatus" = "approved" ]; then
            _yp_hmsg=$(yespapa_json_field "$_yp_hresp" "message")
            echo "  [YesPaPa] Approved\${_yp_hmsg:+: $_yp_hmsg}" >&9
            echo "{\\"event\\":\\"approved\\",\\"command\\":\\"$full_cmd\\",\\"source\\":\\"remote\\",\\"id\\":\\"$_yp_hcmd_id\\"}" >&9
            return 0
          elif [ "$_yp_hstatus" = "denied" ]; then
            _yp_hmsg=$(yespapa_json_field "$_yp_hresp" "message")
            echo "  [YesPaPa] Denied\${_yp_hmsg:+: $_yp_hmsg}" >&9
            echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"source\\":\\"remote\\",\\"id\\":\\"$_yp_hcmd_id\\"}" >&9
            return 1
          fi

          _yp_hpoll=$((_yp_hpoll + 1))
          if [ "$_yp_htimeout" != "0" ]; then
            local _yp_hrem=$((_yp_htimeout - _yp_hpoll))
            if [ $((_yp_hpoll % 15)) -eq 0 ] && [ $_yp_hrem -gt 0 ]; then
              echo "  [YesPaPa] Still waiting for approval... (\${_yp_hrem}s remaining)" >&9
            fi
          fi
        done

        echo "  [YesPaPa] Timed out waiting for approval (\${_yp_htimeout}s)." >&9
        echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"timeout\\",\\"hint\\":\\"The human did not respond in time. Ask the user to approve faster or increase the timeout.\\",\\"id\\":\\"$_yp_hcmd_id\\"}" >&9
        return 1
        ;;
    esac
  fi

  # Phase 2: TOTP prompt with agent-friendly output
  local cmd_id rule
  cmd_id=$(yespapa_json_field "$response" "id")
  rule=$(yespapa_json_field "$response" "rule")
  echo "" >&9
  echo "  ┌─────────────────────────────────────────────────────────────────┐" >&9
  echo "  │  YesPaPa — Waiting for Human Approval                          │" >&9
  echo "  ├─────────────────────────────────────────────────────────────────┤" >&9
  echo "  │  Command: $full_cmd" >&9
  if [ -n "$rule" ]; then
    echo "  │  Rule:    $rule" >&9
  fi
  echo "  │  ID:      $cmd_id" >&9
  echo "  ├─────────────────────────────────────────────────────────────────┤" >&9
  echo "  │  STATUS: PENDING — the human owner has been notified.          │" >&9
  echo "  │                                                                │" >&9
  echo "  │  This process will block until the human approves or denies.   │" >&9
  echo "  │  • If approved → this command exits 0 and the command runs.    │" >&9
  echo "  │  • If denied/timeout → this command exits 1.                   │" >&9
  echo "  │                                                                │" >&9
  echo "  │  >>> DO NOT close this process, retry, or work around it. <<<  │" >&9
  echo "  │  >>> The human is reviewing. Just wait for the result.    <<<  │" >&9
  echo "  │                                                                │" >&9
  echo "  │  Tip: use --justification \\"reason\\" to help the approver.       │" >&9
  echo "  └─────────────────────────────────────────────────────────────────┘" >&9
  echo "" >&9

  local attempts=0
  local yp_timeout
  yp_timeout=$(yespapa_json_field "$response" "timeout")
  yp_timeout=\${yp_timeout:-120}
  local max_polls=$yp_timeout  # 1 poll per second
  if [ "$yp_timeout" = "0" ]; then
    max_polls=999999  # 0 = wait forever
  fi
  local poll_count=0
  local remaining
  local poll_resp poll_status poll_msg totp_code totp_response yp_totp_status

  if [ "$yp_timeout" != "0" ]; then
    printf "  Waiting for human approval... (%ds remaining) | Enter TOTP code or master key: " "$yp_timeout" >&9
  else
    printf "  Waiting for human approval... | Enter TOTP code or master key: " >&9
  fi

  while [ $poll_count -lt $max_polls ]; do
    # Poll for remote resolution
    poll_resp=$(yespapa_send "{\\"check\\":\\"$cmd_id\\"}")
    poll_status=$(yespapa_json_field "$poll_resp" "status")
    if [ "$poll_status" = "approved" ]; then
      poll_msg=$(yespapa_json_field "$poll_resp" "message")
      echo "" >&9
      echo "  [YesPaPa] Approved remotely\${poll_msg:+: \$poll_msg}" >&9
      echo "{\\"event\\":\\"approved\\",\\"command\\":\\"$full_cmd\\",\\"source\\":\\"remote\\",\\"id\\":\\"$cmd_id\\"}" >&9
      return 0
    elif [ "$poll_status" = "denied" ]; then
      poll_msg=$(yespapa_json_field "$poll_resp" "message")
      echo "" >&9
      echo "  [YesPaPa] Denied remotely\${poll_msg:+: \$poll_msg}" >&9
      echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"source\\":\\"remote\\",\\"action\\":\\"wait_and_retry_later\\",\\"id\\":\\"$cmd_id\\"}" >&9
      return 1
    fi

    # Try reading TOTP input with 1-second timeout
    totp_code=""
    read -r -t 1 totp_code || true
    if [ -n "$totp_code" ]; then
      attempts=$((attempts + 1))
      totp_response=$(yespapa_send "{\\"totp\\":\\"$totp_code\\",\\"id\\":\\"$cmd_id\\"}")
      yp_totp_status=$(yespapa_json_field "$totp_response" "status")
      if [ "$yp_totp_status" = "approved" ]; then
        echo "" >&9
        echo "  [YesPaPa] Approved" >&9
        echo "{\\"event\\":\\"approved\\",\\"command\\":\\"$full_cmd\\",\\"source\\":\\"totp_stdin\\",\\"id\\":\\"$cmd_id\\"}" >&9
        return 0
      fi
      if [ $attempts -ge 3 ]; then
        echo "" >&9
        echo "  [YesPaPa] Too many attempts. Command denied." >&9
        echo "  Tip: retry with --justification \\"reason\\" to help the approver." >&9
        echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"max_attempts\\",\\"hint\\":\\"Retry with --justification to help the approver\\",\\"id\\":\\"$cmd_id\\"}" >&9
        return 1
      fi
      echo "  Invalid code or master key (attempt $attempts/3). Try again: " >&9
    fi

    poll_count=$((poll_count + 1))

    # Show countdown every 15 seconds (avoid spamming)
    if [ "$yp_timeout" != "0" ]; then
      remaining=$((yp_timeout - poll_count))
      if [ $((poll_count % 15)) -eq 0 ] && [ $remaining -gt 0 ]; then
        printf "\\r  Waiting for human approval... (%ds remaining) | Enter TOTP code or master key: " "$remaining" >&9
      fi
    fi
  done

  echo "" >&9
  echo "  [YesPaPa] Timed out waiting for approval (\${yp_timeout}s)." >&9
  echo "  Tip: retry with --justification \\"reason\\" to help the approver." >&9
  echo "{\\"event\\":\\"denied\\",\\"command\\":\\"$full_cmd\\",\\"reason\\":\\"timeout\\",\\"hint\\":\\"The human did not respond in time. Ask the user to approve faster or increase the timeout.\\",\\"id\\":\\"$cmd_id\\"}" >&9
  return 1
}

# Execute command after stripping --justification from args
_yp_exec() {
  local _cmd="$1"; shift
  local _skip=0 _args=""
  for _a in "$@"; do
    if [ $_skip -eq 1 ]; then _skip=0; continue; fi
    if [ "$_a" = "--justification" ]; then _skip=1; continue; fi
    _args="$_args \\"$_a\\""
  done
  export _YP_INTERCEPTING=1
  eval command "$_cmd" $_args
  local _rc=$?
  unset _YP_INTERCEPTING
  return $_rc
}

rm() {
  case "$*" in
    *-rf*|*-r*)
      if yespapa_intercept rm "$@"; then
        _yp_exec rm "$@"
      fi
      ;;
    *) _YP_INTERCEPTING=1 command rm "$@" ;;
  esac
}

git() {
  case "$1" in
    reset)
      case "$*" in
        *--hard*)
          if yespapa_intercept git "$@"; then
            _yp_exec git "$@"
          fi
          ;;
        *) _YP_INTERCEPTING=1 command git "$@" ;;
      esac
      ;;
    push)
      case "$*" in
        *-f*|*--force*)
          if yespapa_intercept git "$@"; then
            _yp_exec git "$@"
          fi
          ;;
        *) _YP_INTERCEPTING=1 command git "$@" ;;
      esac
      ;;
    *) _YP_INTERCEPTING=1 command git "$@" ;;
  esac
}

chmod() {
  case "$*" in
    *777*|*o+w*)
      if yespapa_intercept chmod "$@"; then
        _yp_exec chmod "$@"
      fi
      ;;
    *) _YP_INTERCEPTING=1 command chmod "$@" ;;
  esac
}

sudo() {
  if yespapa_intercept sudo "$@"; then
    _yp_exec sudo "$@"
  fi
}

dd() {
  if yespapa_intercept dd "$@"; then
    _yp_exec dd "$@"
  fi
}

mkfs() {
  if yespapa_intercept mkfs "$@"; then
    _yp_exec mkfs "$@"
  fi
}

kill() {
  case "$*" in
    *-9*|*-SIGKILL*)
      if yespapa_intercept kill "$@"; then
        _yp_exec kill "$@"
      fi
      ;;
    *) _YP_INTERCEPTING=1 command kill "$@" ;;
  esac
}

${extraFunctions}
# Auto-start daemon if not running
if [ -S "${socketPath}" ]; then
  : # Socket exists, daemon likely running
else
  if command -v yespapa >/dev/null 2>&1; then
    yespapa start --background 2>/dev/null || true
  fi
fi`;
}

/**
 * Resolve the real user's home directory, even under sudo.
 */
function resolveHome(): string {
  const sudoUser = process.env['SUDO_USER'];
  if (process.getuid?.() === 0 && sudoUser) {
    return join(process.platform === 'darwin' ? '/Users' : '/home', sudoUser);
  }
  return homedir();
}

/**
 * Get the paths to the user's shell profiles.
 * Includes "all instances" profiles (.zshenv, .bash_profile) for non-interactive coverage.
 */
export function getShellProfiles(): string[] {
  const home = resolveHome();
  const shell = process.env.SHELL ?? '';
  const profiles: string[] = [];

  // Interactive-only profiles
  const candidates = ['.bashrc', '.zshrc', '.bash_profile', '.zshenv', '.zprofile', '.profile'];
  for (const name of candidates) {
    const path = join(home, name);
    if (existsSync(path)) {
      profiles.push(path);
    }
  }

  // Ensure "all instances" profiles are always included for the user's shell
  if (shell.includes('zsh')) {
    const zshenv = join(home, '.zshenv');
    if (!profiles.includes(zshenv)) {
      profiles.push(zshenv); // Will be created by injectInterceptor
    }
  }

  if (shell.includes('bash')) {
    // .bash_profile is needed for BASH_ENV export
    const bashProfile = join(home, '.bash_profile');
    if (!profiles.includes(bashProfile)) {
      profiles.push(bashProfile);
    }
  }

  if (profiles.length === 0) {
    if (shell.includes('zsh')) {
      profiles.push(join(home, '.zshrc'));
      profiles.push(join(home, '.zshenv'));
    } else {
      profiles.push(join(home, '.bashrc'));
      profiles.push(join(home, '.bash_profile'));
    }
  }

  return profiles;
}

/**
 * Get the path to the fish conf.d interceptor, if fish is installed.
 */
function getFishConfPath(): string | null {
  const home = resolveHome();
  const fishConfDir = join(home, FISH_CONF_DIR_NAME);
  // Only target fish if conf.d exists (user has fish installed)
  if (existsSync(fishConfDir)) {
    return join(fishConfDir, 'yespapa.fish');
  }
  return null;
}

/**
 * Generate a fish-compatible interceptor script.
 */
function generateFishInterceptorScript(_socketPath: string): string {
  return `# YesPaPa Shell Interceptor for fish — DO NOT EDIT
# This file is managed by yespapa. Changes will be overwritten.

# Add yespapa CLI to PATH
set -gx PATH "$HOME/.yespapa/bin" $PATH
`;
}

/**
 * Write the interceptor script to ~/.yespapa/interceptor.sh
 * and add a single source line to shell profiles.
 */
export function injectInterceptor(socketPath: string = SOCKET_PATH, extraCommands: string[] = []): string[] {
  const script = generateInterceptorScript(socketPath, extraCommands);

  // Ensure ~/.yespapa/ exists
  if (!existsSync(YESPAPA_DIR)) {
    mkdirSync(YESPAPA_DIR, { recursive: true });
  }

  // Write the interceptor script to ~/.yespapa/interceptor.sh
  writeFileSync(INTERCEPTOR_PATH, script, { mode: 0o755 });

  // Add source line to shell profiles
  const profiles = getShellProfiles();
  const injected: string[] = [];

  for (const profile of profiles) {
    let content = '';
    if (existsSync(profile)) {
      content = readFileSync(profile, 'utf-8');
    }

    // Check if the line is present and active (not commented out)
    const lines = content.split('\n');
    const hasActiveLine = lines.some((line) => line.trim() === SOURCE_LINE);
    if (hasActiveLine) {
      // Already present and active, just update the script file
      injected.push(profile);
    } else {
      // Uncomment if commented out (e.g., "# [ -f ~/.yespapa/...")
      const commentedIndex = lines.findIndex(
        (line) => line.trim() !== SOURCE_LINE && line.includes(SOURCE_LINE),
      );
      if (commentedIndex !== -1) {
        lines[commentedIndex] = SOURCE_LINE;
        content = lines.join('\n');
        writeFileSync(profile, content);
        injected.push(profile);
      } else {
        // Remove legacy inline block if present (migration from old format)
        const LEGACY_START = '# >>> YesPaPa Shell Interceptor (DO NOT EDIT)';
        const LEGACY_END = '# <<< YesPaPa Shell Interceptor';
        if (content.includes(LEGACY_START)) {
          const regex = new RegExp(
            '\\n*' + escapeRegex(LEGACY_START) + '[\\s\\S]*?' + escapeRegex(LEGACY_END) + '\\n*',
          );
          content = content.replace(regex, '\n');
        }

        content = content.trimEnd() + '\n' + SOURCE_LINE + '\n';
        writeFileSync(profile, content);
        injected.push(profile);
      }
    }

    // For bash profiles (.bash_profile, .profile), also inject BASH_ENV export
    // so non-interactive bash (scripts, subprocesses) also loads the interceptor
    const basename = profile.split('/').pop() ?? '';
    if (['.bash_profile', '.profile'].includes(basename)) {
      const currentContent = readFileSync(profile, 'utf-8');
      if (!currentContent.includes(BASH_ENV_LINE)) {
        writeFileSync(profile, currentContent.trimEnd() + '\n' + BASH_ENV_LINE + '\n');
      }
    }
  }

  // Fish shell support: write interceptor to conf.d if fish is installed
  const fishConfPath = getFishConfPath();
  if (fishConfPath) {
    const fishScript = generateFishInterceptorScript(socketPath);
    writeFileSync(fishConfPath, fishScript, { mode: 0o755 });
    injected.push(fishConfPath);
  }

  // Install PATH-based binary wrappers for non-interactive shell coverage
  installBinaryWrappers(socketPath, extraCommands);

  return injected;
}

/**
 * Remove the source line from shell profiles.
 * Also removes BASH_ENV exports, fish conf.d script, and binary wrappers.
 * The interceptor.sh file in ~/.yespapa/ is left for deletion with the directory.
 */
export function removeInterceptor(): string[] {
  const profiles = getShellProfiles();
  const removed: string[] = [];

  for (const profile of profiles) {
    if (!existsSync(profile)) continue;

    let content = readFileSync(profile, 'utf-8');
    let modified = false;

    // Remove the source line
    if (content.includes(SOURCE_LINE)) {
      content = content
        .split('\n')
        .filter((line) => line !== SOURCE_LINE)
        .join('\n');
      modified = true;
    }

    // Remove BASH_ENV export line
    if (content.includes(BASH_ENV_LINE)) {
      content = content
        .split('\n')
        .filter((line) => line !== BASH_ENV_LINE)
        .join('\n');
      modified = true;
    }

    // Also clean up legacy inline block if present
    const LEGACY_START = '# >>> YesPaPa Shell Interceptor (DO NOT EDIT)';
    const LEGACY_END = '# <<< YesPaPa Shell Interceptor';
    if (content.includes(LEGACY_START)) {
      const regex = new RegExp(
        '\\n*' + escapeRegex(LEGACY_START) + '[\\s\\S]*?' + escapeRegex(LEGACY_END) + '\\n*',
      );
      content = content.replace(regex, '\n');
      modified = true;
    }

    if (modified) {
      writeFileSync(profile, content);
      removed.push(profile);
    }
  }

  // Remove fish conf.d script
  const fishConfPath = getFishConfPath();
  if (fishConfPath && existsSync(fishConfPath)) {
    unlinkSync(fishConfPath);
    removed.push(fishConfPath);
  }

  // Remove binary wrappers
  removeBinaryWrappers();

  return removed;
}

/**
 * Check if the interceptor is installed and active (not commented out) in all shell profiles.
 */
export function isInterceptorInstalled(): boolean {
  // Check that the script file exists
  if (!existsSync(INTERCEPTOR_PATH)) return false;

  // Check that source line is present and uncommented in all shell profiles
  const profiles = getShellProfiles();
  for (const profile of profiles) {
    if (!existsSync(profile)) return false;
    const lines = readFileSync(profile, 'utf-8').split('\n');
    const hasActiveLine = lines.some((line) => line.trim() === SOURCE_LINE);
    if (!hasActiveLine) return false;
  }
  return true;
}

/**
 * Delete the interceptor script file.
 */
export function deleteInterceptorFile(): void {
  if (existsSync(INTERCEPTOR_PATH)) {
    unlinkSync(INTERCEPTOR_PATH);
  }
}

/**
 * Extract unique base command names from rule patterns.
 * E.g., "docker rm" -> "docker", "npm publish" -> "npm", "rm" -> "rm"
 */
export function extractCommandNames(patterns: string[]): string[] {
  const commands = new Set<string>();
  for (const pattern of patterns) {
    const baseCmd = pattern.split(/\s+/)[0];
    if (baseCmd && /^[a-zA-Z0-9._-]+$/.test(baseCmd)) {
      commands.add(baseCmd);
    }
  }
  return [...commands];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
