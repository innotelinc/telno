/**
 * A carrier call is logged against the number that was dialled.
 *
 * The gateway hands an inbound call to this switch addressed to the DID, and
 * `[registry]` maps that number to a line, so the CDR's destination is already
 * the number the caller dialled — not the line it eventually rang. What is left
 * is that the carrier sends ten digits and the request-URI carries eleven: the
 * same number in two forms is one the console cannot join to `numbers`, so a
 * destination long enough to be a DID is stored in the E.164 form the rest of the
 * platform is keyed on.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-inbound-did-'));
process.env.SESSION_SECRET = 'test-only-session-secret';

const { dialledDid, directionFor, mergeFields } = await import('../src/telephony/call-log.js');
const { db_, newId } = await import('../src/db/index.js');
const { generateConfigs } = await import('../src/telephony/provision.js');

db_.run(
  'INSERT INTO extensions (id, extension, display_name, enabled) VALUES (?, ?, ?, 1)',
  [newId('ext_'), '101', 'Inbound DID test line']
);

test('the dialled number is readable, and an extension is not one', () => {
  // Every form a carrier hands over collapses to the one the console stores.
  assert.equal(dialledDid('4132642700'), '+14132642700');
  assert.equal(dialledDid('14132642700'), '+14132642700');
  assert.equal(dialledDid('+1 (413) 264-2700'), '+14132642700');

  // The line that answered is not the number that was dialled, and a value that
  // is not a number of DID length must not be turned into one.
  assert.equal(dialledDid('101'), '');
  assert.equal(dialledDid(''), '');
  assert.equal(dialledDid('agent=jane'), '');
  assert.equal(dialledDid(undefined), '');
});

test('the row keeps the DID, whichever event is heard first', () => {
  const edge = {
    direction: directionFor('from-trunk', 'PJSIP/cantus-edge-00000040'),
    from_number: '4132642700',
    to_number: '101',
  };
  // The CDR for the same leg, carrying the number the gateway forwarded.
  const cdr = { to_number: '14132642700' };

  for (const [first, second] of [
    [edge, cdr],
    [cdr, edge],
  ]) {
    const merged = mergeFields(first, second);
    // The carrier's number, not a line, and in the one form the console stores
    // numbers in.
    assert.equal(merged.to_number, '+14132642700');
    assert.equal(merged.direction, 'inbound');
  }

  // A later event that only names the extension cannot take the DID back.
  const settled = mergeFields(mergeFields(edge, cdr), { to_number: '101' });
  assert.equal(settled.to_number, '+14132642700');

  // And a call that never named a DID keeps the extension it rang.
  assert.equal(mergeFields({}, { to_number: '101' }).to_number, '101');
});

test('a row written from a call matches the number the console holds', () => {
  // The DID as the console stores it: `numbers.e164` is the key every other
  // table joins on, so a call row naming another form is a number nothing can be
  // matched to.
  const numberId = newId('num_');
  db_.run(
    'INSERT INTO numbers (id, e164, country, national, status, fax_mode) VALUES (?, ?, ?, ?, ?, ?)',
    [numberId, '+14132642700', 'US', '4132642700', 'active', 'voice']
  );
  const stored = db_.get('SELECT e164 FROM numbers WHERE id = ?', [numberId]).e164;

  // Whichever spelling reaches the row — the carrier's ten digits, the
  // request-URI's eleven, or an E.164 value already — it lands as the stored one.
  for (const asSent of ['4132642700', '14132642700', '+14132642700']) {
    const row = mergeFields({}, { direction: 'inbound', to_number: asSent });
    assert.equal(row.to_number, stored, `${asSent} did not match numbers.e164`);
  }
});

test('a call from the gateway enters the dialplan the way a carrier call does', () => {
  const conf = generateConfigs()['extensions.conf'];

  // The number travels in the request-URI, so nothing is read out of a header on
  // the way in and no CDR field is written by hand.
  const from = conf.slice(conf.indexOf('[from-internal]'), conf.indexOf('[registry]'));
  assert.equal(/PJSIP_HEADER|CDR\(userfield\)/.test(from), false);
  assert.match(from, /Goto\(internal,\$\{EXTEN\},1\)/);

  // A carrier-shaped call is handed to `[registry]`, which owns the DID table and
  // the per-DID recording, fax and routing decisions. The gateway enters there
  // too (see the edge context in `pjsip.conf`, asserted with the routing target).
  const trunk = conf.slice(conf.indexOf('[from-trunk]'), conf.indexOf('[from-internal]'));
  assert.match(trunk, /Goto\(registry,\$\{EXTEN\},1\)/);
});
