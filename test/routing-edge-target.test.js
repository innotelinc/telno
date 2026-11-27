/**
 * With a SIP switch behind the edge, the document forwards the number, not the
 * line — and the switch is entered where a carrier's call enters.
 *
 * A rule that named the line (`sip:101`) would make the gateway the authority on
 * which line a DID rings, and the switch would never see the number that was
 * dialled: its CDR would name 101, and its DID table, its per-agent recording and
 * its fax auto-detect would all be bypassed on the one path that carries real
 * calls. Forwarding the DID lets `[registry]` answer "where does this go" once,
 * for both the carrier and the gateway.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-edge-target-'));
process.env.SESSION_SECRET = 'test-only-session-secret';
// An edge with a secret is what makes the document say `sip:` instead of `ext:`.
process.env.CANTUS_SIP_EDGE = '127.0.0.1:5062';
process.env.CANTUS_EDGE_SECRET = 'test-only-edge-secret';

const { db_, newId } = await import('../src/db/index.js');
const { routingDocument } = await import('../src/lib/routing.js');
const { generateConfigs } = await import('../src/telephony/provision.js');

const numberId = newId('num_');
db_.run(
  'INSERT INTO numbers (id, e164, country, national, status, fax_mode) VALUES (?, ?, ?, ?, ?, ?)',
  [numberId, '+14132642700', 'US', '4132642700', 'active', 'voice']
);
const extensionId = newId('ext_');
db_.run(
  'INSERT INTO extensions (id, extension, display_name, number_id, enabled) VALUES (?, ?, ?, ?, 1)',
  [extensionId, '101', 'Edge test line', numberId]
);

const routeNamed = (doc, name) => doc.routes.find((route) => route.name === name);
const forwardsTo = (route) =>
  (route?.then || []).map((action) => action.forward?.to).filter(Boolean);

test('the DID route forwards the number that was dialled, not the line', () => {
  const route = routeNamed(routingDocument(), 'did-14132642700');

  // Eleven digits, no punctuation: what the switch's `[registry]` is keyed on.
  assert.deepEqual(forwardsTo(route), ['sip:14132642700']);
  // Answering first is still the rule: a forwarded call nobody answered is not a
  // transfer.
  assert.deepEqual(route.then[0], { answer: {} });
});

test('a number with no line is still refused before it is forwarded', () => {
  const orphan = newId('num_');
  db_.run(
    'INSERT INTO numbers (id, e164, country, national, status, fax_mode) VALUES (?, ?, ?, ?, ?, ?)',
    [orphan, '+14155550999', 'US', '4155550999', 'active', 'voice']
  );

  const route = routeNamed(routingDocument(), 'did-14155550999-unrouted');
  assert.deepEqual(route.then, [{ reject: 3 }]);
});

test('the edge endpoint enters the dialplan at from-trunk', () => {
  const pjsip = generateConfigs()['pjsip.conf'];
  const edge = pjsip.slice(pjsip.indexOf('[cantus-edge]'), pjsip.indexOf('[cantus-edge-identify]'));

  // The gateway's call is carrier-shaped: addressed to a number, handed to the
  // context that maps numbers to lines.
  assert.match(edge, /^context=from-trunk$/m);
  // The endpoint still authenticates; the context is not what makes it trusted.
  assert.match(edge, /^auth=cantus-edge-auth$/m);
});
