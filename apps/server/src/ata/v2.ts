import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import {
  emptyOverview,
  type AtaAccount,
  type AtaOverview,
  type AtaPort,
  type AtaTarget,
} from './types.js';

/**
 * The HT802 V2 — a different box from the V1 in every way that matters.
 *
 * Measured on firmware 1.0.21.33 (lighttpd 1.4.55, GWT single-page console):
 *
 *  - HTTP answers `301 Location: https://…`, so the console is TLS-only on 443
 *    with a self-signed certificate. Plain HTTP never serves anything.
 *  - Login is `POST /cgi-bin/dologin` with **`username` and `password` as plain
 *    form fields** — not the V1's base64 `P2`. A plain-text password is what the
 *    console's own client code builds, and `P2=` is rejected as `wrongN`.
 *  - The reply is JSON: `{"response":"success","body":{"sid":"…","role":"admin"}}`
 *    plus `session-identity` / `session-role` cookies.
 *  - Reads are `POST /cgi-bin/api.values.get` with a **colon-separated list in a
 *    `request` field and `&sid=` appended to the same body**. Without the `sid`
 *    the call still answers `success` and every value is `""`.
 *  - That is the trap: a stale session also answers `success` with all values
 *    empty. Empty is therefore never "the device has nothing"; it means "ask
 *    again with a fresh session". This client re-authenticates once and only
 *    then admits it could not read.
 */

const DEFAULT_FIELDS = [
  'P68', // software version
  'P271', // FXS 1 account active
  'P401', // FXS 2 account active
  'P35', // FXS 1 SIP user id
  'P735', // FXS 2 SIP user id
  'P47', // FXS 1 SIP server
  'P747', // FXS 2 SIP server
  'P40', // FXS 1 local SIP port
  'P740', // FXS 2 local SIP port
  'P199', // uptime, as the unit reports it (` 02:29:04 up 27 days`)
  'serial_number',
];

export class AtaV2Error extends Error {
  override readonly name = 'AtaV2Error';
  readonly code: string;

  constructor(message: string, code = 'ata_v2') {
    super(message);
    this.code = code;
  }
}

interface CallOptions {
  host: string;
  port: number;
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

function call({ host, port, method, path, headers = {}, body = '', timeoutMs = 6000 }: CallOptions) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const request = https.request(
      {
        host,
        port,
        method,
        path,
        // Every unit ships a self-signed certificate for the same CN, so there
        // is nothing to verify. Access is controlled by the LAN and the password.
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          Accept: '*/*',
          ...(payload.length
            ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(payload.length) }
            : {}),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text }));
      },
    );
    request.on('timeout', () =>
      request.destroy(new AtaV2Error(`${host}:${port} did not answer in time`, 'ata_unreachable')),
    );
    request.on('error', (err: Error) =>
      reject(err instanceof AtaV2Error ? err : new AtaV2Error(`${host}:${port} refused the connection`, 'ata_unreachable')),
    );
    if (payload.length) request.write(payload);
    request.end();
  });
}

interface Reply {
  response?: string;
  body?: unknown;
}

const parseReply = (text: string): Reply | null => {
  try {
    const parsed: unknown = JSON.parse(String(text || '').trim());
    return parsed && typeof parsed === 'object' ? (parsed as Reply) : null;
  } catch {
    return null;
  }
};

export interface AtaV2Options {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export class AtaV2 {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private cookie = '';
  private sid = '';

  constructor({ host, port = 443, username = 'admin', password = '', timeoutMs = 6000 }: AtaV2Options) {
    this.host = host;
    this.port = Number(port) || 443;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeoutMs = timeoutMs;
  }

  get label(): string {
    return `${this.host}:${this.port}`;
  }

  target(): AtaTarget {
    return { host: this.host, port: this.port, label: this.label };
  }

  /** Is this the TLS/GWT console rather than the old mini_httpd one? */
  async detect(): Promise<boolean> {
    try {
      const res = await call({ host: this.host, port: this.port, method: 'GET', path: '/', timeoutMs: this.timeoutMs });
      return /Loading Web Application|webapp\.nocache\.js|lighttpd/i.test(res.text) || res.status === 200;
    } catch {
      return false;
    }
  }

  async #post(path: string, form: string): Promise<{ status: number; text: string; json: Reply | null }> {
    const res = await call({
      host: this.host,
      port: this.port,
      method: 'POST',
      path,
      body: form,
      headers: this.cookie ? { Cookie: this.cookie } : {},
      timeoutMs: this.timeoutMs,
    });
    const cookies = ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .map((line) => line.split(';')[0]?.trim() ?? '')
      .filter(Boolean);
    if (cookies.length) this.cookie = cookies.join('; ');
    return { status: res.status, text: res.text, json: parseReply(res.text) };
  }

