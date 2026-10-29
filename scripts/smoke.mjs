#!/usr/bin/env node
/**
 * End-to-end check of the Telno control plane.
 *
 *   node scripts/smoke.mjs [baseUrl]
 *
 * Covers the paths that matter: console auth, device enrollment by code, the
 * signed configuration document, ETag/304 polling, device reporting, cantus
 * routing validation and the guards that keep the console closed.
 */

import { existsSync, readFileSync } from 'node:fs';

/** Credentials come from the environment or the project's .env — never a literal. */
function envFile() {
  const file = new URL('../.env', import.meta.url);
  if (!existsSync(file)) return {};
  const vars = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

const fileEnv = envFile();
const base = process.argv[2] ?? 'http://127.0.0.1:8791';
/** True when talking to the control plane itself rather than through the terminator. */
const direct = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(base);
const user = process.env.TELNO_ADMIN_USER ?? fileEnv.TELNO_ADMIN_USER ?? 'admin';
const password = process.env.TELNO_ADMIN_PASSWORD ?? fileEnv.TELNO_ADMIN_PASSWORD ?? '';

if (!password) {
  console.error('Set TELNO_ADMIN_PASSWORD (or add it to .env) before running the smoke test.');
  process.exit(2);
}

let cookie = '';
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}

async function call(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (auth && cookie) init.headers.cookie = cookie;
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (err) {
    const code = err?.cause?.code ?? err?.code ?? '';
    if (!/CERT|ISSUER|SELF_SIGNED/.test(code)) throw err;
    // Node does not read the Windows/macOS trust store, so the local CA has to be
    // named explicitly even though every browser already trusts it.
    console.error(`\nCannot verify ${base} (${code}).`);
    console.error('The console uses Telno\'s local CA; trust it for this run with:');
    console.error(`  NODE_EXTRA_CA_CERTS=certs/telno-root-ca.crt node scripts/smoke.mjs ${base}`);
    process.exit(2);
  }
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

const section = (title) => console.log(`\n── ${title}`);

/* ------------------------------------------------------------------ guards */
section('unauthenticated access');
{
  const res = await call('/api/overview', { auth: false });
  check('console API refuses anonymous callers', res.status === 401, `HTTP ${res.status}`);
  const bad = await call('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: user, password: 'wrong-password' },
  });
  check('wrong password is rejected', bad.status === 401, `HTTP ${bad.status}`);
}

/* -------------------------------------------------------------------- auth */
section('console sign-in');
{
  const res = await call('/api/auth/login', {
    method: 'POST',
    auth: false,
    body: { username: user, password },
  });
  check('sign-in succeeds', res.status === 200, `HTTP ${res.status}`);
  check('session cookie issued', Boolean(cookie), cookie ? 'httpOnly cookie set' : 'missing');
  const session = await call('/api/auth/session');
  check('session resolves the operator', session.json?.user?.username === user);
}

section('console allowlist');
{
  // The control plane trusts X-Forwarded-For only when it arrives from loopback,
  // so hitting it directly lets this header simulate a foreign caller. Behind the
  // TLS terminator the header is overwritten with the real peer address, so the
  // spoof is ignored by design and the denial path cannot be probed from here.
  if (direct) {
    const foreign = await call('/api/auth/login', {
      method: 'POST',
      auth: false,
      headers: { 'x-forwarded-for': '203.0.113.77' },
      body: { username: user, password },
    });
    check('sign-in refused from an untrusted network', foreign.status === 403, `HTTP ${foreign.status}`);

    const foreignApi = await call('/api/overview', {
      headers: { 'x-forwarded-for': '203.0.113.77' },
    });
    check(
      'console API refused from an untrusted network',
      foreignApi.status === 403,
      `HTTP ${foreignApi.status}`,
    );
  } else {
    check('allowed network reaches the console', Boolean(cookie), 'session established through the proxy');
    check(
      'allowlist denial not probed through the proxy',
      true,
      'SKIPPED: the terminator replaces X-Forwarded-For with the real peer',
    );
  }

  const allowed = await call('/api/health');
  check('health probe stays reachable', allowed.status === 200, `HTTP ${allowed.status}`);
}

section('cross-origin mutation guard');
{
  const res = await call('/api/settings', {
    method: 'PATCH',
    headers: { origin: 'http://evil.example' },
    body: { orgName: 'hijacked' },
  });
  check('foreign-origin mutation refused', res.status === 403, `HTTP ${res.status}`);
}

