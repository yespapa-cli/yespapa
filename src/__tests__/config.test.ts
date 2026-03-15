import { describe, it, expect } from 'vitest';
import { validateConfigValue } from '../cli/config.js';

describe('validateConfigValue', () => {
  describe('default_timeout', () => {
    it('accepts 0', () => {
      expect(validateConfigValue('default_timeout', '0')).toBeNull();
    });

    it('accepts positive integers', () => {
      expect(validateConfigValue('default_timeout', '30')).toBeNull();
      expect(validateConfigValue('default_timeout', '120')).toBeNull();
    });

    it('rejects negative numbers', () => {
      expect(validateConfigValue('default_timeout', '-1')).toContain('Invalid value');
    });

    it('rejects non-integers', () => {
      expect(validateConfigValue('default_timeout', '3.5')).toContain('Invalid value');
      expect(validateConfigValue('default_timeout', 'abc')).toContain('Invalid value');
    });
  });

  describe('boolean config keys', () => {
    const booleanKeys = ['allow_password_bypass', 'allow_sudo_bypass', 'allow_remote_exec'];

    for (const key of booleanKeys) {
      it(`accepts "true" for ${key}`, () => {
        expect(validateConfigValue(key, 'true')).toBeNull();
      });

      it(`accepts "false" for ${key}`, () => {
        expect(validateConfigValue(key, 'false')).toBeNull();
      });

      it(`rejects "yes" for ${key}`, () => {
        const error = validateConfigValue(key, 'yes');
        expect(error).toContain('Invalid value');
        expect(error).toContain('true or false');
      });

      it(`rejects "1" for ${key}`, () => {
        expect(validateConfigValue(key, '1')).toContain('Invalid value');
      });
    }
  });

  describe('unknown keys', () => {
    it('returns null for unknown keys (no validation)', () => {
      expect(validateConfigValue('unknown_key', 'anything')).toBeNull();
    });
  });
});
