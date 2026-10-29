import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import {
  AUTH_BACKOFF,
  AUTH_COOLDOWN_MS,
  credentialKey,
  formatWait,
  memoryGuard,
  type RefusalGuard,
} from './ht802.js';
import {
  emptyOverview,
  type AtaAccount,
  type AtaAccountWrite,
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

/**
 * Where the SIP identity actually lives on this firmware.
 *
 * The console's own pages are the source: `json/contents/dect_acct_settings.js`
 * (fetched from the unit, not guessed) lists the columns of the account table as
 * SIP_USER, SIP_AUTH, SIP_PASS, SIP_NAME, SIP_PROFILE — and every cell is either
 * a `P` number or a dotted name. Reading both settled which one is writable:
 *
 *   P4060 … P4069   SIP user id      the value the unit registers as
 *   P4090 … P4099   authenticate id
 *   P4120 … P4129   authenticate password (reads back in clear text)
 *   P4180 … P4189   display name
 *   P4921 … P4930   registration state   1 = registered, 2 = not registered
 *
 * The dotted form (`account.1.sip.user_id`) is a projection of the same rows:
 * it reads back correctly, and a write to it answers `{"status":"right"}` while
 * changing nothing. That is the trap this map exists to avoid — the platform
 * spent a while writing names that the firmware silently ignored.
 *
 * Account 1 is the unit's first line, and on a two-port unit that is the first
 * port; the same index runs across all five blocks, which is why the tables
 * start at 4060/4090/4120/4180/4921 rather than at round numbers.
 */
export const ACCOUNT_SLOTS = 10;
export const ACCOUNT_BLOCK = { user: 4060, authId: 4090, secret: 4120, name: 4180 } as const;
export const ACCOUNT_STATUS = 4921;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  '1': 'registered',
  '2': 'not registered',
};

/** `P4060` for account 1, `P4061` for account 2, … */
export const accountSlot = (block: number, index: number): string => `P${block + index}`;

const IDENTITY_FIELDS = [
  'P68', // software version
  'P199', // uptime, as the unit reports it (` 02:29:04 up 27 days`)
  'serial_number',
  'phone_model', // the unit's own model name; see `overview()`
];

const PROFILE_FIELDS = [1, 2, 3, 4].map((n) => `profile.${n}.sip.server.1.address`);

/** Every field the adaptor view needs, in one round trip. */
export const accountFields = (): string[] => {
  const names: string[] = [...IDENTITY_FIELDS, ...PROFILE_FIELDS];
  for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
    names.push(accountSlot(ACCOUNT_BLOCK.user, i), accountSlot(ACCOUNT_BLOCK.authId, i), accountSlot(ACCOUNT_BLOCK.name, i));
    names.push(`account.${i + 1}.sip.profile_id`, `P${ACCOUNT_STATUS + i}`);
  }
  // The password is never read: the API answers it in clear text, and nothing
  // in this view needs it.
  return names;
};

/** Named parameters read at idle speed; kept as a list so callers can extend it. */
const DEFAULT_FIELDS = accountFields();

export class AtaV2Error extends Error {
  override readonly name = 'AtaV2Error';
  readonly code: string;

  constructor(message: string, code = 'ata_v2') {
    super(message);
    this.code = code;
  }
}

/**
 * What a refused password costs on this firmware.
 *
 * The TLS console counts login attempts — it reports them as `wrongN` — but
 * unlike the V1 it has no readable lockout timer: once it decides to stop
 * answering, nothing on the box says for how long. So the only defence is not
 * to knock, which matters more here than on the V1 because this is the firmware
 * the platform writes to: opening the device sheet probes, the write path signs
 * in again, and each of those spends an attempt. Without this memory a stale
 * `TELNO_ATA_PASSWORD` would lock a customer's unit out of its own console just
 * by being looked at.
 */
