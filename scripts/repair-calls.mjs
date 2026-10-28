#!/usr/bin/env node
/**
 * Collapse call-log rows that describe the same call.
 *
 * Before the ingest grouped by Linkedid, one call wrote a row per leg: a Local
 * channel pair plus the CDR that followed each hangup, so a single 19-second
 * call appeared four times in the log. This repairs rows written that way.
 *
 * The grouping is conservative: rows whose call_id ends in a leg number
 * (`1793155399.0`, `1793155399.1`) belong to the call named before the dot, and
 * a row with the old `source-start` fallback is attached to such a call only
 * when it starts within five seconds of it. Anything else is left untouched.
 *
 *   node scripts/repair-calls.mjs [--apply] [path-to-telno.db]
 *
 * Without --apply it prints what it would do and changes nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { mergeFields } from '../src/telephony/call-log.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const file = argv.find((arg) => !arg.startsWith('--')) || process.env.DB_PATH || '/data/telno.db';

const LEG = /^(.*)\.(\d+)$/;
const SEEDED = /^seed-/;

const db = new DatabaseSync(file);
const rows = db.prepare('SELECT * FROM calls').all();

const legOf = (row) => LEG.exec(String(row.call_id || ''));

const groups = new Map();
const orphans = [];
for (const row of rows) {
  const leg = legOf(row);
  if (leg) {
    const group = groups.get(leg[1]) || { key: leg[1], members: [] };
    group.members.push(row);
    groups.set(leg[1], group);
  } else if (!SEEDED.test(String(row.call_id || ''))) {
    orphans.push(row);
  }
}

const startedOf = (group) =>
  Math.min(...group.members.map((member) => Date.parse(member.started_at) || 0));

const digits = (value) => String(value ?? '').replace(/\D/g, '').slice(-10);
const partiesOf = (row) => [digits(row.from_number), digits(row.to_number)].filter(Boolean);

/**
 * Join groups that are the same call wearing two leg numbers.
 *
 * A Local channel pair is usually minted in the same second, so both legs share
 * a Uniqueid prefix — but not always: `1793156096.0` and `1793156097.1` are one
 * call whose two channels were created a second apart. Two calls a couple of
 * seconds apart that also share a party are not a thing a redial can produce.
 */
// The records that carry no leg number are attached first: they are the ones
// that name the parties, and the join below needs a party to compare.
for (const row of orphans) {
  const at = Date.parse(row.started_at) || 0;
  let best = null;
  for (const group of groups.values()) {
    const delta = Math.abs(startedOf(group) - at);
    if (delta <= 5000 && (!best || delta < best.delta)) best = { group, delta };
  }
  if (best) best.group.members.push(row);
}

const list = [...groups.values()];
for (let i = 0; i < list.length; i += 1) {
  for (let j = i + 1; j < list.length; j += 1) {
    const left = list[i];
    const right = list[j];
    if (!left.members.length || !right.members.length) continue;
    if (Math.abs(startedOf(left) - startedOf(right)) > 2000) continue;
    const shared = left.members.some((a) => partiesOf(a).some((party) => right.members.some((b) => partiesOf(b).includes(party))));
    if (!shared) continue;
    left.members.push(...right.members);
    right.members = [];
    groups.delete(right.key);
  }
}

const collapsed = [...groups.values()].filter((group) => group.members.length > 1);
console.log(`${file}: ${rows.length} rows in ${groups.size} calls; ${collapsed.length} calls hold duplicates`);

if (!collapsed.length) {
  console.log('nothing to repair');
  process.exit(0);
}

if (apply) {
  const backup = `${file}.before-call-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, backup);
  console.log(`backup: ${backup}`);
}

const columns = [
  'direction', 'from_number', 'to_number', 'extension', 'trunk', 'started_at', 'answered_at',
  'ended_at', 'duration', 'billsec', 'disposition', 'hangup_cause', 'recording', 'cost',
];

let removed = 0;
for (const group of collapsed) {
  const members = [...group.members].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  // The row with a real identity stays: a leg id is the call, a fallback id is
  // not, and either way the oldest row is the one the log already showed first.
  const keep = members.find((member) => legOf(member)) || members[0];
  let merged = { ...keep };
  for (const member of members) {
    if (member === keep) continue;
    merged = mergeFields(merged, member);
  }

  const before = columns.map((column) => `${column}=${keep[column]}`).join(' ');
  const after = columns.map((column) => `${column}=${merged[column]}`).join(' ');
  console.log(`\nkept ${keep.call_id} (${members.map((member) => member.call_id).join(', ')})`);
  if (before !== after) console.log(`  before: ${before}\n  after:  ${after}`);

  if (apply) {
    db.exec('BEGIN');
    db.prepare(
      `UPDATE calls SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`
    ).run(...columns.map((column) => merged[column] ?? null), keep.id);
    for (const member of members) {
      if (member.id !== keep.id) db.prepare('DELETE FROM calls WHERE id = ?').run(member.id);
    }
    db.exec('COMMIT');
  }
  removed += members.length - 1;
}

console.log(
  `\n${apply ? 'collapsed' : 'would collapse'} ${removed} duplicate rows across ${collapsed.length} calls`
);
if (!apply) console.log('re-run with --apply to write');
