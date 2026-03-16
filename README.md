# yespapa

**TOTP-authenticated command gateway for AI agents and dangerous shell commands.**

YesPaPa intercepts destructive shell commands (`rm -rf`, `git push --force`, `chmod 777`, etc.) and requires human approval via TOTP code before they execute.

## Install

```bash
npm install -g yespapa
yespapa init
```

Or run without installing:

```bash
npx yespapa init
```

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

## Features

- **Zero infrastructure** — works fully offline with any TOTP app (Google Authenticator, Authy, 1Password)
- **10 built-in deny rules** — `rm -rf`, `git push --force`, `chmod 777`, `mkfs`, `dd`, and more
- **Customizable rules** — add your own deny/allow patterns
- **Grace periods** — auto-approve trusted commands for a configurable window
- **Agent-safe** — structured JSON output for LLM agents, justification support
- **Mobile app** (optional) — push notifications and one-tap approve/deny via YesPaPa app
- **Tamper-resistant** — heartbeat re-injects interceptors if removed, uninstall requires TOTP

## Requirements

- Node.js >= 18
- macOS or Linux
- bash or zsh

## Documentation

Full docs, architecture guide, and self-hosting instructions:
https://docs.yespapa.io
https://get.yespapa.app - download the YesPaPa App
https://github.com/yespapa-cli/yespapa

## License

MIT
