/**
 * ANSI color helpers for CLI output.
 * Respects NO_COLOR environment variable (https://no-color.org).
 */

const enabled = !process.env['NO_COLOR'];

function wrap(code: string, text: string): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const green = (text: string) => wrap('32', text);
export const red = (text: string) => wrap('31', text);
export const yellow = (text: string) => wrap('33', text);
export const cyan = (text: string) => wrap('36', text);
export const bold = (text: string) => wrap('1', text);
export const dim = (text: string) => wrap('2', text);

export const ok = (text: string) => green(`✓ ${text}`);
export const fail = (text: string) => red(`✗ ${text}`);
export const warn = (text: string) => yellow(`! ${text}`);
