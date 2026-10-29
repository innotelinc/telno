import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceConfig, ModelKey, RoutingMode } from '@telno/shared';
import { DEVICE_MODELS, extensionProblem, isModelKey, normalizeExtension } from '@telno/shared';
import { AtaUnsupported } from './ata/device.js';
import { env } from './env.js';
import { forgetAdaptor, probeAdaptor, rebootAdaptor, setAdaptorAccount } from './ata/probe.js';
import { lineAssignment } from './estate.js';
import {
  db,
  hashPassword,
  now,
  recordEvent,
  setSetting,
  uid,
  verifyPassword,
  type DeviceRow,
  type LineRow,
} from './db.js';
import {
  auditLoginFailure,
  clearSessionCookie,
  login,
  logout,
  requireSession,
  sessionIdFrom,
  sessionUser,
  setSessionCookie,
  tokenDigest,
} from './auth.js';
import {
  buildDeviceConfig,
  deviceConfigSignature,
  etagFor,
  issueDeviceToken,
  issueEnrollmentCode,
  normaliseCode,
} from './provisioning.js';
import {
  cantusStatus,
  invalidateCantusStatus,
  pathProbe,
  routeTest,
  validateDocument,
} from './cantus.js';
import { isTrusted, setTrustedNetworks } from './security.js';
import {
  deviceConfigFor,
  overview,
  provisioningProfiles,
  routingSnapshot,
  settingsSnapshot,
  toDevice,
  toDirectoryEntry,
  toEvent,
  toLine,
} from './service.js';

type Body = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bad(reply: FastifyReply, message: string, code = 400): null {
  reply.code(code).send({ error: message });
  return null;
}

/**
 * Accept what someone actually pastes into a device address field.
 *
 * `http://192.168.1.45/`, `192.168.1.45:80` and a bare address all mean the
 * same box; anything that is not shaped like a host is refused rather than
 * stored, because it becomes a connection target later.
 */
function cleanHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withoutScheme = trimmed.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '';
  const bare = withoutScheme.replace(/^::ffff:/i, '').replace(/:\d+$/, '');
  if (!bare) return null;
  const hostname = /^[A-Za-z0-9._-]+$/.test(bare);
  const ipv6 = /^[0-9a-f:]+$/i.test(bare);
  return hostname || ipv6 ? bare : null;
}

/** Loopback is where this server lives, never where a device lives. */
const isLoopback = (host: string): boolean => host === '::1' || host.startsWith('127.');

function deviceRow(id: string): DeviceRow | undefined {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
}

function lineRow(id: string): LineRow | undefined {
  return db.prepare('SELECT * FROM lines WHERE id = ?').get(id) as LineRow | undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function listEvents(limit: number) {
  const rows = db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 200)) as unknown as Array<{
    id: number;
    kind: string;
    level: string;
    message: string;
    meta: string | null;
    created_at: string;
  }>;
  return rows.map(toEvent);
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function throttled(key: string): boolean {
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= 8;
}

