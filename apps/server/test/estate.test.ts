import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { lineAssignment } from '../src/estate.js';

/**
 * The adaptor reports a line as registered whether or not the extension is its
 * to use, so this lookup is the only thing that can tell an operator the
 * difference between a working port and one answering someone else's calls.
 * It runs against an in-memory copy of `lines` and `devices` rather than the
 * real database on purpose: the estate's own rules must be testable without
 * reading or writing the deployment's data.
 */
interface Line {
  extension: string;
  /** null means the line exists but has not been given to a device yet. */
  device: string | null;
  slot?: number;
}

function estate(
  devices: Array<{ id: string; label: string; location?: string }>,
  lines: Line[],
): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE lines (
      id TEXT PRIMARY KEY,
      extension TEXT NOT NULL UNIQUE,
      device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      account_slot INTEGER NOT NULL DEFAULT 1
    );
  `);
  const device = db.prepare('INSERT INTO devices (id, label, location) VALUES (?, ?, ?)');
  for (const d of devices) device.run(d.id, d.label, d.location ?? '');
  const line = db.prepare('INSERT INTO lines (id, extension, device_id, account_slot) VALUES (?, ?, ?, ?)');
  for (const l of lines) line.run(`line-${l.extension}`, l.extension, l.device, l.slot ?? 1);
  return db;
}

const reception = { id: 'dev-reception', label: 'Reception phone', location: 'Ground floor' };
const adaptor = { id: 'dev-adaptor', label: 'Lift adaptor' };

describe('the estate lookup behind the adaptor write', () => {
  it('says nothing when the extension is this port’s own line', () => {
    const db = estate([adaptor], [{ extension: '201', device: 'dev-adaptor', slot: 1 }]);
    expect(lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 }).warning).toBeNull();
  });

  it('records who holds the line even when it is fine', () => {
    const db = estate([adaptor], [{ extension: '201', device: 'dev-adaptor', slot: 1 }]);
    expect(lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 }).owner).toEqual({
      deviceId: 'dev-adaptor',
      slot: 1,
    });
  });

  it('names the number when no line in the estate answers to it', () => {
    const db = estate([adaptor], [{ extension: '201', device: 'dev-adaptor' }]);
    const { warning, owner } = lineAssignment(db, { extension: '999', deviceId: 'dev-adaptor', slot: 1 });
    expect(owner).toBeNull();
    expect(warning).toContain('999');
    expect(warning).toMatch(/ring nowhere/);
  });

  it('warns on an empty estate rather than assuming the number is fine', () => {
    const db = estate([], []);
    expect(lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 }).warning).toMatch(
      /No line in this estate/,
    );
  });

  it('matches the whole extension, not a prefix of another one', () => {
    const db = estate([adaptor], [{ extension: '2012', device: 'dev-adaptor' }]);
    expect(lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 }).warning).not.toBeNull();
    expect(lineAssignment(db, { extension: '20', deviceId: 'dev-adaptor', slot: 1 }).warning).not.toBeNull();
  });

  it('binds the value instead of building SQL from it', () => {
    const db = estate([adaptor], [{ extension: '201', device: 'dev-adaptor' }]);
    const { warning } = lineAssignment(db, {
      extension: "201' OR '1'='1",
      deviceId: 'dev-adaptor',
      slot: 1,
    });
    // Interpolated, this would have matched the row and returned null.
    expect(warning).toContain("201' OR '1'='1");
  });

  it('lets a port take a line that is not assigned to any device yet', () => {
    const db = estate([adaptor], [{ extension: '205', device: null }]);
    expect(lineAssignment(db, { extension: '205', deviceId: 'dev-adaptor', slot: 1 }).warning).toBeNull();
  });

  it('warns when the line belongs to another device, and says which', () => {
    const db = estate([reception, adaptor], [{ extension: '201', device: 'dev-reception', slot: 1 }]);
    const { warning, owner } = lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 });
    expect(warning).toContain('Reception phone at Ground floor');
    expect(warning).toMatch(/either handset/);
    expect(owner).toEqual({ deviceId: 'dev-reception', slot: 1 });
  });

  it('does not render a blank device label as "null"', () => {
    const db = estate([{ id: 'dev-x', label: '   ' }], [{ extension: '201', device: 'dev-x' }]);
    const { warning } = lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 1 });
    expect(warning).toContain('another device');
    expect(warning).not.toContain('null');
  });

  it('warns when the line belongs to the other port on this same adaptor', () => {
    const db = estate([adaptor], [{ extension: '201', device: 'dev-adaptor', slot: 1 }]);
    const { warning } = lineAssignment(db, { extension: '201', deviceId: 'dev-adaptor', slot: 2 });
    expect(warning).toContain('port 1');
    expect(warning).toContain('ports 1 and 2');
  });
});
