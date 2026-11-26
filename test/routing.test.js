/**
 * The routing document, and the gateway that reads it.
 *
 * The gateway used to carry its own copy of which numbers may leave this
 * platform and where a number we own goes. A copy kept by hand drifts: a DID
 * moved to another line here, and a call still landing on the old one. These
 * tests are about the document being derived from these rows instead — edit the
 * row, and the decision the gateway makes changes with it.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-routing-'));
process.env.SESSION_SECRET = 'test-only-session-secret';
// The gateway's credential. Set before anything imports the config, because the
// endpoint reads it from there.
process.env.ROUTING_TOKEN = 'test-routing-token';

const { db_, newId } = await import('../src/db/index.js');
const { routingDocument, routingDocumentJson, outboundPatterns, OUTBOUND_KEY } = await import(
  '../src/lib/routing.js'
);
const Fastify = (await import('fastify')).default;
const { errorHandler } = await import('../src/lib/errors.js');
const routingRoutes = (await import('../src/routes/routing.js')).default;

/** A trunk that can place calls, which is what allows outbound at all. */
function makeTrunk({ enabled = 1 } = {}) {
  const id = newId('trk_');
  db_.run(
    'INSERT INTO trunks (id, name, provider, host, username, enabled) VALUES (?, ?, ?, ?, ?, ?)',
    [id, `voipms-${id.slice(-6)}`, 'voipms', 'newyork1.voip.ms', '235662_telnolab', enabled]
  );
  return id;
}

function makeNumber({ e164, faxMode = 'voice', extension = null }) {
  const id = newId('num_');
  db_.run(
    'INSERT INTO numbers (id, e164, country, national, status, fax_mode) VALUES (?, ?, ?, ?, ?, ?)',
    [id, e164, 'US', e164.replace(/^\+1/, ''), 'active', faxMode]
  );
  if (extension) attach(id, extension);
  return id;
}

function makeExtension(extension, numberId = null) {
  const id = newId('ext_');
  db_.run(
    'INSERT INTO extensions (id, extension, display_name, number_id, enabled) VALUES (?, ?, ?, ?, 1)',
    [id, extension, `Line ${extension}`, numberId]
  );
  return id;
}

/** Moving a number to another line is the edit these tests are about. */
function attach(numberId, extension) {
  let row = db_.get('SELECT id FROM extensions WHERE extension = ?', [String(extension)]);
  if (!row) {
    const id = makeExtension(extension);
    row = { id };
  }
  // One number, one line: an extension that held it before is released, or the
  // join back to `numbers` finds two lines behind one DID.
  db_.run('UPDATE extensions SET number_id = NULL WHERE number_id = ? AND id <> ?', [numberId, row.id]);
  db_.run('UPDATE extensions SET number_id = ? WHERE id = ?', [numberId, row.id]);
}

const routeNamed = (doc, name) => doc.routes.find((route) => route.name === name);
const forwardsTo = (route) =>
  (route?.then || []).map((action) => action.forward?.to).filter(Boolean);

test('a DID goes to the line that holds it, once', () => {
  makeTrunk();
  makeNumber({ e164: '+14132642700', extension: '101' });

  const doc = routingDocument();
  assert.equal(doc.version, 1);
  assert.equal(doc.generator, 'telno');
  assert.deepEqual(routeNamed(doc, 'did-14132642700').when, { to: '14132642700' });
  assert.deepEqual(forwardsTo(routeNamed(doc, 'did-14132642700')), ['ext:101']);
  // One rule, not one per spelling: the edge normalises E.164 and the national
  // number to this form before it decides.
  assert.equal(routeNamed(doc, 'did-4132642700'), undefined);
  // Answer first: a forwarded call that nobody answered is not a transfer.
  assert.deepEqual(routeNamed(doc, 'did-14132642700').then[0], { answer: {} });
});

test('moving the number to another line changes where the gateway sends it', () => {
  makeNumber({ e164: '+14155550111', extension: '101' });
  assert.deepEqual(forwardsTo(routeNamed(routingDocument(), 'did-14155550111')), ['ext:101']);

  attach(db_.get('SELECT id FROM numbers WHERE e164 = ?', ['+14155550111']).id, '102');

  const moved = routingDocument();
  assert.deepEqual(forwardsTo(routeNamed(moved, 'did-14155550111')), ['ext:102']);
  // And the old line is not left holding a DID nobody assigned to it.
  assert.equal(
    moved.routes.filter((route) => forwardsTo(route).includes('ext:101')).some((route) => route.name === 'did-14155550111'),
    false
  );
});

