import { describe, it, expect } from 'vitest';
import { generateInterceptorScript } from '../shell/interceptor.js';

describe('shell interceptor generation', () => {
  const script = generateInterceptorScript('/tmp/yespapa-test.sock');

  it('contains start and end markers', () => {
    expect(script).toContain('# >>> YesPaPa Shell Interceptor');
    expect(script).toContain('# <<< YesPaPa Shell Interceptor');
  });

  it('contains the core intercept function', () => {
    expect(script).toContain('yespapa_intercept()');
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
    expect(script).toContain('*-f*|*--force*');
  });

  it('wraps chmod with pattern checking', () => {
    expect(script).toContain('chmod()');
    expect(script).toContain('*777*|*o+w*');
  });

  it('wraps sudo unconditionally', () => {
    expect(script).toContain('sudo()');
    expect(script).toContain('command sudo "$@"');
  });

  it('wraps dd unconditionally', () => {
    expect(script).toContain('dd()');
  });

  it('wraps mkfs unconditionally', () => {
    expect(script).toContain('mkfs()');
  });

  it('wraps kill with -9 checking', () => {
    expect(script).toContain('kill()');
    expect(script).toContain('*-9*|*-SIGKILL*');
  });

  it('uses the provided socket path', () => {
    expect(script).toContain('/tmp/yespapa-test.sock');
  });

  it('is valid bash syntax', async () => {
    // Write to temp file and check with bash -n
    const { execSync } = await import('node:child_process');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    const tmpFile = '/tmp/yespapa-interceptor-test.sh';
    writeFileSync(tmpFile, script);
    try {
      execSync(`bash -n ${tmpFile}`);
    } finally {
      unlinkSync(tmpFile);
    }
    // If we get here, syntax is valid
    expect(true).toBe(true);
  });
});