function noteFailure(key: string): void {
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < Date.now()) {
    loginAttempts.set(key, { count: 1, resetAt: Date.now() + 5 * 60_000 });
    return;
  }
  entry.count += 1;
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------------ health */

  app.get('/api/health', async () => ({ ok: true, service: 'telno-control-plane', at: now() }));

  /* -------------------------------------------------------------------- auth */

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const username = str(body.username).trim();
    const password = str(body.password);
    const key = `${req.ip}:${username.toLowerCase()}`;

    // The allowlist is checked before any credential is looked at, so an
    // untrusted network learns nothing about whether an account exists.
    if (!isTrusted(req.ip)) {
      recordEvent('security', 'warn', `Console sign-in refused from ${req.ip}.`, { ip: req.ip });
      return bad(reply, `Console access is not allowed from ${req.ip}.`, 403);
    }

    if (!username || !password) return bad(reply, 'username and password are required');
    if (throttled(key)) return bad(reply, 'too many attempts, try again in a few minutes', 429);

    const sessionId = login(username, password);
    if (!sessionId) {
      noteFailure(key);
      auditLoginFailure(username);
      return bad(reply, 'incorrect username or password', 401);
    }
    loginAttempts.delete(key);
    setSessionCookie(reply, sessionId, req.protocol === 'https');
    const user = sessionUser(sessionId)!;
    recordEvent('auth', 'info', `${user.displayName} signed in.`, { username });
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const id = sessionIdFrom(req);
    if (id) logout(id);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/session', async (req, reply) => {
    if (!isTrusted(req.ip)) {
      return reply.code(403).send({ error: `Console access is not allowed from ${req.ip}.` });
    }
    const user = sessionUser(sessionIdFrom(req));
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    return { user };
  });

  app.post('/api/auth/password', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return;
    const body = (req.body ?? {}) as Body;
    const current = str(body.current);
    const next = str(body.next);
    if (next.length < 10) return bad(reply, 'new password must be at least 10 characters');
    const row = db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(user.username) as { password_hash: string } | undefined;
    if (!row || !verifyPassword(current, row.password_hash)) {
      return bad(reply, 'current password is incorrect', 403);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(
      hashPassword(next),
      user.username,
    );
    db.prepare('DELETE FROM sessions WHERE username = ?').run(user.username);
    clearSessionCookie(reply);
    recordEvent('auth', 'warn', `Password changed for ${user.username}; all sessions ended.`);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- overview */

  app.get('/api/overview', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    return overview();
  });

  /* ----------------------------------------------------------------- devices */

  app.get('/api/devices', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const rows = db
      .prepare('SELECT * FROM devices ORDER BY created_at DESC')
      .all() as unknown as DeviceRow[];
    return { devices: rows.map(toDevice) };
  });

  app.post('/api/devices', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const model = body.model;
    if (!isModelKey(model)) return bad(reply, 'model must be t750 or ht802');
    const label = str(body.label).trim();
    if (!label) return bad(reply, 'label is required');
    const serial =
      str(body.serial).trim() ||
      `${model.toUpperCase()}-2026-${String(Math.floor(Math.random() * 900000) + 100000)}`;
    const mac = str(body.mac).trim() || null;

    const exists = db.prepare('SELECT id FROM devices WHERE serial = ?').get(serial);
    if (exists) return bad(reply, `serial ${serial} is already enrolled`, 409);

    const id = uid();
    db.prepare(
      `INSERT INTO devices (id, serial, mac, model, label, location, status, config_version,
        config_issued_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, serial, mac, model, label, str(body.location).trim(), 'pending', 1, now(), now());

    const row = deviceRow(id)!;
    recordEvent('device', 'info', `Device ${DEVICE_MODELS[model].name} "${label}" added.`, {
      serial,
    });

    let enrollment: { code: string; expiresAt: string } | null = null;
    if (body.issueCode !== false) {
      const code = issueEnrollmentCode();
      db.prepare(
        'INSERT INTO enrollment_codes (id, code_hash, model, label, expires_at, created_at) VALUES (?,?,?,?,?,?)',
      ).run(
        uid(),
        tokenDigest(normaliseCode(code)),
        model,
        label,
        new Date(Date.now() + 60 * 60_000).toISOString(),
        now(),
      );
      enrollment = {
        code,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      };
      recordEvent('provisioning', 'info', `Enrollment code issued for ${serial}.`);
    }

    return reply.code(201).send({ device: toDevice(row), enrollment });
  });

  app.patch('/api/devices/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    const body = (req.body ?? {}) as Body;
    const label = body.label === undefined ? row.label : str(body.label).trim();
    const location = body.location === undefined ? row.location : str(body.location).trim();
    const status = body.status === undefined ? row.status : str(body.status, row.status);
    if (!['pending', 'online', 'offline', 'revoked'].includes(status)) {
      return bad(reply, 'invalid status');
    }
    if (!label) return bad(reply, 'label cannot be empty');
    let addr = row.addr;
    if (body.addr !== undefined) {
      const raw = str(body.addr).trim();
      const host = cleanHost(raw);
      if (raw && !host) return bad(reply, 'that is not a usable device address');
      addr = host && !isLoopback(host) ? host : null;
    }
    db.prepare('UPDATE devices SET label = ?, location = ?, status = ?, addr = ? WHERE id = ?').run(
      label,
      location,
      status,
      addr,
      id,
    );
    recordEvent('device', 'info', `Device "${label}" updated.`, { serial: row.serial, status });
    return { device: toDevice(deviceRow(id)!) };
  });

  app.delete('/api/devices/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    db.prepare('DELETE FROM devices WHERE id = ?').run(id);
    recordEvent('device', 'warn', `Device "${row.label}" removed.`, { serial: row.serial });
    return { ok: true };
  });

  app.post('/api/devices/:id/reconfigure', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    const next = row.config_version + 1;
    // A new revision gets a new issue time; the signature and ETag derive from it.
    db.prepare('UPDATE devices SET config_version = ?, config_issued_at = ? WHERE id = ?').run(
      next,
      now(),
      id,
    );
    recordEvent('provisioning', 'info', `Configuration revision ${next} issued to ${row.serial}.`);
    return { device: toDevice(deviceRow(id)!), config: deviceConfigFor(deviceRow(id)!) };
  });

  app.post('/api/devices/:id/rotate-token', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    const token = issueDeviceToken();
    db.prepare('UPDATE devices SET token_hash = ?, token_rotated_at = ? WHERE id = ?').run(
      tokenDigest(token),
      now(),
      id,
    );
    recordEvent('provisioning', 'warn', `Device token rotated for ${row.serial}.`, {
      serial: row.serial,
    });
    // Returned once, never stored in clear.
    return { token, device: toDevice(deviceRow(id)!) };
  });

  app.get('/api/devices/:id/config', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    const config = deviceConfigFor(row);
    return { config, etag: etagFor(config) };
  });

  /* ------------------------------------------------------------------- lines */

  app.get('/api/lines', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const rows = db
      .prepare('SELECT * FROM lines ORDER BY extension')
      .all() as unknown as LineRow[];
    return { lines: rows.map(toLine) };
  });

  app.post('/api/lines', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const problem = extensionProblem(body.extension);
    if (problem) return bad(reply, problem);
    const extension = normalizeExtension(body.extension) ?? str(body.extension).trim();
    const displayName = str(body.displayName).trim();
    if (!displayName) return bad(reply, 'display name is required');

    const mode = str(body.routingMode, 'business-hours') as RoutingMode;
    if (!['business-hours', 'always', 'forward', 'voicemail'].includes(mode)) {
      return bad(reply, 'invalid routing mode');
    }
    const settings = settingsSnapshot();
    const aorName = slug(str(body.aorName, displayName)) || `ext${extension}`;
    const aor = `${aorName}@${settings.domain}`;
    const deviceId = str(body.deviceId) || null;
    if (deviceId && !deviceRow(deviceId)) return bad(reply, 'assigned device not found');

    const duplicate = db
      .prepare('SELECT id FROM lines WHERE extension = ? OR aor = ?')
      .get(extension, aor);
    if (duplicate) return bad(reply, 'extension or address already in use', 409);

    const hours = (body.businessHours ?? {}) as Body;
    const id = uid();
    db.prepare(
      `INSERT INTO lines (id, extension, aor, display_name, device_id, account_slot, routing_mode,
        forward_to, bh_start, bh_end, bh_days, enabled, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      extension,
      aor,
      displayName,
      deviceId,
      Number(body.accountSlot ?? 1) || 1,
      mode,
      str(body.forwardTo).trim() || null,
      str(hours.start, '09:00'),
      str(hours.end, '17:00'),
      Array.isArray(hours.weekdays) ? (hours.weekdays as string[]).join(',') : 'mon,tue,wed,thu,fri',
      body.enabled === false ? 0 : 1,
      now(),
    );
    recordEvent('line', 'success', `Line ${extension} (${displayName}) created with ${mode} routing.`);
    return reply.code(201).send({ line: toLine(lineRow(id)!) });
  });

  app.patch('/api/lines/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = lineRow(id);
    if (!row) return bad(reply, 'line not found', 404);
    const body = (req.body ?? {}) as Body;
    const deviceId = body.deviceId === undefined ? row.device_id : str(body.deviceId) || null;
    if (deviceId && !deviceRow(deviceId)) return bad(reply, 'assigned device not found');
    const mode = (body.routingMode === undefined
      ? row.routing_mode
      : str(body.routingMode)) as RoutingMode;
    if (!['business-hours', 'always', 'forward', 'voicemail'].includes(mode)) {
      return bad(reply, 'invalid routing mode');
    }
    const hours = (body.businessHours ?? {}) as Body;
    db.prepare(
      `UPDATE lines SET display_name = ?, device_id = ?, account_slot = ?, routing_mode = ?,
        forward_to = ?, bh_start = ?, bh_end = ?, bh_days = ?, enabled = ? WHERE id = ?`,
    ).run(
      body.displayName === undefined ? row.display_name : str(body.displayName).trim() || row.display_name,
      deviceId,
      Number(body.accountSlot ?? row.account_slot) || row.account_slot,
      mode,
      body.forwardTo === undefined ? row.forward_to : str(body.forwardTo).trim() || null,
      str(hours.start, row.bh_start),
      str(hours.end, row.bh_end),
      Array.isArray(hours.weekdays) ? (hours.weekdays as string[]).join(',') : row.bh_days,
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      id,
    );
    recordEvent('line', 'info', `Line ${row.extension} updated.`);
    return { line: toLine(lineRow(id)!) };
  });

  app.delete('/api/lines/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = lineRow(id);
    if (!row) return bad(reply, 'line not found', 404);
    db.prepare('DELETE FROM lines WHERE id = ?').run(id);
    recordEvent('line', 'warn', `Line ${row.extension} deleted.`);
    return { ok: true };
  });

  /* --------------------------------------------------------------- directory */

  app.get('/api/directory', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const rows = db
      .prepare('SELECT * FROM directory ORDER BY favorite DESC, display_name')
      .all() as Array<{
      id: string;
      display_name: string;
      number: string;
      extension: string | null;
      email: string | null;
      company: string | null;
      favorite: number;
      notes: string | null;
      created_at: string;
    }>;
    return { entries: rows.map(toDirectoryEntry) };
  });

  app.post('/api/directory', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const displayName = str(body.displayName).trim();
    const number = str(body.number).trim();
    if (!displayName) return bad(reply, 'name is required');
    if (!number) return bad(reply, 'number is required');
    const id = uid();
    db.prepare(
      `INSERT INTO directory (id, display_name, number, extension, email, company, favorite, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      displayName,
      number,
      str(body.extension).trim() || null,
      str(body.email).trim() || null,
      str(body.company).trim() || null,
      body.favorite ? 1 : 0,
      str(body.notes).trim() || null,
      now(),
    );
    recordEvent('directory', 'info', `Directory entry "${displayName}" added.`);
    const row = db.prepare('SELECT * FROM directory WHERE id = ?').get(id) as Parameters<
      typeof toDirectoryEntry
    >[0];
    return reply.code(201).send({ entry: toDirectoryEntry(row) });
  });

  app.patch('/api/directory/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const existing = db
      .prepare('SELECT * FROM directory WHERE id = ?')
      .get(id) as Parameters<typeof toDirectoryEntry>[0] | undefined;
    if (!existing) return bad(reply, 'entry not found', 404);
    const body = (req.body ?? {}) as Body;
    db.prepare(
      `UPDATE directory SET display_name = ?, number = ?, extension = ?, email = ?, company = ?,
        favorite = ?, notes = ? WHERE id = ?`,
    ).run(
      body.displayName === undefined ? existing.display_name : str(body.displayName).trim(),
      body.number === undefined ? existing.number : str(body.number).trim(),
      body.extension === undefined ? existing.extension : str(body.extension).trim() || null,
      body.email === undefined ? existing.email : str(body.email).trim() || null,
      body.company === undefined ? existing.company : str(body.company).trim() || null,
      body.favorite === undefined ? existing.favorite : body.favorite ? 1 : 0,
      body.notes === undefined ? existing.notes : str(body.notes).trim() || null,
      id,
    );
    const row = db.prepare('SELECT * FROM directory WHERE id = ?').get(id) as Parameters<
      typeof toDirectoryEntry
    >[0];
    return { entry: toDirectoryEntry(row) };
  });

  app.delete('/api/directory/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const existing = db.prepare('SELECT display_name FROM directory WHERE id = ?').get(id) as
      | { display_name: string }
      | undefined;
    if (!existing) return bad(reply, 'entry not found', 404);
    db.prepare('DELETE FROM directory WHERE id = ?').run(id);
    recordEvent('directory', 'warn', `Directory entry "${existing.display_name}" removed.`);
    return { ok: true };
  });

  /* ------------------------------------------------------------------ events */

  app.get('/api/events', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const query = req.query as { limit?: string };
    return { events: listEvents(Number(query.limit ?? 40)) };
  });

  /* ------------------------------------------------------------ provisioning */

  app.get('/api/provisioning', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const codes = db
      .prepare('SELECT * FROM enrollment_codes ORDER BY created_at DESC LIMIT 25')
      .all() as unknown as Array<{
      id: string;
      model: ModelKey;
      label: string;
      expires_at: string;
      used_at: string | null;
      created_at: string;
    }>;
    return {
      profiles: provisioningProfiles(),
      routing: routingSnapshot(),
      codes: codes.map((c) => ({
        id: c.id,
        // The clear code is never stored; only its digest is.
        code: '••••-••••',
        model: c.model,
        label: c.label,
        expiresAt: c.expires_at,
        usedAt: c.used_at,
        createdAt: c.created_at,
      })),
      settings: settingsSnapshot(),
    };
  });

  app.post('/api/provisioning/codes', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const model = body.model;
    if (!isModelKey(model)) return bad(reply, 'model must be t750 or ht802');
    const ttl = Math.min(Math.max(Number(body.ttlMinutes ?? 60) || 60, 5), 1440);
    const code = issueEnrollmentCode();
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    const id = uid();
    db.prepare(
      'INSERT INTO enrollment_codes (id, code_hash, model, label, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, tokenDigest(normaliseCode(code)), model, str(body.label, 'Unassigned'), expiresAt, now());
    recordEvent('provisioning', 'info', `Enrollment code issued for ${model} (${ttl} min).`);
    return reply.code(201).send({ id, code, model, expiresAt });
  });

  app.delete('/api/provisioning/codes/:id', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    db.prepare('DELETE FROM enrollment_codes WHERE id = ?').run(id);
    return { ok: true };
  });

  /* ------------------------------------------------------------------ cantus */

  app.get('/api/cantus/status', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const query = req.query as { refresh?: string };
    if (query.refresh) invalidateCantusStatus();
    return cantusStatus(Boolean(query.refresh));
  });

  app.get('/api/cantus/routing-document', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    return routingSnapshot();
  });

  app.post('/api/cantus/validate', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const doc = body.document ?? routingSnapshot().document;
    const result = await validateDocument(doc as ReturnType<typeof routingSnapshot>['document']);
    recordEvent(
      'cantus',
      result.ok ? 'success' : 'error',
      result.ok
        ? `Routing document accepted by cantus (${result.verifiedBy}).`
        : 'Routing document rejected.',
      { verifiedBy: result.verifiedBy },
    );
    return result;
  });

  app.post('/api/cantus/route-test', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const to = str(body.to).trim();
    if (!to) return bad(reply, 'a destination address is required');
    const snapshot = routingSnapshot();
    const decision = await routeTest(snapshot.document, {
      to,
      from: str(body.from, 'console@telno.local'),
      hour: str(body.hour).trim() || undefined,
    });
    return { ...decision, revision: snapshot.revision };
  });

  app.post('/api/cantus/probe', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const nat = str(body.nat, 'symmetric');
    if (!['none', 'cone', 'symmetric'].includes(nat)) return bad(reply, 'invalid NAT mode');
    const result = await pathProbe({
      nat: nat as 'none' | 'cone' | 'symmetric',
      rebind: Boolean(body.rebind),
    });
    recordEvent('cantus', result.ok ? 'success' : 'error', `Path probe ${result.ok ? 'passed' : 'failed'} (nat=${nat}, path=${result.path ?? 'none'}, ${result.frames} frames).`);
    return result;
  });

  /* ---------------------------------------------------------------- settings */

  app.get('/api/settings', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    return { settings: settingsSnapshot() };
  });

  app.patch('/api/settings', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const body = (req.body ?? {}) as Body;
    const map: Record<string, string> = {
      orgName: 'org.name',
      domain: 'org.domain',
      timezone: 'org.timezone',
      voiceNode: 'voice.node',
      relay: 'voice.relay',
      ntp: 'voice.ntp',
      sipEdge: 'voice.sipEdge',
    };
    for (const [field, key] of Object.entries(map)) {
      if (body[field] !== undefined) setSetting(key, str(body[field]).trim());
    }
    if (body.voicePort !== undefined) setSetting('voice.port', String(Number(body.voicePort) || 7443));
    if (body.sipPort !== undefined) {
      const port = Number(body.sipPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return bad(reply, 'sipPort must be 1-65535');
      setSetting('voice.sipPort', String(port));
    }
    if (body.requireSignedConfig !== undefined) {
      setSetting('provisioning.requireSignature', body.requireSignedConfig ? '1' : '0');
    }
    if (body.sessionHours !== undefined) {
      setSetting('session.hours', String(Math.min(Math.max(Number(body.sessionHours) || 12, 1), 168)));
    }
    if (body.trustedNetworks !== undefined) {
      const update = setTrustedNetworks(str(body.trustedNetworks));
      if (!update.ok) return bad(reply, update.error ?? 'invalid network list');
      recordEvent('security', 'warn', `Console allowlist updated: ${update.value}.`, {
        trustedNetworks: update.value,
      });
    }
    recordEvent('settings', 'info', 'Platform settings updated.');
    return { settings: settingsSnapshot() };
  });

  /* ------------------------------------------------------- device-facing API */
  /*
   * Deliberately outside /api: these are the only endpoints a device may reach,
   * they are authenticated by device token rather than a console session, and
   * they never return console data.
   */

  app.post('/prov/v1/enroll', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const code = normaliseCode(str(body.code));
    const serial = str(body.serial).trim();
    if (!code || !serial) return bad(reply, 'enrollment code and serial are required');

    const record = db
      .prepare(
        `SELECT * FROM enrollment_codes
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(tokenDigest(code), now()) as
      | { id: string; model: ModelKey; label: string; expires_at: string }
      | undefined;
    if (!record) return bad(reply, 'enrollment code is invalid, used or expired', 401);

    let row = db.prepare('SELECT * FROM devices WHERE serial = ?').get(serial) as
      | DeviceRow
      | undefined;

    if (row && row.model !== record.model) {
      return bad(reply, `serial ${serial} is registered as ${DEVICE_MODELS[row.model].name}`, 409);
    }
    if (row && row.status === 'revoked') return bad(reply, 'device is revoked', 403);

    const token = issueDeviceToken();
    const timestamp = now();
    // The address it enrolled from is where its own web console answers, which
    // is the only way the platform can reach an analog adaptor afterwards.
    const source = cleanHost(req.ip ?? '');
    const addr = source && !isLoopback(source) ? source : null;
    if (!row) {
      const id = uid();
      db.prepare(
        `INSERT INTO devices (id, serial, mac, model, label, location, status, firmware,
          config_version, config_issued_at, token_hash, last_seen_at, last_enrolled_at, created_at, addr)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        serial,
        str(body.mac).trim() || null,
        record.model,
        record.label || `${record.model.toUpperCase()} ${serial.slice(-4)}`,
        '',
        'online',
        str(body.firmware).trim() || null,
        1,
        // Stamped once so the signed document and its ETag stay identical until
        // the configuration actually changes; without it every poll re-downloads.
        timestamp,
        tokenDigest(token),
        timestamp,
        timestamp,
        timestamp,
        addr,
      );
      row = deviceRow(id)!;
    } else {
      db.prepare(
        `UPDATE devices SET status = 'online', token_hash = ?, mac = COALESCE(?, mac),
          firmware = COALESCE(?, firmware), config_issued_at = COALESCE(config_issued_at, ?),
          last_seen_at = ?, last_enrolled_at = ?, addr = COALESCE(?, addr) WHERE id = ?`,
      ).run(
        tokenDigest(token),
        str(body.mac).trim() || null,
        str(body.firmware).trim() || null,
        timestamp,
        timestamp,
        timestamp,
        addr,
        row.id,
      );
      row = deviceRow(row.id)!;
    }

    db.prepare('UPDATE enrollment_codes SET used_at = ? WHERE id = ?').run(timestamp, record.id);
    recordEvent('provisioning', 'success', `Device ${row.serial} enrolled with a fresh token.`, {
      model: row.model,
    });

    return reply.code(201).send({
      deviceId: row.id,
      serial: row.serial,
      model: row.model,
      token,
      configVersion: row.config_version,
      // Absolute, so a device that enrolled over the plain-HTTP listener keeps
      // using the address it actually reached rather than guessing a scheme.
      configUrl: `${req.protocol}://${req.host}/prov/v1/config`,
      pollSeconds: 900,
    });
  });

  const configHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return bad(reply, 'device token required', 401);
    const row = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenDigest(token)) as
      | DeviceRow
      | undefined;
    if (!row) return bad(reply, 'device token is not recognised', 401);
    if (row.status === 'revoked') return bad(reply, 'device is revoked', 403);

    const config: DeviceConfig = deviceConfigFor(row);
    const etag = etagFor(config);
    const ifNoneMatch = req.headers['if-none-match'];
    const timestamp = now();
    db.prepare(
      "UPDATE devices SET status = 'online', last_seen_at = ? WHERE id = ?",
    ).run(timestamp, row.id);

    reply
      .header('ETag', etag)
      .header('X-Telno-Config-Version', String(config.version))
      .header('X-Telno-Key-Id', config.keyId)
      .header('X-Telno-Signature', config.signature)
      .header('Cache-Control', 'no-store');

    if (ifNoneMatch && ifNoneMatch === etag) {
      return reply.code(304).send();
    }
    return reply.send(config);
  };

  app.get('/prov/v1/config', configHandler);
  app.post('/prov/v1/config', configHandler);

  app.post('/prov/v1/report', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return bad(reply, 'device token required', 401);
    const row = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenDigest(token)) as
      | DeviceRow
      | undefined;
    if (!row) return bad(reply, 'device token is not recognised', 401);

    const body = (req.body ?? {}) as Body;
    const applied = Number(body.configVersion ?? row.applied_version ?? 0) || null;
    const firmware = str(body.firmware).trim() || row.firmware;
    db.prepare(
      "UPDATE devices SET applied_version = ?, firmware = ?, status = 'online', last_seen_at = ? WHERE id = ?",
    ).run(applied, firmware, now(), row.id);

    if (applied && applied < row.config_version) {
      recordEvent('provisioning', 'warn', `${row.serial} is on revision ${applied}; ${row.config_version} is current.`, {
        serial: row.serial,
      });
    }
    return { ok: true, configVersion: row.config_version };
  });

  /* ------------------------------------------------------------------- misc */

  app.get('/api/export', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const payload = {
      exportedAt: now(),
      settings: settingsSnapshot(),
      devices: (db.prepare('SELECT * FROM devices').all() as unknown as DeviceRow[]).map(toDevice),
      lines: (db.prepare('SELECT * FROM lines').all() as unknown as LineRow[]).map(toLine),
      routing: routingSnapshot(),
    };
    reply.header('Content-Disposition', 'attachment; filename="telno-export.json"');
    return payload;
  });

  /** Verifies that a device's copy of the document matches the signature we issued. */
  app.post('/api/devices/:id/verify-config', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const row = deviceRow(id);
    if (!row) return bad(reply, 'device not found', 404);
    const config = deviceConfigFor(row);
    return {
      keyId: config.keyId,
      version: config.version,
      signatureMatches: deviceConfigSignature(config) === config.signature,
    };
  });

  /* ---------------------------------------------------- analog adaptor (ATA) */
  /*
   * The adaptor is read through its own console, not proxied to it: that page is
   * served by a web server that writes malformed HTTP, has no idea what a Telno
   * extension is, and describes a port as a table cell. The platform reads the
   * box and answers with normal JSON.
   *
   * Two rules keep this safe to point at real hardware: the admin password is
   * read from the environment and never returned by any endpoint, and nothing
   * here retries a login — five refusals cost fifteen minutes of that console,
   * so a locked device is reported as locked and left alone.
   */

  const adaptorTarget = (id: string, reply: FastifyReply): { host: string } | null => {
    const row = deviceRow(id);
    if (!row) {
      bad(reply, 'device not found', 404);
      return null;
    }
    if (row.model !== 'ht802') {
      bad(reply, 'only the analog adaptor has a console of its own to read', 400);
      return null;
    }
    if (!row.addr) {
      bad(
        reply,
        'this adaptor has no LAN address yet: it is taken from the address it enrolls from, or set it on the device',
        409,
      );
      return null;
    }
    // A missing password is not a reason to refuse to look: three of the box's
    // endpoints answer without a session, and "it is alive, unlocked, and has
    // no SIP profile" is what an operator needs while fixing the credential.
    // No login attempt is sent without one, so this costs no lockout budget.
    return { host: row.addr };
  };

  app.get('/api/devices/:id/ata', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const target = adaptorTarget(id, reply);
    if (!target) return null;
    const query = req.query as { refresh?: string };
    const view = await probeAdaptor(target, { refresh: query.refresh === '1' });
    return { adaptor: view, passwordConfigured: Boolean(env.ataPassword) };
  });

  /*
   * Put an extension on one of the unit's lines, or replace the one it holds.
   *
   * This is the write the console could not do before: the account fields it was
   * aiming at (`account.1.sip.user_id`) are read-only projections, so every write
   * was acknowledged and dropped. The driver now writes the parameters the unit
   * actually registers from and reports what it read back — never just that the
   * device said `right`.
   *
   * The secret is taken from the request and written to the box; it is never
   * echoed, logged or stored by the platform.
   */
  app.post('/api/devices/:id/ata/accounts', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const target = adaptorTarget(id, reply);
    if (!target) return null;
    if (!env.ataPassword) {
      return bad(
        reply,
        'TELNO_ATA_PASSWORD is not configured, so the platform cannot sign in to set this line.',
        409,
      );
    }

    const body = (req.body ?? {}) as Body;
    const account = Number(body.account ?? 1);
    // The unit takes any string and then quietly fails to register it, so a typo
    // is refused here, before a login attempt is spent proving it. A console
    // form may send the number as a number; shared's rule accepts both.
    const raw = body.extension ?? body.user;
    const user = normalizeExtension(raw);
    if (!user) {
      return bad(reply, extensionProblem(raw) ?? 'an extension is required', 400);
    }

    // The box reports a line as registered whether or not the extension is this
    // port's to use, so the estate is asked before the write and the operator is
    // told afterwards. Deliberately not a refusal: an operator may be ahead of
    // the line inventory, and the hardware already holds numbers the platform
    // learned about later. A slot that is not a number would match nothing and
    // invent a warning, so it is only asked when it means something; the driver
    // owns the upper bound, because firmware knows how many slots it has.
    const assignment =
      Number.isInteger(account) && account >= 1
        ? lineAssignment(db, { extension: user, deviceId: id, slot: account })
        : { warning: null, owner: null };
    const warning = assignment.warning;

    try {
      const result = await setAdaptorAccount(target, {
        account,
        user,
        authId: str(body.authId) || undefined,
        secret: str(body.secret) || undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
      });
      // The ledger has to survive being asked "what was on that line before?" —
      // overwriting a live identity is exactly the mistake this will be read for
      // afterwards, and "was set to 202" alone cannot answer it.
      const was = result.previous;
      const summary =
        was === null
          ? `was set to ${user} (the line could not be read beforehand)`
          : was.user === result.user
            ? `was rewritten as ${user}, unchanged,`
            : `was changed from ${was.user ?? 'an empty slot'} to ${user}`;
      recordEvent(
        'device',
        result.applied && !warning ? 'info' : 'warn',
        `Adaptor line ${result.account} at ${target.host} ${summary} and read back as ${result.user ?? 'empty'}.${warning ? ` ${warning}` : ''}`,
        {
          deviceId: id,
          account: result.account,
          from: was?.user ?? null,
          fromAuthId: was?.authId ?? null,
          fromName: was?.name ?? null,
          fromRegistration: was?.registration ?? null,
          readableBefore: was !== null,
          unknownExtension: assignment.owner === null,
          assignedTo: assignment.owner,
          to: result.user,
        },
      );
      return { ...result, warning };
    } catch (err: unknown) {
      if (err instanceof AtaUnsupported) return bad(reply, err.message, 409);
      forgetAdaptor(target.host);
      // A refused, cooled-down or unconfigured credential is a state the operator
      // has to resolve; retrying cannot. Answering 502 would read as an outage.
      const code = (err as { code?: unknown }).code;
      if (code === 'ata_auth' || code === 'ata_locked' || code === 'ata_unconfigured') {
        return bad(reply, err instanceof Error ? err.message : 'the adaptor refused the write', 409);
      }
      return bad(reply, err instanceof Error ? err.message : 'the adaptor did not accept the write', 502);
    }
  });

  app.post('/api/devices/:id/ata/reboot', async (req, reply) => {
    if (!requireSession(req, reply)) return;
    const { id } = req.params as { id: string };
    const target = adaptorTarget(id, reply);
    if (!target) return null;
    // A reboot is the one action that needs the session, so say why plainly.
    if (!env.ataPassword) {
      return bad(reply, 'TELNO_ATA_PASSWORD is not configured, so the platform cannot sign in to reboot this adaptor.', 409);
    }
    try {
      const result = await rebootAdaptor(target);
      recordEvent('device', 'warn', `Adaptor at ${target.host} was told to reboot.`, { deviceId: id });
      return { ...result, cached: false };
    } catch (err: unknown) {
      if (err instanceof AtaUnsupported) return bad(reply, err.message, 409);
      forgetAdaptor(target.host);
      return bad(reply, err instanceof Error ? err.message : 'the adaptor did not accept the reboot', 502);
    }
  });

  app.log.info('Telno control-plane routes registered');
}