test('a fax number is refused rather than answered with silence', () => {
  makeNumber({ e164: '+14155550222', faxMode: 'fax', extension: null });
  const route = routeNamed(routingDocument(), 'did-14155550222-fax');
  assert.deepEqual(route.then, [{ reject: 3 }]);
});

test('a number with no line behind it is refused, and says why in its name', () => {
  makeNumber({ e164: '+14155550333' });
  assert.deepEqual(routeNamed(routingDocument(), 'did-14155550333-unrouted').then, [{ reject: 3 }]);
});

test('outbound is allowed only while a trunk is enabled', () => {
  const doc = routingDocument();
  assert.deepEqual(forwardsTo(routeNamed(doc, 'outbound-1*')), ['pstn:']);

  const trunk = db_.get('SELECT id FROM trunks LIMIT 1');
  db_.run('UPDATE trunks SET enabled = 0 WHERE id = ?', [trunk.id]);
  const withoutTrunk = routingDocument();
  assert.equal(withoutTrunk.routes.some((route) => route.name.startsWith('outbound-')), false);
  assert.deepEqual(withoutTrunk.default, { reject: 3 });

  db_.run('UPDATE trunks SET enabled = 1 WHERE id = ?', [trunk.id]);
  assert.deepEqual(forwardsTo(routeNamed(routingDocument(), 'outbound-1*')), ['pstn:']);
});

test('the operator can change which numbers may leave, and the document follows', () => {
  db_.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    OUTBOUND_KEY,
    JSON.stringify([{ to: '4443' }, { to: '+1*', name: 'north-america' }]),
  ]);

  const doc = routingDocument();
  assert.deepEqual(forwardsTo(routeNamed(doc, 'outbound-4443')), ['pstn:']);
  assert.deepEqual(forwardsTo(routeNamed(doc, 'outbound-north-america')), ['pstn:']);
  // The default `1*` pattern is gone: an edit in the console is the whole rule.
  assert.equal(routeNamed(doc, 'outbound-1*'), undefined);
  assert.deepEqual(
    outboundPatterns().map((rule) => rule.to),
    ['4443', '+1*']
  );
});

test('the endpoint serves the same bytes a fetch would get', async () => {
  const seen = [];
  const app = Fastify();
  app.decorate('authenticateAny', async (request, scope) => {
    seen.push(scope);
    request.apiKey = { scope };
  });
  app.setErrorHandler(errorHandler);
  await app.register(routingRoutes);
  try {
    // The gateway's own credential: a token on both sides, no session, no
    // key-hash machinery between the control plane and a phone call.
    const machine = await app.inject({
      method: 'GET',
      url: '/routing/document',
      headers: { 'x-routing-token': 'test-routing-token' },
    });
    assert.equal(machine.statusCode, 200);
    assert.deepEqual(seen, []);

    // Anything else still goes through the normal door.
    const keyed = await app.inject({ method: 'GET', url: '/routing/document' });
    assert.equal(keyed.statusCode, 200);
    assert.deepEqual(seen, ['routing:read']);

    // A wrong token is not a token: it must not be accepted by accident.
    const wrong = await app.inject({
      method: 'GET',
      url: '/routing/document',
      headers: { 'x-routing-token': 'not-the-token' },
    });
    assert.equal(wrong.statusCode, 200);
    assert.deepEqual(seen, ['routing:read', 'routing:read']);

    assert.equal(machine.headers['cache-control'], 'no-store');
    const body = JSON.parse(machine.payload);
    assert.equal(body.generator, 'telno');
    // A reading and an export are the same rules, not two printings of them.
    assert.deepEqual(body.routes.map((route) => route.name), routingDocument().routes.map((r) => r.name));
    assert.equal(routingDocumentJson({ generatedAt: 'x' }).includes('"generated_at": "x"'), true);

    const again = await app.inject({
      method: 'GET',
      url: '/routing/document',
      headers: { 'x-routing-token': 'test-routing-token', 'if-none-match': machine.headers.etag },
    });
    assert.equal(again.statusCode, 304);
  } finally {
    await app.close();
  }
});
