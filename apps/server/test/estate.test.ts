import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { unknownExtensionWarning } from '../src/estate.js';

/**
 * The adaptor reports a line as registered whether or not anything answers to
 * it, so this lookup is the only thing that can tell an operator the difference.
 * It runs against an in-memory copy of the `lines` table rather than the real
 * database on purpose: the estate's own rules must be testable without reading
 * or writing the deployment's data.
 */
function estate(extensions: string[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE lines (id TEXT PRIMARY KEY, extension TEXT NOT NULL UNIQUE)');
  const insert = db.prepare('INSERT INTO lines (id, extension) VALUES (?, ?)');
  for (const extension of extensions) insert.run(`line-${extension}`, extension);
  return db;
}

describe('the estate lookup behind the adaptor write', () => {
  it('says nothing about an extension a line actually owns', () => {
    expect(unknownExtensionWarning(estate(['201', '202']), '202')).toBeNull();
  });

  it('names the number when no line in the estate answers to it', () => {
    const warning = unknownExtensionWarning(estate(['201', '202']), '999');
    expect(warning).toContain('999');
    expect(warning).toMatch(/ring nowhere/);
  });

  it('warns on an empty estate rather than assuming the number is fine', () => {
    expect(unknownExtensionWarning(estate([]), '201')).toMatch(/No line in this estate/);
  });

  it('matches the whole extension, not a prefix of another one', () => {
    expect(unknownExtensionWarning(estate(['2012']), '201')).not.toBeNull();
    expect(unknownExtensionWarning(estate(['20']), '201')).not.toBeNull();
  });

  it('binds the value instead of building SQL from it', () => {
    const warning = unknownExtensionWarning(estate(['201']), "201' OR '1'='1");
    // Interpolated, this would have matched the row and returned null.
    expect(warning).toContain("201' OR '1'='1");
  });
});
