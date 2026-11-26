/**
 * Onboarding: moving the address a verification code goes to.
 *
 * A deployment creates its owner with whatever address the operator typed at
 * first boot. If that mailbox cannot be opened, the required wizard can never be
 * finished — so the address is editable, but only while it is unverified: once
 * verified it is the account's identity, and a code sent to the old address must
 * not be able to prove the new one.
 *
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-email-step-'));
process.env.SESSION_SECRET = 'test-only-session-secret';

const { db_, newId, now } = await import('../src/db/index.js');
const Fastify = (await import('fastify')).default;
const { HttpError } = await import('../src/lib/errors.js');
const onboardingRoutes = (await import('../src/routes/onboarding.js')).default;

function makeAccount({ email, verified = null }) {
  const id = newId('acc_');
  db_.run(
    'INSERT INTO accounts (id, email, name, password_hash, role, token_version, email_verified_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    [id, email, 'Test Owner', 'scrypt$test', 'owner', verified]
  );
  return id;
}

async function withApp(accountId, run) {
  const app = Fastify();
  // The real decorator reads the session cookie; here the signed-in account is
  // the fixture, so the route is exercised without a browser.
  app.decorate('authenticate', async (request) => {
    request.account = db_.get('SELECT * FROM accounts WHERE id = ?', [accountId]);
  });
  // The shape app.js sends, so the assertions are about the body a console
  // actually receives rather than Fastify's default error object.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    return reply.status(error.statusCode || 500).send({
      error: { code: 'internal_error', message: error.message },
    });
  });
  await app.register(onboardingRoutes);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

const changeAddress = (app, email) =>
  app.inject({ method: 'POST', url: '/onboarding/email/address', payload: { email } });

test('moves an unverified address and retires a code sent to the old one', async () => {
  const id = makeAccount({ email: 'old@example.test' });
  db_.run(
    "INSERT INTO account_verifications (id, account_id, channel, target, code_hash, expires_at) VALUES (?, ?, 'email', ?, ?, ?)",
    [
      newId('ver_'),
      id,
      'old@example.test',
      'not-a-real-hash',
      new Date(Date.now() + 10 * 60_000).toISOString(),
    ]
  );

  await withApp(id, async (app) => {
    const res = await changeAddress(app, ' New@Example.test ');
    assert.equal(res.statusCode, 200);
    // Stored normalised, so signing in later with a different case still works.
    assert.equal(res.json().email.address, 'new@example.test');
    assert.equal(db_.get('SELECT email FROM accounts WHERE id = ?', [id]).email, 'new@example.test');

    const pending = db_.all(
      "SELECT id FROM account_verifications WHERE account_id = ? AND channel = 'email' AND used_at IS NULL",
      [id]
    );
    assert.equal(pending.length, 0, 'a code sent to the old address must not survive the move');
  });
});

test('refuses an address another account already signs in with', async () => {
  const id = makeAccount({ email: 'mine@example.test' });
  makeAccount({ email: 'taken@example.test' });

  await withApp(id, async (app) => {
    const res = await changeAddress(app, 'taken@example.test');
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /Another account/);
    assert.equal(db_.get('SELECT email FROM accounts WHERE id = ?', [id]).email, 'mine@example.test');
  });
});

test('refuses to move an address that is already verified', async () => {
  const id = makeAccount({ email: 'proved@example.test', verified: now() });

  await withApp(id, async (app) => {
    const res = await changeAddress(app, 'elsewhere@example.test');
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error.message, /already verified/);
    assert.equal(db_.get('SELECT email FROM accounts WHERE id = ?', [id]).email, 'proved@example.test');
  });
});