/* ----------------------------------------------------------------- devices */
section('device lifecycle');
let device;
let enrollmentCode;
let deviceToken;
let etag;
{
  const created = await call('/api/devices', {
    method: 'POST',
    body: { model: 't750', label: 'Smoke test phone', location: 'Lab', issueCode: true },
  });
  device = created.json?.device;
  enrollmentCode = created.json?.enrollment?.code;
  check('device created', created.status === 201 && Boolean(device), `serial ${device?.serial}`);
  check('enrollment code issued', Boolean(enrollmentCode), enrollmentCode ?? 'none');

  const enrolled = await call('/prov/v1/enroll', {
    method: 'POST',
    auth: false,
    body: {
      code: enrollmentCode,
      serial: device.serial,
      mac: '02:00:00:00:00:99',
      firmware: '2026.1.0',
    },
  });
  deviceToken = enrolled.json?.token;
  check('device enrolls with the code', enrolled.status === 201 && Boolean(deviceToken));
  check(
    'token is prefixed and not the code',
    typeof deviceToken === 'string' && deviceToken.startsWith('tln_') && deviceToken !== enrollmentCode,
  );

  const reused = await call('/prov/v1/enroll', {
    method: 'POST',
    auth: false,
    body: { code: enrollmentCode, serial: device.serial },
  });
  check('enrollment code cannot be reused', reused.status === 401, `HTTP ${reused.status}`);

  const noToken = await call('/prov/v1/config', { auth: false });
  check('config requires a device token', noToken.status === 401, `HTTP ${noToken.status}`);

  const config = await call('/prov/v1/config', {
    auth: false,
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  etag = config.headers.get('etag');
  const doc = config.json;
  check('signed config delivered', config.status === 200 && Boolean(doc?.signature));
  check('config declares the cantus transport', doc?.voice?.transport === 'cantus/1', doc?.voice?.transport);
  check('config is bound to the device serial', doc?.device?.serial === device.serial);
  check('config carries the signing key id', typeof doc?.keyId === 'string', doc?.keyId);
  check('ETag returned for polling', Boolean(etag), etag ?? 'missing');
  check(
    'secret is not leaked in config',
    !JSON.stringify(doc ?? {}).toLowerCase().includes('password'),
  );

  const notModified = await call('/prov/v1/config', {
    auth: false,
    headers: { authorization: `Bearer ${deviceToken}`, 'if-none-match': etag },
  });
  check('unchanged config answers 304', notModified.status === 304, `HTTP ${notModified.status}`);

  const report = await call('/prov/v1/report', {
    method: 'POST',
    auth: false,
    headers: { authorization: `Bearer ${deviceToken}` },
    body: { configVersion: doc.version, firmware: '2026.1.0' },
  });
  check('device can report applied revision', report.status === 200, `HTTP ${report.status}`);

  const rotated = await call(`/api/devices/${device.id}/rotate-token`, { method: 'POST' });
  check('token rotation issues a new token', rotated.status === 200 && Boolean(rotated.json?.token));
  const stale = await call('/prov/v1/config', {
    auth: false,
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  check('rotated token invalidates the old one', stale.status === 401, `HTTP ${stale.status}`);
  deviceToken = rotated.json?.token;

  const verified = await call(`/api/devices/${device.id}/verify-config`, { method: 'POST' });
  check('issued signature verifies', verified.json?.signatureMatches === true);
}

/* ------------------------------------------------------------------- lines */
section('lines and routing');
let lineId;
{
  // Clear anything left by an interrupted run, then use a unique extension and
  // address so the script is repeatable against a live database.
  const existing = await call('/api/lines');
  for (const line of existing.json?.lines ?? []) {
    if (String(line.displayName).startsWith('Smoke Line')) {
      await call(`/api/lines/${line.id}`, { method: 'DELETE' });
    }
  }
  const extension = String(900 + Math.floor(Math.random() * 99));
  const created = await call('/api/lines', {
    method: 'POST',
    body: {
      extension,
      aorName: `smoke-${extension}`,
      displayName: `Smoke Line ${extension}`,
      deviceId: device.id,
      routingMode: 'business-hours',
      forwardTo: 'voicemail@telno.local',
      businessHours: { start: '08:30', end: '18:00', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
    },
  });
  lineId = created.json?.line?.id;
  check('line created', created.status === 201, created.json?.line?.aor ?? created.text);
  globalThis.__lineExtension = extension;
}
{
  const doc = await call('/api/cantus/routing-document');
  check('routing document built', doc.json?.document?.version === 1, `revision ${doc.json?.revision}`);
  const names = (doc.json?.document?.routes ?? []).map((r) => r.name);
  check(
    'new line has an in-hours route',
    names.includes(`${globalThis.__lineExtension}-business-hours`),
    `${names.length} routes`,
  );
}
{
  const validation = await call('/api/cantus/validate', { method: 'POST', body: {} });
  check(
    'cantus accepts the document',
    validation.json?.ok === true,
    `verified by ${validation.json?.verifiedBy}`,
  );
  check('validation is not just local', validation.json?.verifiedBy === 'cantus');
}
{
  const decision = await call('/api/cantus/route-test', {
    method: 'POST',
    body: { to: 'voicemail@telno.local', from: 'console@telno.local' },
  });
  check(
    'route-test returns a decision',
    typeof decision.json?.raw === 'string' && decision.json.raw.includes('route'),
    (decision.json?.raw ?? '').split('\n').join(' | '),
  );
}
{
  const status = await call('/api/cantus/status');
  check('cantus reported available', status.json?.available === true, status.json?.version ?? '');
  check('cantus selftest passes', status.json?.selftest?.ok === true);
}

/* ---------------------------------------------------------------- settings */
section('settings and export');
{
  const patched = await call('/api/settings', {
    method: 'PATCH',
    body: { orgName: 'Telno', voiceNode: 'voice.telno.local', voicePort: 7443 },
  });
  check('settings update applied', patched.json?.settings?.voiceNode === 'voice.telno.local');
  const exported = await call('/api/export');
  check('export includes devices and routing', Array.isArray(exported.json?.devices) && Boolean(exported.json?.routing));
}

section('cleanup');
{
  const removed = await call(`/api/devices/${device.id}`, { method: 'DELETE' });
  check('smoke device removed', removed.status === 200, `HTTP ${removed.status}`);
  if (lineId) {
    const lineRemoved = await call(`/api/lines/${lineId}`, { method: 'DELETE' });
    check('smoke line removed', lineRemoved.status === 200, `HTTP ${lineRemoved.status}`);
  }
  await call('/api/auth/logout', { method: 'POST' });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
