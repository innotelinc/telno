/**
 * A trunk can be used without being registered.
 *
 * `enabled` says whether this platform may place calls on a trunk at all, and
 * the routing document reads it to decide whether outbound rules exist. That is
 * a different question from whether *this switch* holds the carrier binding: a
 * sub-account already registered by another endpoint still places calls with a
 * digest on the INVITE. These tests keep the two apart, because folding them
 * together is how the DID ended up with two registrars.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-trunk-register-'));
process.env.SESSION_SECRET = 'test-only-session-secret';

const { db_, newId } = await import('../src/db/index.js');
const { generateConfigs } = await import('../src/telephony/provision.js');
const { routingDocument } = await import('../src/lib/routing.js');

function makeTrunk(name, { register, enabled = 1 } = {}) {
  const id = newId('trk_');
  if (register === undefined) {
    db_.run(
      'INSERT INTO trunks (id, name, provider, host, username, secret, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, 'voipms', 'newyork1.voip.ms', '235662_telnolab', 'test-secret', enabled]
    );
  } else {
    db_.run(
      'INSERT INTO trunks (id, name, provider, host, username, secret, enabled, register) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, 'voipms', 'newyork1.voip.ms', '235662_telnolab', 'test-secret', enabled, register]
    );
  }
  return id;
}

test('a trunk that does not register keeps its endpoint and keeps outbound', () => {
  makeTrunk('parked', { register: 0 });

  const pjsip = generateConfigs()['pjsip.conf'];
  assert.equal(pjsip.includes('[trunk-parked-registration]'), false);
  assert.equal(pjsip.includes('type=registration'), false);
  assert.match(pjsip, /\[trunk-parked-endpoint\]/);
  assert.match(pjsip, /\[trunk-parked-auth\]/);

  assert.ok(
    routingDocument().routes.some((route) => route.name.startsWith('outbound-')),
    'an enabled trunk still lets the document emit outbound rules'
  );
});

test('registering is the default, and disabling it is only about the binding', () => {
  makeTrunk('live', {});
  makeTrunk('silent', { register: 0, enabled: 1 });

  const pjsip = generateConfigs()['pjsip.conf'];
  assert.match(pjsip, /\[trunk-live-registration\]/);
  assert.match(pjsip, /\[trunk-live-endpoint\]/);
  assert.equal(pjsip.includes('[trunk-silent-registration]'), false);
  assert.match(pjsip, /\[trunk-silent-endpoint\]/);

  const rows = db_.all('SELECT name, register FROM trunks ORDER BY name');
  const live = rows.find((row) => row.name === 'live');
  const silent = rows.find((row) => row.name === 'silent');
  assert.equal(live.register, 1, 'a trunk row created without the column registers');
  assert.equal(silent.register, 0);
});
