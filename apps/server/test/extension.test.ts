import { describe, expect, it } from 'vitest';
import { EXTENSION_PATTERN, extensionProblem, normalizeExtension } from '@telno/shared';

/**
 * The extension rule lives in `@telno/shared` because it is the platform's
 * definition of a line, not the adaptor's. These pin it once where every caller
 * — the lines page, the adaptor sheet, the driver — gets it from.
 */
describe('the extension rule', () => {
  it('accepts the shapes a branch actually uses', () => {
    for (const value of ['55', '201', '123456', 201]) {
      expect(extensionProblem(value)).toBeNull();
      expect(normalizeExtension(value)).toBe(String(value));
    }
  });

  it('trims, so a pasted number with a stray space or newline is still a number', () => {
    expect(normalizeExtension(' 202 ')).toBe('202');
    expect(normalizeExtension('202\n')).toBe('202');
    expect(extensionProblem(' 202 ')).toBeNull();
  });

  it('rejects what the firmware would store and then silently fail to register', () => {
    for (const value of ['20l', '1', '1234567', '+201', '2 0 1', 'sip:201', '-1']) {
      expect(normalizeExtension(value)).toBeNull();
      expect(extensionProblem(value)).toMatch(/2 to 6 digits/);
    }
  });

  it('names the value the operator typed, so the typo is visible in the message', () => {
    expect(extensionProblem('20l')).toContain('"20l"');
  });

  it('asks for a value instead of echoing nothing when the field is empty', () => {
    for (const value of ['', '   ', undefined, null]) {
      expect(extensionProblem(value)).toMatch(/required/);
      expect(normalizeExtension(value)).toBeNull();
    }
  });

  it('is the only place the pattern is written down', () => {
    expect(EXTENSION_PATTERN.test('201')).toBe(true);
    expect(EXTENSION_PATTERN.test('2019x')).toBe(false);
  });
});