  async login(): Promise<{ ok: true; role: string | null; defaultAuth: boolean }> {
    if (!this.password) throw new AtaV2Error('No admin password is configured for this device', 'ata_auth');
    const body = `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    const res = await this.#post('/cgi-bin/dologin', body);
    const payload = res.json;
    const payloadBody = (payload?.body ?? null) as { sid?: unknown; role?: unknown; defaultAuth?: unknown } | null;
    if (payload?.response === 'success' && payloadBody?.sid) {
      this.sid = String(payloadBody.sid);
      return {
        ok: true,
        role: payloadBody.role === undefined ? null : String(payloadBody.role),
        defaultAuth: Boolean(payloadBody.defaultAuth),
      };
    }
    // `wrongN` carries the attempts left, which is the one number worth passing on.
    const detail = typeof payload?.body === 'string' ? payload.body : '';
    const left = /^wrong(\d+)$/i.exec(detail)?.[1];
    throw new AtaV2Error(
      left
        ? `The device did not recognise that admin password (${left} attempt${left === '1' ? '' : 's'} left before a lockout)`
        : 'The device did not open a session for that password',
      'ata_auth',
    );
  }

  /** Read named parameters. Empty values are re-read once with a fresh session. */
  async values(names: string[] = DEFAULT_FIELDS): Promise<{ values: Record<string, unknown>; stale: boolean }> {
    const read = async () => {
      const form = `request=${names.join(':')}&sid=${encodeURIComponent(this.sid)}`;
      const res = await this.#post('/cgi-bin/api.values.get', form);
      const body = res.json?.body;
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
    };

    // A stale session answers success with blanks, and it does so *partially*:
    // observed reads returned the firmware string while every port field came
    // back empty. So the test is not "is everything blank" but "are the fields
    // that cannot be blank". P68 and the serial number exist on every unit.
    const blind = (body: Record<string, unknown> | null) =>
      !body ||
      (body.P68 !== undefined && body.P68 === '') ||
      (body.serial_number !== undefined && body.serial_number === '');

    if (!this.sid) await this.login();
    let body = await read();
    if (blind(body)) {
      await this.login();
      body = await read();
    }
    return { values: body ?? {}, stale: blind(body) };
  }

  async overview(): Promise<AtaOverview> {
    const started = Date.now();
    const view = emptyOverview(this.target(), 'v2');
    view.sources = { api: 'values.get' };

    try {
      await this.login();
      view.reachable = true;
      view.authenticated = true;
    } catch (err: unknown) {
      const code = err instanceof AtaV2Error ? err.code : '';
      view.reachable = code !== 'ata_unreachable';
      view.state = code === 'ata_auth' ? 'auth' : 'unreachable';
      view.notes.push(err instanceof Error ? err.message : 'the device did not answer');
      view.tookMs = Date.now() - started;
      return view;
    }

    const { values, stale } = await this.values();
    if (stale) {
      view.state = 'stale';
      view.notes.push(
        'The device accepted the session but returned no values at all, twice. Its console is running but its configuration is not readable in this state.',
      );
      view.tookMs = Date.now() - started;
      return view;
    }

    view.state = 'online';
    // Trim before testing emptiness. The unit pads some values with spaces
    // (` 02:29:04 up 27 days`), and a value of " " is truthy — which briefly
    // made a port with no SIP user report as "configured".
    const value = (key: string): string | null => {
      const raw = values[key];
      if (raw === undefined || raw === null) return null;
      const text = String(raw).trim();
      return text === '' ? null : text;
    };
    const active = (key: string) => String(values[key] ?? '').trim() === '1';

    const uptimeRaw = value('P199');
    const since = uptimeRaw ? /\bup\s+(.+)$/i.exec(uptimeRaw) : null;

    view.identity = {
      model: 'HT802',
      firmware: value('P68'),
      hardware: null,
      bootloader: null,
      serial: value('serial_number'),
      mac: null,
      // The unit reports ` 02:29:04 up 27 days`. Keep the part a person cares
      // about; the clock reading is noise in a stat card.
      uptime: uptimeRaw ? (since?.[1]?.trim() ?? uptimeRaw) : null,
      ip: this.host,
    };

    const ports: AtaPort[] = [];
    const accounts: AtaAccount[] = [];
    const map = [
      { port: 1, on: 'P271', user: 'P35', server: 'P47', local: 'P40' },
      { port: 2, on: 'P401', user: 'P735', server: 'P747', local: 'P740' },
    ];
    for (const entry of map) {
      const enabled = active(entry.on);
      const user = value(entry.user);
      const server = value(entry.server);
      ports.push({
        port: entry.port,
        enabled,
        hook: null,
        // The API exposes configuration, not live registration: saying
        // "registered" here would be inventing a fact.
        registration: user ? (enabled ? 'configured' : 'disabled') : 'no SIP user',
        sipUser: user,
      });
      if (user || server) {
        accounts.push({
          port: entry.port,
          user,
          server,
          localPort: value(entry.local),
          active: enabled ? '1' : '0',
          name: null,
        });
      }
    }
    view.ports = ports;
    view.accounts = accounts;
    view.tookMs = Date.now() - started;
    return view;
  }

  /** Reboot is not wired for this firmware: it lives behind an unverified console operation. */
  async reboot(): Promise<{ status: number; accepted: boolean }> {
    throw new AtaV2Error(
      'Reboot is not wired for this firmware yet: its restart lives behind a numeric console operation that has not been verified.',
      'ata_unsupported',
    );
  }
}

export default AtaV2;
