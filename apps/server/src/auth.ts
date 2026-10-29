import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { db, now, recordEvent, verifyPassword } from './db.js';
import { isTrusted } from './security.js';
import type { SessionUser } from '@telno/shared';

const COOKIE = 'telno_session';

export interface SessionRow {
  id: string;
  username: string;
  created_at: string;
  expires_at: string;
}

export function sessionHours(): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('session.hours') as
    | { value: string }
    | undefined;
  const hours = Number(row?.value ?? 12);
  return Number.isFinite(hours) && hours > 0 ? hours : 12;
}

export function login(username: string, password: string): string | null {
  const row = db
    .prepare('SELECT username, password_hash FROM users WHERE username = ?')
    .get(username) as { username: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  const id = randomBytes(32).toString('base64url');
  const created = new Date();
  const expires = new Date(created.getTime() + sessionHours() * 3600_000);
  db.prepare('INSERT INTO sessions (id, username, created_at, expires_at) VALUES (?,?,?,?)').run(
    id,
    row.username,
    created.toISOString(),
    expires.toISOString(),
  );
  return id;
}

export function logout(sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function sessionUser(sessionId: string | undefined): SessionUser | null {
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT s.username, s.expires_at, u.display_name, u.role
         FROM sessions s JOIN users u ON u.username = s.username WHERE s.id = ?`,
    )
    .get(sessionId) as
    | { username: string; expires_at: string; display_name: string; role: 'admin' | 'operator' }
    | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  return { username: row.username, displayName: row.display_name, role: row.role };
}

/**
 * The Secure flag follows the scheme the client actually used, so a session
 * established over TLS is never sent back over plain HTTP, while a loopback
 * trial over http still works. Behind the bundled terminator, trustProxy makes
 * `req.protocol` report https from X-Forwarded-Proto.
 */
export function setSessionCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  reply.setCookie(COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: sessionHours() * 3600,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function sessionIdFrom(req: FastifyRequest): string | undefined {
  return req.cookies?.[COOKIE];
}

/**
 * Guards every console route. Mutations also require a matching Origin when the
 * browser supplies one, so a cross-site form post cannot ride a live session.
 */
export function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
): SessionUser | null {
  // Checked before the session: a valid cookie from an untrusted network is
  // still refused, so a stolen cookie is not portable off the trusted network.
  if (!isTrusted(req.ip)) {
    recordEvent('security', 'warn', `Console request refused from ${req.ip}.`, { ip: req.ip });
    reply.code(403).send({ error: `Console access is not allowed from ${req.ip}.` });
    return null;
  }

  const user = sessionUser(sessionIdFrom(req));
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return null;
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== req.headers.host) {
          reply.code(403).send({ error: 'cross-origin request refused' });
          return null;
        }
      } catch {
        reply.code(403).send({ error: 'cross-origin request refused' });
        return null;
      }
    }
  }
  return user;
}

/** Database lookup for the device bearer token, stored only as a digest. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function auditLoginFailure(username: string): void {
  db.prepare('INSERT INTO events (kind, level, message, created_at) VALUES (?,?,?,?)').run(
    'auth',
    'warn',
    `Failed sign-in attempt for "${username}".`,
    now(),
  );
}
