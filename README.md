# YesPaPa

**TOTP-authenticated command gateway for AI agents and dangerous shell commands.**

YesPaPa intercepts destructive shell commands (`rm -rf`, `git push --force`, `chmod 777`, etc.) and requires human approval via TOTP code before they execute. It prevents LLM agents, scripts, or accidental keystrokes from causing damage without your consent.

## How It Works

```
$ rm -rf ./dist

  YesPaPa — Command requires approval
  rm -rf ./dist
  Rule: destructive/rm-rf

Enter TOTP code: 482901
Approved
```

Shell aliases route dangerous commands through a local daemon. The daemon checks each command against configurable rules and requires a 6-digit TOTP code (from any authenticator app) before allowing execution.

## Two Rings of Protection

| | Inner Ring | Outer Ring |
|---|---|---|
| **What** | TOTP gate | Mobile app |
| **How** | Type 6-digit code from authenticator | Tap "Approve" on your phone |
| **Requires** | Nothing — fully offline | Remote server (free hosted or self-host) |
| **Speed** | ~5 seconds | ~2 seconds (push notification) |

The Inner Ring works with zero infrastructure. The Outer Ring adds push notifications and one-tap approvals via the YesPaPa mobile app.

## Install

### npm (recommended)

```bash
npm install -g yespapa
yespapa init
```

Or run without installing:

```bash
npx yespapa init
```

### Homebrew (macOS)

```bash
brew tap yespapa/yespapa
brew install yespapa
yespapa init
```

### Debian/Ubuntu

Download the `.deb` from [GitHub Releases](https://github.com/yespapa-cli/yespapa/releases):

```bash
sudo dpkg -i yespapa_0.1.0-1_amd64.deb
yespapa init
```

### From source

```bash
git clone https://github.com/yespapa-cli/yespapa.git
cd yespapa
npm install && npm run build
npx yespapa init
```

## Features

- **Zero infrastructure** — works fully offline with any TOTP app (Google Authenticator, Authy, 1Password)
- **10 built-in deny rules** — `rm -rf`, `git push --force`, `chmod 777`, `mkfs`, `dd`, and more
- **Customizable rules** — add your own deny/allow patterns
- **Grace periods** — auto-approve trusted commands for a configurable window
- **Agent-safe** — structured JSON output for LLM agents, justification support
- **Mobile app** (optional) — push notifications and one-tap approve/deny via YesPaPa app
- **Tamper-resistant** — heartbeat re-injects interceptors if removed, uninstall requires TOTP
- **Self-hostable** — run your own remote server via Docker, or use the free hosted default

## CLI

```bash
yespapa init                    # Initialize on this machine
yespapa status                  # Show daemon & interceptor status
yespapa rules list              # Show interception rules
yespapa rules add --pattern "docker rm *" --type deny
yespapa bypass activate --scope destructive --duration 1h
yespapa config list             # Show all config with defaults
yespapa config set allow_sudo_bypass false
yespapa exec -- rm -rf ./dist   # Programmatic execution (off by default)
yespapa approve cmd_abc123      # Approve from another terminal
yespapa test                    # Test mobile app connectivity
yespapa uninstall               # Remove (requires TOTP)
```

## For AI Agent Developers

YesPaPa is designed to work with LLM agents that execute shell commands. Agents can:

```bash
# Pass justification with intercepted commands
rm -rf ./dist --justification "clearing build artifacts before rebuild"

# Or use the CLI directly for structured output
yespapa exec --justification "clearing old build" -- rm -rf ./dist
```

JSON events are emitted on stderr for all intercepted commands:

```json
{"event":"approved","command":"rm -rf ./dist","source":"remote","message":"ok, go ahead"}
```

## Security Model

| Threat | Mitigation |
|--------|------------|
| Agent removes interceptors | Heartbeat re-injects every 30s |
| Agent uninstalls YesPaPa | Uninstall requires TOTP or master key |
| Compromised remote server | TOTP validated locally — server cannot forge approvals |
| Forged grace token | HMAC-signed with TOTP seed (never leaves machine) |
| TOTP brute force | 3 attempts per command, then 30s cooldown |
| Agent reads TOTP seed | Encrypted with AES-256-GCM, key derived from master password via Argon2 |

## Requirements

- Node.js >= 18
- macOS or Linux
- bash or zsh

## Documentation

- [Docs](https://docs.yespapa.io) — full documentation
- [YesPaPa App](https://get.yespapa.app) — download the mobile app
- [GitHub](https://github.com/yespapa-cli/yespapa) — source code & issues

## License

MIT
