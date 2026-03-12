import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { promptForApproval, checkGracePeriod } from '../daemon/approval.js';
import { generateSeed, generateCode } from '../totp/index.js';
import { openMemoryDatabase, createGracePeriod } from '../db/index.js';

function createMockInput(lines: string[]): Readable {
  const input = new Readable({ read() {} });
  // Push lines with small delays to simulate user input
  let i = 0;
  const push = () => {
    if (i < lines.length) {
      input.push(lines[i] + '\n');
      i++;
    }
    if (i >= lines.length) {
      // Don't destroy — let the readline close naturally
    }
  };
  // Push all lines immediately
  for (const line of lines) {
    input.push(line + '\n');
  }
  return input;
}

function createMockOutput(): Writable & { getOutput: () => string } {
  let data = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      data += chunk.toString();
      callback();
    },
  });
  (output as Writable & { getOutput: () => string }).getOutput = () => data;
  return output as Writable & { getOutput: () => string };
}

describe('promptForApproval', () => {
  it('approves with valid TOTP code', async () => {
    const seed = generateSeed();
    const code = generateCode(seed);
    const input = createMockInput([code]);
    const output = createMockOutput();

    const result = await promptForApproval(
      'cmd_test', 'rm', ['-rf', './dist'], seed,
      undefined, 0, input, output,
    );

    expect(result.status).toBe('approved');
    expect(result.source).toBe('totp_stdin');
    expect(output.getOutput()).toContain('YesPaPa');
    expect(output.getOutput()).toContain('Approved');
  });

  it('denies after 3 invalid attempts', async () => {
    const seed = generateSeed();
    const input = createMockInput(['000000', '111111', '222222']);
    const output = createMockOutput();

    const result = await promptForApproval(
      'cmd_test', 'rm', ['-rf', './dist'], seed,
      undefined, 0, input, output,
    );

    expect(result.status).toBe('denied');
    expect(result.message).toContain('Too many');
    expect(output.getOutput()).toContain('Invalid code');
  });

  it('accepts on second attempt', async () => {
    const seed = generateSeed();
    const code = generateCode(seed);
    const input = createMockInput(['000000', code]);
    const output = createMockOutput();

    const result = await promptForApproval(
      'cmd_test', 'rm', ['-rf', './dist'], seed,
      undefined, 0, input, output,
    );

    expect(result.status).toBe('approved');
  });

  it('shows justification in interception box', async () => {
    const seed = generateSeed();
    const code = generateCode(seed);
    const input = createMockInput([code]);
    const output = createMockOutput();

    await promptForApproval(
      'cmd_test', 'rm', ['-rf', './dist'], seed,
      'clearing build', 0, input, output,
    );

    expect(output.getOutput()).toContain('clearing build');
  });

  it('times out when configured', async () => {
    const seed = generateSeed();
    // Don't provide any input — should timeout
    const input = new Readable({ read() {} });
    const output = createMockOutput();

    const result = await promptForApproval(
      'cmd_test', 'rm', ['-rf', './dist'], seed,
      undefined, 100, input, output,
    );

    expect(result.status).toBe('timeout');
  });
});

describe('checkGracePeriod', () => {
  it('returns undefined when no grace periods', () => {
    const db = openMemoryDatabase();
    expect(checkGracePeriod(db)).toBeUndefined();
  });

  it('returns active grace period with scope "all"', () => {
    const db = openMemoryDatabase();
    const future = new Date(Date.now() + 3600000).toISOString();
    createGracePeriod(db, 'gp1', 'all', future, 'hmac');
    const gp = checkGracePeriod(db);
    expect(gp).toBeDefined();
    expect(gp?.scope).toBe('all');
  });

  it('returns matching bundle grace period', () => {
    const db = openMemoryDatabase();
    const future = new Date(Date.now() + 3600000).toISOString();
    createGracePeriod(db, 'gp1', 'destructive', future, 'hmac');
    expect(checkGracePeriod(db, 'destructive')).toBeDefined();
    expect(checkGracePeriod(db, 'network')).toBeUndefined();
  });

  it('ignores expired grace periods', () => {
    const db = openMemoryDatabase();
    const past = new Date(Date.now() - 3600000).toISOString();
    createGracePeriod(db, 'gp1', 'all', past, 'hmac');
    expect(checkGracePeriod(db)).toBeUndefined();
  });
});
