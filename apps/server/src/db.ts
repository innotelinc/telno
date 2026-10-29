import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeviceStatus, ModelKey, RoutingMode } from '@telno/shared';
import { env } from './env.js';

mkdirSync(dirname(env.dbPath), { recursive: true });

export const db = new DatabaseSync(env.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  mac TEXT,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  firmware TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  config_issued_at TEXT,
  applied_version INTEGER,
  token_hash TEXT,
  token_rotated_at TEXT,
  last_seen_at TEXT,
  last_enrolled_at TEXT,
  created_at TEXT NOT NULL,
  /* Where the device enrolled from: the address its own console answers on. */
  addr TEXT
);

CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  extension TEXT NOT NULL UNIQUE,
  aor TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  account_slot INTEGER NOT NULL DEFAULT 1,
  routing_mode TEXT NOT NULL DEFAULT 'business-hours',
  forward_to TEXT,
  bh_start TEXT NOT NULL DEFAULT '09:00',
  bh_end TEXT NOT NULL DEFAULT '17:00',
  bh_days TEXT NOT NULL DEFAULT 'mon,tue,wed,thu,fri',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS directory (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  number TEXT NOT NULL,
  extension TEXT,
  email TEXT,
  company TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollment_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_revisions (
  revision INTEGER PRIMARY KEY,
  document TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Migrations for databases created before these columns existed.
{
  const columns = db.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'config_issued_at')) {
    db.exec('ALTER TABLE devices ADD COLUMN config_issued_at TEXT');
  }
  db.exec('UPDATE devices SET config_issued_at = created_at WHERE config_issued_at IS NULL');
  if (!columns.some((column) => column.name === 'addr')) {
    db.exec('ALTER TABLE devices ADD COLUMN addr TEXT');
  }
}

export const now = (): string => new Date().toISOString();
export const uid = (): string => randomUUID();

/* ------------------------------------------------------------------ settings */