export interface RefusalVerdict {
  /** Seconds left before another attempt may be sent; 0 when no attempt may ever be sent. */
  remainSec: number;
  invalidAttempts: number;
  /** Not a cooldown: enough has been refused that no further attempt may be made. */
  stop: boolean;
}

/** Null means "safe to try". */
export function refusalVerdict(
  guard: RefusalGuard,
  label: string,
  key: string,
): RefusalVerdict | null {
  const refusal = guard.get(label);
  if (!refusal) return null;
  if (refusal.key && refusal.key !== key) {
    // Someone corrected the deployment: that earns one attempt, and the refusal
    // recorded against the old password must not block it.
    guard.clear(label);
    return null;
  }
  if (refusal.count > AUTH_BACKOFF.length) {
    return { remainSec: 0, invalidAttempts: refusal.count, stop: true };
  }
  const window = AUTH_BACKOFF[refusal.count - 1] ?? AUTH_COOLDOWN_MS;
  const left = window - (Date.now() - refusal.at);
  if (left <= 0) return null;
  return { remainSec: Math.ceil(left / 1000), invalidAttempts: refusal.count, stop: false };
}

/** Remember a refusal, with the `wrongN` the unit answered if it said. */
export function recordRefusal(
  guard: RefusalGuard,
  label: string,
  key: string,
  remainingAttempts?: number,
): void {
  const previous = guard.get(label);
  const previousCount = previous && previous.key === key ? previous.count : 0;
  // Two attempts left belong to a human: spending them locks the hardware for a
  // timer this firmware will not disclose.
  const exhausted = typeof remainingAttempts === 'number' && remainingAttempts <= 2;
  guard.set(label, {
    at: Date.now(),
    count: exhausted ? AUTH_BACKOFF.length + 1 : previousCount + 1,
    key,
  });
}

const STOPPED =
  "This deployment's adaptor password was refused repeatedly, so no further attempts are being made. Correct it and restart the platform.";

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
  /** Durable store for refused passwords; the server passes a database-backed one. */
  guard?: RefusalGuard;
}

export interface AtaAccountInput {
  account: number;
  user?: string;
  authId?: string;
  secret?: string;
  name?: string;
}

export class AtaV2 {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private readonly guard: RefusalGuard;
  private cookie = '';
  private sid = '';

