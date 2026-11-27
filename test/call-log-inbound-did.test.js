/**
 * A carrier call is logged against the number that was dialled.
 *
 * The gateway dials this switch by extension, so an answered DID arrived as
 * `PJSIP/cantus-edge-…` addressed to `101`. The CDR's Destination is the line
 * that rang, so `to_number` said `101` for a call the caller placed to
 * 413-264-2700 — a row nobody can reconcile against a carrier bill. The number
 * travels beside the extension as the `X-Cantus-DID` header, the dialplan writes
 * it to the CDR's user field, and the row keeps it in preference to the
 * extension whichever event is heard first.
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

  // The line that answered is not the number that was dialled, and a field that
  // carries something else entirely must not be turned into a DID.
  assert.equal(dialledDid('101'), '');
  assert.equal(dialledDid(''), '');
  assert.equal(dialledDid('agent=jane'), '');
  assert.equal(dialledDid(undefined), '');
});

test('the row keeps the DID, whichever event is heard first', () => {
  const edge = {
    direction: directionFor('from-internal', 'PJSIP/cantus-edge-00000040'),
    from_number: '4132642700',
    to_number: '101',
  };
  // The CDR for the same leg, carrying what the dialplan read off the gateway.
  const cdr = { to_number: dialledDid('14132642700') };

  for (const [first, second] of [
    [edge, cdr],
    [cdr, edge],
  ]) {
    const merged = mergeFields(first, second);
    // The carrier's number, not the extension it was mapped onto, and in the
    // one form the console stores numbers in.
    assert.equal(merged.to_number, '+14132642700');
    assert.equal(merged.direction, 'inbound');
  }

  // A later event that only names the extension cannot take the DID back.
  const settled = mergeFields(mergeFields(edge, cdr), { to_number: '101' });
  assert.equal(settled.to_number, '+14132642700');
});

test('a row written from a call matches the number the console holds', () => {
  // The DID as the console stores it: `numbers.e164` is the key every other
  // table joins on, so a call row naming the ten-digit form is a second number
  // nothing can be matched to.
  const numberId = newId('num_');
  db_.run(
    'INSERT INTO numbers (id, e164, country, national, status, fax_mode) VALUES (?, ?, ?, ?, ?, ?)',
    [numberId, '+14132642700', 'US', '4132642700', 'active', 'voice']
  );
  const stored = db_.get('SELECT e164 FROM numbers WHERE id = ?', [numberId]).e164;

  // The carrier sends it as the dialled party; the dialplan writes it to the CDR
  // user field in whichever spelling the switch had.
  for (const asSent of ['4132642700', '14132642700', '+14132642700']) {
    const row = mergeFields({}, { direction: 'inbound', to_number: dialledDid(asSent) });
    assert.equal(row.to_number, stored, `${asSent} did not match numbers.e164`);
  }
});

test('the dialplan reads the DID off the gateway leg, and files it in the CDR', () => {
  const conf = generateConfigs()['extensions.conf'];
  const from = conf.slice(conf.indexOf('[from-internal]'), conf.indexOf('[registry]'));

  // The edge's call enters here, so this is where the header is still readable.
  assert.match(from, /Set\(__TELNO_DID=\$\{PJSIP_HEADER\(read,X-Cantus-DID\)\}\)/);
  // The log is built from CDRs, and the user field is the only one a CDR may be
  // given, so the number has to be put there before the call is rung.
  assert.match(from, /Set\(CDR\(userfield\)=\$\{TELNO_DID\}\)/);
  // The extension still decides where the call rings.
  assert.match(from, /Goto\(internal,\$\{EXTEN\},1\)/);
});
