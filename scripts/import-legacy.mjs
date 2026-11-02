#!/usr/bin/env node
/*
 * import-legacy.mjs — one-way import from the Asterisk-era `telno.db` into the
 * control-plane schema in `apps/server/src/db.ts`.
 *
 * The two databases describe different products, so this is a copy of the
 * records that still mean something, not a migration: devices keep their name,
 * MAC and model, extensions become lines, and confirmed listings become
 * directory entries. Everything the old product had no place for (billing,
 * campaigns, invoices, call detail, SIP trunks) is left where it is.
 *
 * Safe to run more than once. Every record is matched by a natural key — serial
 * for a device, extension for a line, number+name for a directory entry — so a
 * second run inserts nothing and reports it as skipped.
 *
 * An extension number is unique here, so a legacy extension that collides with a
 * row already in the console (a seeded sample, typically) is reported as a
 * conflict and left alone. `--replace-lines` lets the legacy record win, which is
 * what a real install wants; the console's own edit wins by default.
 *
 *   node scripts/import-legacy.mjs                          # dry run, prints a plan
 *   node scripts/import-legacy.mjs --apply                  # writes
 *   node scripts/import-legacy.mjs --apply --replace-lines   # legacy wins a collision
 *   node scripts/import-legacy.mjs --apply --prune-seed      # drop the seeded samples
 *   node scripts/import-legacy.mjs --apply --json            # machine readable
 *
 * The legacy database is opened read-only. Nothing is written to it.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : 'true';
}

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');
const REPLACE_LINES = process.argv.includes('--replace-lines');
const PRUNE_SEED = process.argv.includes('--prune-seed');
const LEGACY_PATH = arg('legacy', '/data/telno.db');
const TARGET_PATH = arg('target', process.env.TELNO_DB || '/data/control-plane.db');

if (!existsSync(LEGACY_PATH)) {
  console.error(`legacy database not found: ${LEGACY_PATH}`);
  process.exit(2);
}
if (!existsSync(TARGET_PATH)) {
  console.error(
    `target database not found: ${TARGET_PATH}\n` +
      'Start the control plane once so it creates the schema, then run this again.',
  );
  process.exit(2);
}

const legacy = new DatabaseSync(LEGACY_PATH, { readOnly: true });
const target = new DatabaseSync(TARGET_PATH);
target.exec('PRAGMA foreign_keys = ON;');

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** Rows of one legacy table, or [] when the table does not exist. */
function rows(table) {
  try {
    return legacy.prepare(`SELECT * FROM ${table}`).all();
  } catch {
    return [];
  }
}

const has = (value) => value !== null && value !== undefined && String(value).trim() !== '';
const text = (value, fallback = '') => (has(value) ? String(value).trim() : fallback);
const flag = (value) => (value === 0 || value === false || value === '0' ? 0 : 1);