export function getSetting(key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Signing key for device configuration: from env, else generated once and stored. */
export function provisioningKey(): { key: Buffer; keyId: string } {
  if (env.provisioningKey) {
    const raw = Buffer.from(env.provisioningKey, 'utf8');
    return { key: raw, keyId: keyIdFor(raw) };
  }
  let stored = getSetting('provisioning.key', '');
  if (!stored) {
    stored = randomBytes(32).toString('hex');
    setSetting('provisioning.key', stored);
  }
  const key = Buffer.from(stored, 'hex');
  return { key, keyId: keyIdFor(key) };
}

function keyIdFor(key: Buffer): string {
  // Short, stable public identifier so a device can name the key it must use.
  return `tln-k-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

/* ---------------------------------------------------------------------- auth */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, hashHex] = parts;
  try {
    const derived = scryptSync(password, Buffer.from(saltHex!, 'hex'), 64, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    const expected = Buffer.from(hashHex!, 'hex');
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------- event */

export function recordEvent(
  kind: string,
  level: 'info' | 'success' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown> | null = null,
): void {
  db.prepare('INSERT INTO events (kind, level, message, meta, created_at) VALUES (?,?,?,?,?)').run(
    kind,
    level,
    message,
    meta ? JSON.stringify(meta) : null,
    now(),
  );
  // Keep the ledger compact; this is a console, not an audit archive.
  db.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) - 2000 FROM events)');
}

/* --------------------------------------------------------------------- types */

export interface DeviceRow {
  id: string;
  serial: string;
  mac: string | null;
  model: ModelKey;
  label: string;
  location: string;
  status: DeviceStatus;
  firmware: string | null;
  config_version: number;
  config_issued_at: string | null;
  applied_version: number | null;
  token_hash: string | null;
  token_rotated_at: string | null;
  last_seen_at: string | null;
  last_enrolled_at: string | null;
  created_at: string;
  addr: string | null;
}

export interface LineRow {
  id: string;
  extension: string;
  aor: string;
  display_name: string;
  device_id: string | null;
  account_slot: number;
  routing_mode: RoutingMode;
  forward_to: string | null;
  bh_start: string;
  bh_end: string;
  bh_days: string;
  enabled: number;
  created_at: string;
}

/* ---------------------------------------------------------------------- seed */

function seed(): void {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (userCount.c === 0) {
    // No shipped default password: an unset TELNO_ADMIN_PASSWORD produces a
    // random one, printed once, instead of a credential that ends up in a repo.
    const generated = !env.adminPassword;
    const password = env.adminPassword || randomBytes(15).toString('base64url');
    db.prepare(
      'INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)',
    ).run(uid(), env.adminUser, 'Administrator', 'admin', hashPassword(password), now());
    recordEvent(
      'auth',
      'warn',
      `Bootstrap administrator "${env.adminUser}" created` +
        (generated ? ' with a generated password (printed at startup).' : ' from the environment.'),
    );
    if (generated) {
      console.log('──────────────────────────────────────────────────────────────');
      console.log(` First-run administrator: ${env.adminUser}`);
      console.log(` Password:               ${password}`);
      console.log(' Shown once. Change it in Settings → Password.');
      console.log('──────────────────────────────────────────────────────────────');
    }
  }

  const defaults: Record<string, string> = {
    'org.name': 'Telno',
    'org.domain': 'telno.local',
    'org.timezone': 'Europe/London',
    'voice.node': env.voiceNode,
    'voice.port': String(env.voicePort),
    'voice.relay': env.voiceRelay,
    'voice.ntp': 'pool.ntp.org',
    'provisioning.requireSignature': '1',
    'session.hours': '12',
    'security.trustedNetworks': env.trustedNetworks,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (getSetting(key, '\u0000') === '\u0000') setSetting(key, value);
  }

  const seeded = getSetting('seed.demo', '');
  if (seeded) return;
  setSetting('seed.demo', '1');

  const devices: Array<[string, string, ModelKey, string, string, DeviceStatus, number]> = [
    ['T750-2026-000418', 'AA:42:10:7C:11:01', 't750', 'Reception desk', 'HQ — Ground floor', 'online', 3],
    ['T750-2026-000419', 'AA:42:10:7C:11:02', 't750', 'Support pod', 'HQ — First floor', 'online', 2],
    ['HT802-2026-000117', 'AA:42:10:7C:22:01', 'ht802', 'Lab gateway', 'Lab — Rack B', 'offline', 4],
    ['HT802-2026-000118', 'AA:42:10:7C:22:02', 'ht802', 'Spare adapter', 'Stores', 'pending', 1],
  ];
  for (const [serial, mac, model, label, location, status, version] of devices) {
    db.prepare(
      `INSERT INTO devices (id, serial, mac, model, label, location, status, firmware, config_version,
        config_issued_at, applied_version, last_seen_at, last_enrolled_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uid(),
      serial,
      mac,
      model,
      label,
      location,
      status,
      model === 't750' ? '2026.1.4' : '2026.1.2',
      version,
      new Date(Date.now() - 3600_000).toISOString(),
      status === 'pending' ? null : version,
      status === 'online' ? new Date(Date.now() - 42_000).toISOString() : null,
      new Date(Date.now() - 864_000_00).toISOString(),
      now(),
    );
  }

  const lines: Array<[string, string, string, RoutingMode, string | null, number]> = [
    ['101', 'reception', 'Reception', 'business-hours', 'voicemail', 1],
    ['102', 'support', 'Support queue', 'business-hours', 'voicemail', 1],
    ['201', 'lab', 'Lab bench', 'always', null, 2],
    ['202', 'stores', 'Stores', 'forward', 'reception@telno.local', 2],
  ];
  const deviceRows = db.prepare('SELECT id, model FROM devices ORDER BY serial').all() as Array<{
    id: string;
    model: ModelKey;
  }>;
  lines.forEach(([extension, aorName, displayName, mode, forwardTo, slot], index) => {
    const target = deviceRows[index % deviceRows.length];
    db.prepare(
      `INSERT INTO lines (id, extension, aor, display_name, device_id, account_slot, routing_mode,
        forward_to, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uid(),
      extension,
      `${aorName}@telno.local`,
      displayName,
      target?.id ?? null,
      slot,
      mode,
      forwardTo === 'voicemail' ? `voicemail@telno.local` : forwardTo,
      1,
      now(),
    );
  });

  const people: Array<[string, string, string | null, string | null, boolean]> = [
    ['Amara Okafor', '+44 20 7946 0102', '102', 'amara@telno.local', true],
    ['Ben Sarkis', '+44 20 7946 0117', '117', 'ben@telno.local', false],
    ['Chen Wei', '+44 20 7946 0133', '133', 'chen@telno.local', true],
    ['Dana Whitfield', '+44 20 7946 0148', null, 'dana@telno.local', false],
    ['Emil Novak', '+44 20 7946 0155', '155', null, false],
  ];
  for (const [name, number, extension, email, favorite] of people) {
    db.prepare(
      'INSERT INTO directory (id, display_name, number, extension, email, favorite, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(uid(), name, number, extension, email, favorite ? 1 : 0, now());
  }

  recordEvent('system', 'success', 'Telno control plane initialised with the 2026 device catalog.');
  recordEvent('provisioning', 'info', 'Demo inventory seeded: 4 devices, 4 lines, 5 directory entries.');
}

seed();
