import { describe, it, expect } from 'vitest';
import { generateInterceptorScript } from '../shell/interceptor.js';

describe('shell interceptor generation', () => {
  const script = generateInterceptorScript('/tmp/yespapa-test.sock');

  it('starts with a shebang', () => {
    expect(script).toMatch(/^#!\/bin\/sh/);
  });

  it('contains the core intercept function', () => {
    expect(script).toContain('yespapa_intercept()');
  });

  it('contains the send helper', () => {
    expect(script).toContain('yespapa_send()');
  });

  it('contains the json field helper', () => {
    expect(script).toContain('yespapa_json_field()');
  });

  it('wraps rm with argument checking', () => {
    expect(script).toContain('rm()');
    expect(script).toContain('*-rf*|*-r*');
    expect(script).toContain('command rm "$@"');
  });

  it('wraps git with subcommand checking', () => {
    expect(script).toContain('git()');
    expect(script).toContain('reset)');
    expect(script).toContain('push)');
  });

  it('wraps sudo unconditionally', () => {
    expect(script).toContain('sudo()');
  });

  it('handles TOTP prompt in phase 2', () => {
    expect(script).toContain('needs_totp');
    expect(script).toContain('Enter TOTP code');
    expect(script).toContain('read -r totp_code');
  });

  it('uses the provided socket path', () => {
    expect(script).toContain('/tmp/yespapa-test.sock');
  });

  it('adds yespapa bin to PATH', () => {
    expect(script).toContain('$HOME/.yespapa/bin');
  });

  it('is valid bash syntax', async () => {
    const { execSync } = await import('node:child_process');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const tmpFile = '/tmp/yespapa-interceptor-test.sh';
    writeFileSync(tmpFile, script);
    try {
      execSync(`bash -n ${tmpFile}`);
    } finally {
      unlinkSync(tmpFile);
    }
    expect(true).toBe(true);
  });
});
