import { describe, it, expect } from 'vitest';
import { generateInterceptorScript, WRAPPER_COMMANDS, extractCommandNames } from '../shell/interceptor.js';

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
    expect(script).toContain('read -r -t 1 totp_code');
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

describe('WRAPPER_COMMANDS', () => {
  it('includes all intercepted commands', () => {
    expect(WRAPPER_COMMANDS).toContain('rm');
    expect(WRAPPER_COMMANDS).toContain('git');
    expect(WRAPPER_COMMANDS).toContain('chmod');
    expect(WRAPPER_COMMANDS).toContain('sudo');
    expect(WRAPPER_COMMANDS).toContain('dd');
    expect(WRAPPER_COMMANDS).toContain('mkfs');
    expect(WRAPPER_COMMANDS).toContain('kill');
    expect(WRAPPER_COMMANDS).toContain('rmdir');
  });

  it('does not include yespapa itself', () => {
    expect(WRAPPER_COMMANDS).not.toContain('yespapa');
  });
});

describe('extractCommandNames', () => {
  it('extracts base command from simple patterns', () => {
    expect(extractCommandNames(['docker', 'npm'])).toEqual(['docker', 'npm']);
  });

  it('extracts base command from multi-word patterns', () => {
    expect(extractCommandNames(['docker rm', 'npm publish'])).toEqual(['docker', 'npm']);
  });

  it('deduplicates commands', () => {
    expect(extractCommandNames(['docker rm', 'docker build'])).toEqual(['docker']);
  });

  it('skips patterns that are not valid command names', () => {
    expect(extractCommandNames(['curl | bash', 'wget | sh'])).toEqual(['curl', 'wget']);
  });
});

describe('dynamic extra command wrappers', () => {
  it('generates shell functions for extra commands', () => {
    const script = generateInterceptorScript('/tmp/test.sock', ['docker', 'terraform']);
    expect(script).toContain('docker()');
    expect(script).toContain('terraform()');
    expect(script).toContain('yespapa_intercept docker');
    expect(script).toContain('yespapa_intercept terraform');
  });

  it('does not duplicate built-in wrapper functions', () => {
    const script = generateInterceptorScript('/tmp/test.sock', ['rm', 'docker']);
    // 'rm' should appear as the built-in wrapper, not duplicated
    const rmMatches = script.match(/^rm\(\)/gm);
    expect(rmMatches?.length).toBe(1);
    // 'docker' should appear as an extra wrapper
    expect(script).toContain('docker()');
  });
});