  constructor({
    host,
    port = 443,
    username = 'admin',
    password = '',
    timeoutMs = 6000,
    guard = memoryGuard,
  }: AtaV2Options) {
    this.host = host;
    this.port = Number(port) || 443;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.guard = guard;
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
    // A missing credential is a deployment state, not a refusal: it must not be
    // counted against the unit's attempt budget or overwrite the digest that
    // identifies the password actually refused.
    if (!this.password) {
      throw new AtaV2Error('No admin password is configured for this device', 'ata_unconfigured');
    }

    // Refusals are checked before a socket is opened. The unit counts every
    // attempt, this firmware will not say when it gives up, and a console that is
    // merely being looked at must not be able to lock the hardware out.
    const key = credentialKey(this.password);
    const verdict = refusalVerdict(this.guard, this.label, key);
    if (verdict) {
      if (verdict.stop) throw new AtaV2Error(STOPPED, 'ata_locked');
      throw new AtaV2Error(
        `The device refused this deployment's password and is counting failed attempts; it will be tried again in ${formatWait(verdict.remainSec)}.`,
        'ata_auth',
      );
    }

    const body = `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    const res = await this.#post('/cgi-bin/dologin', body);
    const payload = res.json;
    const payloadBody = (payload?.body ?? null) as { sid?: unknown; role?: unknown; defaultAuth?: unknown } | null;
    if (payload?.response === 'success' && payloadBody?.sid) {
      this.sid = String(payloadBody.sid);
      // A working credential clears the memory, so a repaired deployment starts
      // from zero attempts rather than from the last refusal's timer.
      this.guard.clear(this.label);
      return {
        ok: true,
        role: payloadBody.role === undefined ? null : String(payloadBody.role),
        defaultAuth: Boolean(payloadBody.defaultAuth),
      };
    }

    // `wrongN` carries the attempts left, which is the one number worth passing on.
    const detail = typeof payload?.body === 'string' ? payload.body : '';
    const left = /^wrong(\d+)$/i.exec(detail)?.[1];
    const remaining = left === undefined ? undefined : Number(left);
    recordRefusal(this.guard, this.label, key, remaining);
    const budgetGone = typeof remaining === 'number' && remaining <= 2;
    throw new AtaV2Error(
      left
        ? `The device did not recognise that admin password (${left} attempt${left === '1' ? '' : 's'} left before a lockout)` +
          (budgetGone ? '. No further attempts will be made until the credential is corrected.' : '')
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

    // Honour the refusal memory before opening a socket. Reporting the cooldown
    // is also the only way the console's lockout callout can ever appear for this
    // firmware: the unit will not say how long its own ban lasts.
    if (this.password) {
      const verdict = refusalVerdict(this.guard, this.label, credentialKey(this.password));
      if (verdict) {
        view.reachable = true;
        view.state = 'auth';
        view.locked = verdict.remainSec > 0;
        view.remainSec = verdict.remainSec;
        view.lock = {
          locked: view.locked,
          remainSec: verdict.remainSec,
          accessAttempts: 0,
          invalidAttempts: verdict.invalidAttempts,
        };
        view.notes.push(
          verdict.stop
            ? STOPPED
            : `The platform will not send another password yet: an earlier one was refused and this unit counts every attempt. It will try again in ${formatWait(verdict.remainSec)}.`,
        );
        view.tookMs = Date.now() - started;
        return view;
      }
    }

    try {
      await this.login();
      view.reachable = true;
      view.authenticated = true;
    } catch (err: unknown) {
      const code = err instanceof AtaV2Error ? err.code : '';
      view.reachable = code !== 'ata_unreachable';
      // A refused, exhausted or unconfigured credential is all "we could not get
      // in", which is the operator's problem to fix — not an unreachable box.
      view.state =
        code === 'ata_auth' || code === 'ata_locked' || code === 'ata_unconfigured' ? 'auth' : 'unreachable';
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

    const uptimeRaw = value('P199');
    const since = uptimeRaw ? /\bup\s+(.+)$/i.exec(uptimeRaw) : null;

    view.identity = {
      // Reported, not assumed. This unit answers `DP750` — a DECT base with ten
      // account slots and no FXS ports at all — and saying "HT802" here made a
      // whole console read as if it had two analog ports that never existed.
      model: value('phone_model') ?? 'unknown',
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

    const profileServers: Record<string, string> = {};
    for (const n of [1, 2, 3, 4]) {
      const address = value(`profile.${n}.sip.server.1.address`);
      if (address) profileServers[String(n)] = address;
    }

    // One row per account the unit actually holds. An empty user id is an empty
    // slot, not a broken port: this box has ten of them and ships with two used.
    const ports: AtaPort[] = [];
    const accounts: AtaAccount[] = [];
    for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
      const user = value(accountSlot(ACCOUNT_BLOCK.user, i));
      if (!user) continue;
      const authId = value(accountSlot(ACCOUNT_BLOCK.authId, i));
      const name = value(accountSlot(ACCOUNT_BLOCK.name, i));
      const code = value(`P${ACCOUNT_STATUS + i}`);
      const profileId = value(`account.${i + 1}.sip.profile_id`);
      const registered = code === '1';
      const registration = (code ? STATUS_TEXT[code] : null) ?? 'not registered';
      ports.push({
        port: i + 1,
        enabled: true,
        hook: null,
        // This firmware *does* report registration, per account, so the console
        // can finally say "registered" instead of "configured".
        registration,
        registered,
        sipUser: user,
      });
      accounts.push({
        port: i + 1,
        user,
        authId,
        name,
        // `profile_id` is zero-based here: 0 is profile 1.
        server: profileId === null ? null : (profileServers[String(Number(profileId) + 1)] ?? null),
        profileId: profileId === null ? null : String(Number(profileId) + 1),
        localPort: null,
        // What the old table called "active": the account is in service when it
        // is registered, which is the only meaning an operator cares about.
        active: registered ? '1' : '0',
        registered,
        registration,
      });
    }
    view.ports = ports;
    view.accounts = accounts;
    view.tookMs = Date.now() - started;
    return view;
  }

  /**
   * Write one account row, then read it back.
   *
   * Only the `P` numbers in `ACCOUNT_BLOCK` are written. The dotted names are
   * accepted by `api.values.post` — it answers `{"status":"right"}` — and do
   * nothing at all, so a caller that "succeeded" against them leaves a line that
   * still registers as whatever was there before. The read-back is the contract:
   * a write is only reported as applied when the unit returns the new value.
   *
   * The password is written but never read back or returned.
   */
  async setAccount({ account, user, authId, secret, name }: AtaAccountInput): Promise<AtaAccountWrite> {
    const index = Number(account) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= ACCOUNT_SLOTS) {
      throw new AtaV2Error(`Account must be 1–${ACCOUNT_SLOTS}`, 'ata_account');
    }
    const id = String(user ?? '').trim();
    if (!id) throw new AtaV2Error('A SIP user id is required: it is what the line registers as', 'ata_account');

    if (!this.sid) await this.login();

    const fields: Array<[string, string]> = [
      [accountSlot(ACCOUNT_BLOCK.user, index), id],
      [accountSlot(ACCOUNT_BLOCK.authId, index), String(authId ?? id).trim() || id],
    ];
    if (name !== undefined && name !== null) fields.push([accountSlot(ACCOUNT_BLOCK.name, index), String(name)]);
    if (secret) fields.push([accountSlot(ACCOUNT_BLOCK.secret, index), String(secret)]);

    const form = [...fields.map(([key, val]) => `${key}=${encodeURIComponent(val)}`), `sid=${encodeURIComponent(this.sid)}`].join('&');
    const res = await this.#post('/cgi-bin/api.values.post', form);
    if (res.json?.response !== 'success') {
      throw new AtaV2Error(`The device refused the account write (${String(res.json?.body ?? res.status)})`, 'ata_account');
    }

    // A write is acknowledged before it is applied, so give the config a moment
    // and then read the numbers back rather than trusting the acknowledgement.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const keys = [
      accountSlot(ACCOUNT_BLOCK.user, index),
      accountSlot(ACCOUNT_BLOCK.authId, index),
      accountSlot(ACCOUNT_BLOCK.name, index),
      `P${ACCOUNT_STATUS + index}`,
    ];
    const { values } = await this.values([...IDENTITY_FIELDS, ...keys]);
    const read = (key: string): string | null => {
      const text = String(values[key] ?? '').trim();
      return text === '' ? null : text;
    };

    const wantedAuth = String(authId ?? id).trim() || id;
    const applied =
      read(accountSlot(ACCOUNT_BLOCK.user, index)) === id &&
      read(accountSlot(ACCOUNT_BLOCK.authId, index)) === wantedAuth;
    return {
      account: index + 1,
      applied,
      user: read(accountSlot(ACCOUNT_BLOCK.user, index)),
      authId: read(accountSlot(ACCOUNT_BLOCK.authId, index)),
      name: read(accountSlot(ACCOUNT_BLOCK.name, index)),
      registration: (() => {
        const code = read(`P${ACCOUNT_STATUS + index}`);
        return (code ? STATUS_TEXT[code] : null) ?? 'not registered';
      })(),
      note: applied
        ? 'The unit holds the new identity. It re-registers on its own; no reboot is needed.'
        : 'The device acknowledged the write but did not store it. Its configuration is likely locked by provisioning.',
    };
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