function slug(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/*
 * The new catalog ships exactly two products, so a legacy model has to land on
 * one of them or be declined. A declined device is reported, never guessed: a
 * wrong model key would make the console serve the wrong provisioning template.
 */
const MODEL_MAP = new Map([
  ['t54w', 't750'],
  ['dp750', 't750'],
  ['t750', 't750'],
  ['ht802', 'ht802'],
  ['ht812', 'ht802'],
  ['ht814', 'ht802'],
]);

function mapModel(row) {
  const raw = text(row.model).toLowerCase();
  const mapped = MODEL_MAP.get(raw);
  if (mapped) return { model: mapped, reason: `model ${raw} → ${mapped}` };
  const byKind = raw ? null : row.kind === 'gateway' ? 'ht802' : null;
  if (byKind) return { model: byKind, reason: `no model; kind ${row.kind} → ${byKind}` };
  return { model: null, reason: `unmapped model "${text(row.model) || '(none)'}"` };
}

/*
 * A legacy row has a MAC but no serial, and enrollment identifies a device by
 * serial. A derived serial is stable across reruns and visibly not hardware:
 * when the handset enrolls it will present its real serial and appear as its own
 * device, and the imported row remains as the record of what was carried over.
 */
function serialFor(row) {
  const mac = text(row.mac).replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (mac.length >= 6) return `LEGACY-${mac}`;
  return `LEGACY-${text(row.id, uid('dev')).toUpperCase()}`;
}

/** Known but not enrolled: the old console's "online" was a last-seen badge. */
function statusFor(status) {
  return text(status).toLowerCase() === 'online' ? 'offline' : 'pending';
}

const report = {
  legacy: LEGACY_PATH,
  target: TARGET_PATH,
  applied: APPLY,
  replaceLines: REPLACE_LINES,
  devices: [],
  lines: [],
  directory: [],
  settings: [],
  pruned: [],
  counts: {},
};

/* ---------------------------------------------------------------- devices */

const domain =
  target.prepare("SELECT value FROM settings WHERE key = 'org.domain'").get()?.value || 'telno.local';

const legacyDevices = rows('devices');
const legacyExtensionToDevice = new Map();
for (const device of legacyDevices) {
  if (has(device.extension_id)) legacyExtensionToDevice.set(device.extension_id, device.id);
}

const deviceIDByLegacy = new Map();
const existingDevice = target.prepare('SELECT id FROM devices WHERE serial = ?');

for (const row of legacyDevices) {
  const label = text(row.name, text(row.model, 'Imported device'));
  const { model, reason } = mapModel(row);
  if (!model) {
    report.devices.push({ action: 'skipped', label, reason });
    continue;
  }

  const serial = serialFor(row);
  const found = existingDevice.get(serial);
  if (found) {
    deviceIDByLegacy.set(row.id, found.id);
    report.devices.push({ action: 'exists', serial, label });
    continue;
  }

  const id = uid('dev');
  const createdAt = text(row.created_at, now());
  if (APPLY) {
    target
      .prepare(
        `INSERT INTO devices (id, serial, mac, model, label, location, status, firmware,
           config_version, config_issued_at, last_seen_at, created_at, addr)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        id,
        serial,
        text(row.mac) || null,
        model,
        label.slice(0, 120),
        text(row.ip),
        statusFor(row.status),
        text(row.firmware) || null,
        createdAt,
        has(row.last_seen_at) ? text(row.last_seen_at) : null,
        createdAt,
        text(row.ip) || null,
      );
  }
  deviceIDByLegacy.set(row.id, id);
  report.devices.push({ action: APPLY ? 'inserted' : 'would-insert', serial, label, model, reason });
}

/* ------------------------------------------------------------------ lines */

const existingLine = target.prepare('SELECT * FROM lines WHERE extension = ?');
const existingAor = target.prepare('SELECT 1 FROM lines WHERE aor = ?');

for (const row of rows('extensions')) {
  const extension = text(row.extension);
  const displayName = text(row.display_name, `Extension ${extension}`);
  if (!extension) {
    report.lines.push({ action: 'skipped', reason: 'no extension number' });
    continue;
  }

  const forwardTo = text(row.forward_to);
  const routingMode = forwardTo ? 'forward' : 'business-hours';
  const enabled = flag(row.enabled);
  const current = existingLine.get(extension);

  if (current) {
    const differs =
      text(current.display_name) !== displayName ||
      text(current.forward_to) !== forwardTo ||
      flag(current.enabled) !== enabled ||
      text(current.routing_mode) !== routingMode;

    if (!differs) {
      report.lines.push({ action: 'exists', extension, displayName });
      continue;
    }
    if (!REPLACE_LINES) {
      report.lines.push({
        action: 'conflict',
        extension,
        kept: text(current.display_name),
        legacy: displayName,
        reason: `extension ${extension} already in use; pass --replace-lines to let the legacy record win`,
      });
      continue;
    }
    if (APPLY) {
      target
        .prepare(
          `UPDATE lines SET display_name = ?, routing_mode = ?, forward_to = ?, enabled = ?
           WHERE id = ?`,
        )
        .run(displayName.slice(0, 120), routingMode, forwardTo || null, enabled, current.id);
    }
    report.lines.push({
      action: APPLY ? 'updated' : 'would-update',
      extension,
      displayName,
      replaced: text(current.display_name),
    });
    continue;
  }

  let aorName = slug(displayName) || `ext${extension}`;
  // The aor is globally unique; a duplicated display name must not collide.
  if (existingAor.get(`${aorName}@${domain}`)) aorName = `ext${extension}`;

  const legacyDeviceID = legacyExtensionToDevice.get(row.id);
  const deviceID = legacyDeviceID ? deviceIDByLegacy.get(legacyDeviceID) ?? null : null;

  if (APPLY) {
    target
      .prepare(
        `INSERT INTO lines (id, extension, aor, display_name, device_id, account_slot,
           routing_mode, forward_to, enabled, created_at)
         VALUES (?,?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        uid('lne'),
        extension,
        `${aorName}@${domain}`,
        displayName.slice(0, 120),
        deviceID,
        routingMode,
        forwardTo || null,
        enabled,
        text(row.created_at, now()),
      );
  }
  report.lines.push({
    action: APPLY ? 'inserted' : 'would-insert',
    extension,
    displayName,
    routingMode,
    deviceID,
  });
}

/* -------------------------------------------------------------- directory */

const extensionByNumber = new Map();
for (const row of rows('extensions')) {
  if (has(row.number_id)) extensionByNumber.set(row.number_id, text(row.extension));
}

const accountByID = new Map(rows('accounts').map((row) => [row.id, row]));
const legacyNumberByID = new Map(rows('numbers').map((row) => [row.id, row]));
const existingDirectory = target.prepare(
  'SELECT id FROM directory WHERE number = ? AND display_name = ?',
);

for (const row of rows('listings')) {
  const number = text(legacyNumberByID.get(row.number_id)?.e164);
  const displayName = text(row.name);
  if (!number || !displayName) {
    report.directory.push({ action: 'skipped', reason: 'listing has no number or name' });
    continue;
  }
  if (existingDirectory.get(number, displayName)) {
    report.directory.push({ action: 'exists', number, displayName });
    continue;
  }

  const account = accountByID.get(row.account_id);
  if (APPLY) {
    target
      .prepare(
        `INSERT INTO directory (id, display_name, number, extension, email, company,
           favorite, notes, created_at)
         VALUES (?,?,?,?,?,?,0,?,?)`,
      )
      .run(
        uid('dir'),
        displayName.slice(0, 120),
        number,
        extensionByNumber.get(row.number_id) ?? null,
        text(row.email) || null,
        text(account?.company) || null,
        `Imported from the legacy listing ${text(row.id)}`,
        text(row.created_at, now()),
      );
  }
  report.directory.push({ action: APPLY ? 'inserted' : 'would-insert', number, displayName });
}

/* -------------------------------------------------------------- demo rows */

/*
 * A fresh install seeds sample inventory (seed() in db.ts) so the console is not
 * empty. On a node carrying real records that sample data is just noise. Every
 * seeded row is matched by the exact tuple the seeder wrote — serial+MAC for a
 * device, extension+aor+display name for a line, name+number+email for a
 * directory entry — so a row an operator has since edited no longer matches and
 * is left alone. `seed.demo` stays set, so a restart will not re-create them.
 */
const SEEDED_DEVICES = [
  ['T750-2026-000418', 'AA:42:10:7C:11:01'],
  ['T750-2026-000419', 'AA:42:10:7C:11:02'],
  ['HT802-2026-000117', 'AA:42:10:7C:22:01'],
  ['HT802-2026-000118', 'AA:42:10:7C:22:02'],
];
const SEEDED_LINES = [
  ['101', 'reception', 'Reception'],
  ['102', 'support', 'Support queue'],
  ['201', 'lab', 'Lab bench'],
  ['202', 'stores', 'Stores'],
];
const SEEDED_DIRECTORY = [
  ['Amara Okafor', '+44 20 7946 0102', 'amara@telno.local'],
  ['Ben Sarkis', '+44 20 7946 0117', 'ben@telno.local'],
  ['Chen Wei', '+44 20 7946 0133', 'chen@telno.local'],
  ['Dana Whitfield', '+44 20 7946 0148', 'dana@telno.local'],
  ['Emil Novak', '+44 20 7946 0155', 'emil@telno.local'],
];

if (PRUNE_SEED) {
  const allLines = target.prepare('SELECT * FROM lines').all();
  for (const [extension, aorName, displayName] of SEEDED_LINES) {
    const row = allLines.find(
      (line) =>
        text(line.extension) === extension &&
        text(line.display_name) === displayName &&
        text(line.aor).startsWith(`${aorName}@`),
    );
    if (!row) continue;
    if (APPLY) target.prepare('DELETE FROM lines WHERE id = ?').run(row.id);
    report.pruned.push({
      action: APPLY ? 'pruned' : 'would-prune',
      kind: 'line',
      extension,
    });
  }

  const allDevices = target.prepare('SELECT * FROM devices').all();
  for (const [serial, mac] of SEEDED_DEVICES) {
    const row = allDevices.find(
      (device) => text(device.serial) === serial && text(device.mac).toUpperCase() === mac,
    );
    if (!row) continue;
    if (APPLY) target.prepare('DELETE FROM devices WHERE id = ?').run(row.id);
    report.pruned.push({ action: APPLY ? 'pruned' : 'would-prune', kind: 'device', serial });
  }

  const allDirectory = target.prepare('SELECT * FROM directory').all();
  for (const [displayName, number, email] of SEEDED_DIRECTORY) {
    const row = allDirectory.find(
      (entry) =>
        text(entry.display_name) === displayName &&
        text(entry.number) === number &&
        text(entry.email) === email,
    );
    if (!row) continue;
    if (APPLY) target.prepare('DELETE FROM directory WHERE id = ?').run(row.id);
    report.pruned.push({
      action: APPLY ? 'pruned' : 'would-prune',
      kind: 'directory',
      number,
    });
  }
}

/* --------------------------------------------------------------- settings */

/*
 * Brand strings carry over because they are content an operator wrote, but only
 * where the new database has no value yet — a key set in the console wins, and
 * org.domain is never imported (the new node has its own hostname contract).
 */
const BRAND_KEYS = [
  'brand.name',
  'brand.vendor',
  'brand.tagline',
  'brand.description',
  'brand.accent',
  'brand.support_email',
];
const existingSetting = target.prepare('SELECT value FROM settings WHERE key = ?');
const legacySettings = new Map(rows('settings').map((row) => [row.key, row.value]));

for (const key of BRAND_KEYS) {
  const value = legacySettings.get(key);
  if (!has(value)) continue;
  if (has(existingSetting.get(key)?.value)) {
    report.settings.push({ action: 'exists', key });
    continue;
  }
  if (APPLY) {
    target
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, String(value));
  }
  report.settings.push({ action: APPLY ? 'inserted' : 'would-insert', key });
}

/* ------------------------------------------------------------------ event */

const tally = (list) =>
  list.reduce((acc, item) => ({ ...acc, [item.action]: (acc[item.action] ?? 0) + 1 }), {});
report.counts = {
  devices: tally(report.devices),
  lines: tally(report.lines),
  directory: tally(report.directory),
  settings: tally(report.settings),
  pruned: tally(report.pruned),
};

if (APPLY) {
  const changed =
    (report.counts.devices.inserted ?? 0) +
    (report.counts.lines.inserted ?? 0) +
    (report.counts.lines.updated ?? 0) +
    (report.counts.directory.inserted ?? 0);
  if (changed > 0) {
    target
      .prepare('INSERT INTO events (kind, level, message, meta, created_at) VALUES (?,?,?,?,?)')
      .run(
        'legacy.import',
        'info',
        `Imported ${changed} record(s) from the Asterisk-era database`,
        JSON.stringify(report.counts),
        now(),
      );
  }
}

legacy.close();
target.close();

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (label, list) => {
    const counts = list.reduce((acc, item) => {
      acc[item.action] = (acc[item.action] ?? 0) + 1;
      return acc;
    }, {});
    const detail = Object.entries(counts)
      .map(([action, count]) => `${count} ${action}`)
      .join(', ');
    console.log(`${label.padEnd(10)} ${detail || 'nothing to do'}`);
    for (const item of list.filter((entry) =>
      ['skipped', 'conflict'].includes(entry.action),
    )) {
      console.log(`           ${item.action}: ${item.reason ?? ''}${item.legacy ? ` (kept "${item.kept}", legacy "${item.legacy}")` : ''}`);
    }
  };
  console.log(`${APPLY ? 'importing' : 'dry run'}  ${LEGACY_PATH} → ${TARGET_PATH}`);
  line('devices', report.devices);
  line('lines', report.lines);
  line('directory', report.directory);
  line('settings', report.settings);
  line('demo rows', report.pruned);
  if (!APPLY) console.log('\nNo changes written. Re-run with --apply to import.');
}
