import { createHash } from 'node:crypto';
import { cookiesFrom, request as rawRequest, type RawResponse } from './raw.js';
import {
  emptyOverview,
  type AtaAccount,
  type AtaIdentity,
  type AtaLock,
  type AtaNetwork,
  type AtaOverview,
  type AtaPort,
  type AtaSystem,
  type AtaTarget,
} from './types.js';

/**
 * The Telno HT8022026 — a Grandstream HT802 running the 1.0.x firmware.
 *
 * Ported from the container stack, where it was measured on a live unit rather
 * than read from a data sheet:
 *
 *  - The console is server-rendered CGI (`/cgi-bin/<page>`) on mini_httpd 1.30
 *    with jQuery 1.x, and every page under `/cgi-bin/` answers a session-less
 *    request with a bodyless 301 whose `Location` header never arrives. That
 *    redirect is the only "please sign in" the box offers, so a client cannot
 *    tell "page missing" from "page needs a login" — hence no discovery by
 *    probing names.
 *  - Login is `POST /cgi-bin/dologin` with `P2` set to the base64 of the admin
 *    password (the login page's own `checkForm()` does the `btoa`), plus the
 *    `gnkey` value the login page hands out.
 *  - State is a `session_id` cookie. Requests without it are redirected.
 *  - Five bad passwords lock the console for 15 minutes, and the lockout is
 *    readable without a session at `/cgi-bin/api-get_lockouts`, which is why
 *    this client reads the timer and refuses to log in while the box is locked
 *    instead of retrying into a longer ban.
 *  - A handful of read-only JSON endpoints answer without a session:
 *    `api-get_lockouts`, `api-get_system_status`, `api-get_sip`.
 */

/** The console is locked out and counting; do not send another password. */
export class AtaLockedError extends Error {
  override readonly name = 'AtaLockedError';
  readonly code = 'ata_locked';
  readonly remainSec: number;
  readonly invalidAttempts: number;

  constructor(remainSec: number, invalidAttempts: number) {
    super(
      `The device is locked out after too many failed logins. It will accept a password again in ${formatWait(remainSec)}.`,
    );
    this.remainSec = remainSec;
    this.invalidAttempts = invalidAttempts;
  }
}

/** The password was refused, or the session it produced was not accepted. */
export class AtaAuthError extends Error {
  override readonly name: string = 'AtaAuthError';
  readonly code: string = 'ata_auth';
  /** Attempts left before the firmware's lockout, when the page says. */
  remaining?: number;
  /** Set on errors that stand in for a cooldown, so a cooldown never re-arms itself. */
  cooldown = false;

  constructor(message = 'The device refused the admin password') {
    super(message);
  }
}

/**
 * No credential is configured at all.
 *
 * Deliberately not a refusal: nothing was rejected, so nothing may be counted
 * against the device's attempt budget or remembered as a failed password.
 */
export class AtaUnconfiguredError extends AtaAuthError {
  override readonly name = 'AtaUnconfiguredError';
  override readonly code = 'ata_unconfigured';

  constructor() {
    super('No admin password is configured for this device');
  }
}

export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Pages this firmware is known to serve; the console offers these as tabs. */
export const ATA_PAGES = [
  { id: 'home', label: 'Home' },
  { id: 'status', label: 'Status' },
  { id: 'account', label: 'FXS ports' },
  { id: 'network', label: 'Network' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'information', label: 'Information' },
  { id: 'device_info', label: 'Device info' },
  { id: 'reboot', label: 'Maintenance' },
] as const;

/**
 * How long a refused password is remembered, per device.
 *
 * Without this, a wrong password is not one mistake but one per page load: the
 * console probes on render, the box counts every probe, and five of them cost
 * fifteen minutes. Refusals are therefore cached process-wide and no password is
 * re-sent until the cooldown passes — a console that is being looked at cannot
 * lock the hardware it is reporting on.
 */
export const AUTH_COOLDOWN_MS = 5 * 60 * 1000;
/** Each further refusal waits longer, and the third stops the attempts entirely. */
export const AUTH_BACKOFF = [5 * 60 * 1000, 15 * 60 * 1000] as const;

/**
 * Where refused passwords are remembered.
 *
 * The default is process memory, which is enough for a single long-lived
 * server but not enough in general: a restart, or a second process opening its
 * own connection, would start with an empty map and happily spend the device's
 * remaining attempts. The control plane therefore injects a durable store.
 */
export interface RefusalGuard {
  get(host: string): { at: number; count: number; key?: string } | undefined;
  set(host: string, value: { at: number; count: number; key?: string }): void;
  clear(host: string): void;
}

/** Which credential was refused, so a corrected password is not blocked by the old one. */
export const credentialKey = (password: string): string =>
  createHash('sha256').update(password).digest('hex').slice(0, 16);

const memoryFailures = new Map<string, { at: number; count: number; key?: string }>();

export const memoryGuard: RefusalGuard = {
  get: (host) => memoryFailures.get(host),
  set: (host, value) => {
    memoryFailures.set(host, value);
  },
  clear: (host) => {
    memoryFailures.delete(host);
  },
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeEntities(text: string): string {
  return String(text ?? '').replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

const stripTags = (html: string): string =>
  decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export interface LabelValue {
  label: string;
  value: string;
}

/**
 * Pull `label → value` pairs out of a page.
 *
 * The old console is a grid of two-cell rows and a pile of inline `<b>` labels,
 * and the same field is marked up differently on different pages, so this
 * accepts all three shapes it uses and de-duplicates by label.
 */
export function labelValuePairs(html: string): LabelValue[] {
  const pairs: LabelValue[] = [];
  const add = (label: string, value: string) => {
    const cleanLabel = stripTags(label).replace(/[:*]+$/, '').trim();
    const cleanValue = stripTags(value);
    if (!cleanLabel || !cleanValue) return;
    if (cleanLabel.length > 64) return;
    if (cleanValue === cleanLabel) return;
    pairs.push({ label: cleanLabel, value: cleanValue });
  };

  // Row-aware, because these pages put the label and its value in the same
  // `<tr>` but also carry spacer and header cells: pairing neighbouring `td`s
  // across the whole document shifted every value after the first wide row and
  // dropped the MAC row entirely.
  let sawRow = false;
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(row[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1] ?? '');
    if (cells.length < 2) continue;
    sawRow = true;
    // Every cell is paired with the one after it, not every *other* cell:
    // these rows carry spacer cells (and headers of three or more columns), so
    // fixed pairing put a label on the wrong value or dropped it altogether.
    for (let index = 0; index + 1 < cells.length; index += 1) add(cells[index]!, cells[index + 1]!);
  }

  // Pages without table rows still mark values up as adjacent cells.
  if (!sawRow) {
    const cells = /<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    for (const match of html.matchAll(cells)) add(match[1] ?? '', match[2] ?? '');
  }

  // <b>Label:</b> value  /  <span>Label</span>: value
  const inline = /<(b|strong|span|label)\b[^>]*>([^<]{2,64}):?\s*<\/\1>\s*[:：]?\s*([^<\n]{1,120})/gi;
  for (const match of html.matchAll(inline)) add(match[2] ?? '', match[3] ?? '');

  return pairs;
}

/** Every named input and its current value, which is what a save would send. */
export function formFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1] ?? '';
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (!name) continue;
    const type = (/(?:^|\s)type\s*=\s*["']?([a-z]+)/i.exec(attrs)?.[1] ?? 'text').toLowerCase();
    // Buttons carry no state; a save would not send them back.
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
    const value =
      /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bvalue\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    fields[name] = decodeEntities(value);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)[^>]*>([\s\S]*?)<\/select>/gi)) {
    const name = match[1];
    const inner = match[2] ?? '';
    if (!name) continue;
    const selected = /<option\b[^>]*\bselected\b[^>]*\bvalue\s*=\s*["']?([^"'\s>]*)/i.exec(inner);
    fields[name] = selected?.[1] ? decodeEntities(selected[1]) : '';
  }
  return fields;
}

/**
 * Links a console page publishes, with their visible text.
 *
 * The FXS tabs are emitted from inside `document.write(...)` strings, so the
 * quotes around the href arrive backslash-escaped; the pattern tolerates that
 * rather than assuming clean markup.
 */
export function extractNav(html: string): Array<{ href: string; label: string }> {
  const out: Array<{ href: string; label: string }> = [];
  const re = /<a\b[^>]*?href\s*=\s*\\*["']?([\w#./?=&-]+)\\*["']?[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1] ?? '';
    const label = stripTags((m[2] ?? '').replace(/\\/g, '')).trim();
    if (!href || !label) continue;
    if (/^(#|javascript:|mailto:)/i.test(href)) continue;
    if (out.some((entry) => entry.href === href)) continue;
    out.push({ href, label });
  }
  return out;
}

/**
 * Value of a named input; for radio groups, the checked option wins.
 *
 * These pages are assembled with `document.write`, so attributes arrive with
 * escaped quotes and — on radio groups — unquoted values (`value=0`). Both
 * shapes are read here; requiring well-formed markup silently returned nothing.
 */
export function inputValue(html: string, name: string): string | null {
  const literal = (text: string): string => text.replace(/\\/g, '');
  const attribute = (tag: string, key: string): string | null => {
    const match = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    if (!match) return null;
    return literal(match[1] ?? match[2] ?? match[3] ?? '');
  };

  let checked: string | null = null;
  let first: string | null = null;
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const field = attribute(tag, 'name');
    if (!field || field.toUpperCase() !== name.toUpperCase()) continue;
    const value = attribute(tag, 'value') ?? '';
    if (first === null) first = value;
    if (/\bchecked\b/i.test(tag)) checked = value;
  }
  const chosen = checked ?? first;
  return chosen === null || chosen.trim() === '' ? null : chosen.trim();
}

/** First label whose name matches any of the keys, case and punctuation aside. */
export function pick(pairs: LabelValue[], keys: string[]): string | null {
  const normalize = (text: string) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wanted = keys.map(normalize);
  for (const key of wanted) {
    const exact = pairs.find((pair) => normalize(pair.label) === key);
    if (exact) return exact.value;
  }
  for (const key of wanted) {
    const partial = pairs.find((pair) => normalize(pair.label).includes(key));
    if (partial) return partial.value;
  }
  return null;
}

type Transport = typeof rawRequest;

export interface Ht802Options {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
  transport?: Transport;
  guard?: RefusalGuard;
}

/** Shape of the session-less JSON endpoints, which wrap one row in `results`. */
interface Envelope {
  results?: Array<Record<string, unknown>>;
}

function parseJson(body: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(String(body || '').trim());
    return parsed && typeof parsed === 'object' ? (parsed as Envelope) : null;
  } catch {
    return null;
  }
}

/**
 * A device session.
 *
 * The client is deliberately not a general HTTP wrapper: it knows the two
 * things that make this box different (the base64 login and the lockout
 * counter), and it never retries a password. One attempt per session, and the
 * caller sees the failure.
 */
export class Ht802 {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private readonly transport: Transport;
  private readonly guard: RefusalGuard;
  private cookie = '';
  /** The console page the login POST returns, and the links it advertises. */
  private landing = '';
  private nav: Array<{ href: string; label: string }> = [];
  private sessionPromise: Promise<{ ok: true; reused: boolean }> | null = null;

  constructor({
    host,
    port = 80,
    password = '',
    username = 'admin',
    timeoutMs = 6000,
    transport = rawRequest,
    guard = memoryGuard,
  }: Ht802Options) {
    if (!host) throw new Error('An ATA needs a host address');
    this.host = host;
    this.port = Number(port) || 80;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.guard = guard;
  }

  get label(): string {
    return `${this.host}:${this.port}`;
  }

  get authenticated(): boolean {
    return Boolean(this.cookie);
  }

  send(
    method: 'GET' | 'POST',
    path: string,
    { headers = {}, form = null, authenticated = true }: { headers?: Record<string, string>; form?: Record<string, string> | null; authenticated?: boolean } = {},
  ): Promise<RawResponse> {
    const body = form ? new URLSearchParams(form).toString() : '';
    const merged: Record<string, string> = {
      Accept: '*/*',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(authenticated && this.cookie ? { Cookie: this.cookie } : {}),
      ...headers,
    };
    return this.transport({
      host: this.host,
      port: this.port,
      method,
      path,
      headers: merged,
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Read the lockout counter. This endpoint answers without a session. */
  async lockout(): Promise<AtaLock> {
    const res = await this.send('GET', '/cgi-bin/api-get_lockouts', { authenticated: false });
    const row = parseJson(res.body)?.results?.[0] ?? {};
    const remainSec = Number(row.remain) || 0;
    // The flag is not cleared when the window ends: the audited unit reports
    // locked=true with remain=-5 well past the deadline. A negative timer is
    // the device saying the lockout is over but nobody has reset the boolean,
    // so the timer is what decides — otherwise the console stays dark forever.
    return {
      locked: String(row.locked) === 'true' && remainSec > 0,
      remainSec: Math.max(0, remainSec),
      accessAttempts: Number(row.accessattempt) || 0,
      invalidAttempts: Number(row.invalidattempt) || 0,
    };
  }

  /** The ATA process and its voice-image tag, without a session. */
  async systemStatus(): Promise<AtaSystem | null> {
    const res = await this.send('GET', '/cgi-bin/api-get_system_status', { authenticated: false });
    const row = parseJson(res.body)?.results?.[0] ?? null;
    if (!row) return null;
    return {
      voiceImage: row.vsz === undefined ? null : String(row.vsz),
      role: row.command === undefined ? null : String(row.command),
    };
  }

  /** Whether a SIP profile exists at all, without a session. */
  async sipStatus(): Promise<{ exists: boolean } | null> {
    const res = await this.send('GET', '/cgi-bin/api-get_sip', { authenticated: false });
    const row = parseJson(res.body)?.results?.[0] ?? null;
    return row ? { exists: String(row.exist) === 'true' } : null;
  }

  /**
   * Sign in once.
   *
   * Two refusals never reach the password field: a locked device (the counter
   * would just grow) and a device with no password configured (which is a
   * deployment mistake, not a login attempt). The result is cached for the life
   * of the object; `logout()` drops it.
   */
  async login({ force = false }: { force?: boolean } = {}): Promise<{ ok: true; reused: boolean }> {
    if (this.cookie && !force) return { ok: true, reused: true };
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.#login()
      .catch((err: unknown) => {
        // Only a rejected credential counts. A missing one is a deployment
        // state, and recording it would consume the device's budget and (worse)
        // overwrite the digest that identifies the credential actually refused.
        if (err instanceof AtaAuthError && err.code === 'ata_auth' && !err.cooldown) {
          // The device counts down in the page text. Once two attempts are left
          // they belong to a human: gambling them locks the hardware for
          // fifteen minutes, and a wrong credential is a deployment problem, not
          // something more requests can fix.
          const key = credentialKey(this.password);
          if (typeof err.remaining === 'number' && err.remaining <= 2) {
            // Out of budget: stop until someone corrects the credential.
            this.guard.set(this.label, { at: Date.now(), count: AUTH_BACKOFF.length + 1, key });
          } else {
            const previous = this.guard.get(this.label);
            this.guard.set(this.label, { at: Date.now(), count: (previous?.count ?? 0) + 1, key });
          }
        }
        throw err;
      })
      .finally(() => {
        this.sessionPromise = null;
      });
    return this.sessionPromise;
  }

  /**
   * The login is a two-step exchange, which is not what the login page implies.
   *
   * The first form posts `P2` (base64 password) with the page's `gnkey`. If that
   * is not accepted the answer is not a plain rejection: it is a *new form*, with
   * `action="dologin"`, the message "your login password is not recognized" and
   * a hidden `session_token` — and the password has to be posted again with that
   * token in place of the key. Two POSTs, then the box either hands back a
   * `session_id` cookie or counts another refused attempt (`Remaining Attempts: N`).
   *
   * The bound matters more than the flow: five refusals cost fifteen minutes of
   * console, so this makes at most two attempts per call and never loops.
   */
  async #login(): Promise<{ ok: true; reused: boolean }> {
    if (!this.password) throw new AtaUnconfiguredError();

    // A different password means someone corrected the deployment: that earns
    // one attempt, and the old refusal must not block it.
    const key = credentialKey(this.password);
    let refusal = this.guard.get(this.label);
    if (refusal?.key && refusal.key !== key) {
      this.guard.clear(this.label);
      refusal = undefined;
    }

    if (refusal && refusal.count > AUTH_BACKOFF.length) {
      // Three refused cycles is not a transient problem, it is a wrong
      // credential. Attempting again would only lock the hardware in a loop, so
      // the password has to change (a deployment edit restarts the process).
      const wrong = new AtaAuthError(
        "This deployment's adaptor password was refused repeatedly, so no further attempts are being made. Correct it and restart the platform.",
      );
      wrong.cooldown = true;
      throw wrong;
    }
    if (refusal) {
      const window = AUTH_BACKOFF[refusal.count - 1] ?? AUTH_COOLDOWN_MS;
      if (Date.now() - refusal.at < window) {
        const wait = Math.ceil((window - (Date.now() - refusal.at)) / 1000);
        const cooling = new AtaAuthError(
          `The device refused this deployment's password and is counting failed attempts; it will be tried again in ${formatWait(wait)}.`,
        );
        // Marked so the catch in login() does not restart the cooldown on the
        // cooldown's own error, which would never expire.
        cooling.cooldown = true;
        throw cooling;
      }
    }

    const lock = await this.lockout();
    if (lock.locked) throw new AtaLockedError(lock.remainSec, lock.invalidAttempts);

    const encoded = Buffer.from(this.password, 'utf8').toString('base64');

    /**
     * Read the login form and send back exactly the fields it declares.
     *
     * Firmwares differ here in a way that looks like a wrong password: one page
     * asks for `P2` + `gnkey` alone, while the 1.0.x console at `/cgi-bin/login`
     * also requires `username`, the submit button's `Login` value and a
     * per-page `session_token`. Posting the shorter set is rejected as a bad
     * password on that firmware, which costs an attempt from the device's five.
     */
    let page = await this.send('GET', '/cgi-bin/login', { authenticated: false });
    if (page.status !== 200) page = await this.send('GET', '/', { authenticated: false });
    const formHtml = /<form[\s\S]*?<\/form>/i.exec(page.body)?.[0] ?? page.body;
    const declared = formFields(formHtml);
    const rawAction = /<form[^>]*\baction\s*=\s*["']?([^"'\s>]+)/i.exec(formHtml)?.[1] ?? 'dologin';
    const action = rawAction.startsWith('/') ? rawAction : `/cgi-bin/${rawAction}`;

    const form: Record<string, string> = { P2: encoded };
    // Only fields the page actually offers: an unknown key is a needless risk.
    if (declared.username !== undefined) form.username = declared.username || this.username;
    if (declared.Login !== undefined) form.Login = declared.Login || 'Login';
    for (const key of ['gnkey', 'session_token']) {
      const value = declared[key];
      if (value) form[key] = value;
    }

    let res = await this.send('POST', action, { form, authenticated: false });
    let session = cookiesFrom(res.headers).find((entry) => /^session_id=/i.test(entry));

    if (!session) {
      if (/locked due to too many login errors/i.test(res.body)) {
        const after = await this.lockout().catch(() => null);
        throw new AtaLockedError(after?.remainSec ?? 900, after?.invalidAttempts ?? lock.invalidAttempts + 1);
      }
      const token = /\bsession_token\b[^>]*\bvalue\s*=\s*["']?([0-9a-fA-F]+)/i.exec(res.body)?.[1];
      const remaining = Number(/Remaining\s+Attempts:\s*(\d+)/i.exec(res.body)?.[1]);
      // Out of attempts is a lockout in all but name; do not spend the last one.
      if (Number.isFinite(remaining) && remaining <= 0) {
        const after = await this.lockout().catch(() => null);
        throw new AtaLockedError(after?.remainSec ?? 900, after?.invalidAttempts ?? lock.invalidAttempts + 1);
      }
      if (!token) {
        const err = new AtaAuthError(
          Number.isFinite(remaining)
            ? `The device did not recognise that admin password (${remaining} attempt${remaining === 1 ? '' : 's'} left before a 15-minute lockout)`
            : 'The device did not open a session for that password',
        );
        if (Number.isFinite(remaining)) err.remaining = remaining;
        throw err;
      }

      res = await this.send('POST', '/cgi-bin/dologin', {
        form: { P2: encoded, session_token: token },
        authenticated: false,
      });
      session = cookiesFrom(res.headers).find((entry) => /^session_id=/i.test(entry));
    }

    if (!session) {
      const remaining = Number(/Remaining\s+Attempts:\s*(\d+)/i.exec(res.body)?.[1]);
      const err = new AtaAuthError(
        Number.isFinite(remaining)
          ? `The device did not recognise that admin password (${remaining} attempt${remaining === 1 ? '' : 's'} left before a 15-minute lockout)`
          : 'The device did not open a session for that password',
      );
      if (Number.isFinite(remaining)) err.remaining = remaining;
      throw err;
    }

    this.cookie = session;
    // This firmware answers a successful login *with the console page itself*,
    // so the status data is already in hand and the nav tells us the real page
    // names (`config2`, `config_a1`…) instead of the ones a firmware revision
    // list suggests.
    this.landing = res.body;
    this.nav = extractNav(res.body);
    this.guard.clear(this.label);
    return { ok: true, reused: false };
  }

  logout(): void {
    this.cookie = '';
    this.landing = '';
    this.nav = [];
  }

  /** Links the console advertises, as `href` + visible label. */
  get links(): Array<{ href: string; label: string }> {
    return this.nav;
  }

  /** Open a console page by the href the console itself published. */
  async open(href: string): Promise<{ status: number; html: string }> {
    await this.login();
    const path = href.startsWith('/') ? href : `/cgi-bin/${href.replace(/^\.\//, '')}`;
    const res = await this.send('GET', path);
    if (res.status === 301 || res.status === 302) {
      // This firmware serves one session at a time and answers a stale cookie
      // with a bare redirect. Sign in once more rather than discarding the
      // console page the first login already returned.
      this.cookie = '';
      await this.login();
      const retry = await this.send('GET', path);
      if (retry.status === 301 || retry.status === 302) {
        this.cookie = '';
        throw new AtaAuthError(`The device refused the session for ${path}`);
      }
      return { status: retry.status, html: retry.body };
    }
    return { status: res.status, html: res.body };
  }

  /** Fetch a console page, signing in first if that is what it takes. */
  async page(id: string): Promise<{ status: number; html: string; headers: RawResponse['headers']; junk: string[] }> {
    await this.login();
    const res = await this.send('GET', `/cgi-bin/${id}`);
    if (res.status === 301 || res.status === 302) {
      // A redirect is this firmware's only way of saying "no session".
      this.cookie = '';
      await this.login();
      const retry = await this.send('GET', `/cgi-bin/${id}`);
      if (retry.status === 301 || retry.status === 302) {
        this.cookie = '';
        throw new AtaAuthError(`The device refused the session for /cgi-bin/${id}`);
      }
      return { status: retry.status, html: retry.body, headers: retry.headers, junk: retry.junk };
    }
    return { status: res.status, html: res.body, headers: res.headers, junk: res.junk };
  }

  /** Model, firmware, serial, MAC and uptime, from whichever page carries them. */
  async identify(): Promise<{ identity: AtaIdentity; sources: Record<string, string> }> {
    const sources: Record<string, string> = {};
    // The login response *is* the status page on this firmware, so the identity
    // is usually already in hand and no extra request is needed.
    const landingPairs = this.landing ? labelValuePairs(this.landing) : [];
    const identity: AtaIdentity = {
      model: null,
      firmware: null,
      hardware: null,
      bootloader: null,
      serial: null,
      mac: null,
      uptime: null,
      ip: null,
    };

    const wanted: Array<[keyof AtaIdentity, string[]]> = [
      ['model', ['product model', 'model']],
      ['firmware', ['software version', 'firmware version', 'program version']],
      ['hardware', ['hardware version']],
      ['bootloader', ['boot version', 'bootloader version']],
      ['serial', ['serial number']],
      ['mac', ['mac address']],
      ['uptime', ['system up time', 'up time', 'uptime']],
      ['ip', ['ipv4 address', 'ip address', 'ip']],
    ];

    if (landingPairs.length) {
      for (const [field, keys] of wanted) {
        const value = pick(landingPairs, keys);
        if (value) identity[field] = value;
      }
      sources.status = 'ok';
    }
    // Only go looking for other pages when the landing page was not enough.
    if (identity.model && identity.firmware && identity.serial) return { identity, sources };

    for (const id of ['information', 'device_info', 'status', 'home']) {
      let page: { html: string };
      try {
        page = await this.page(id);
      } catch (err: unknown) {
        sources[id] = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'error';
        if (err instanceof AtaAuthError) break;
        continue;
      }
      sources[id] = 'ok';
      const pairs = labelValuePairs(page.html);
      for (const [field, keys] of wanted) {
        if (identity[field]) continue;
        const value = pick(pairs, keys);
        if (value) identity[field] = value;
      }
      if (identity.model && identity.firmware && identity.mac) break;
    }

    return { identity, sources };
  }

  /**
   * Everything the console shows, gathered without ever throwing for a reason
   * the page could explain. The result is always renderable: `state` says how
   * far the client got, and the rest is filled in as far as it got.
   */
  async overview({ refresh = false }: { refresh?: boolean } = {}): Promise<AtaOverview> {
    const started = Date.now();
    const view = emptyOverview(this.target(), 'v1');

    try {
      view.lock = await this.lockout();
      view.reachable = true;
      view.locked = view.lock.locked;
      view.remainSec = view.lock.remainSec;
    } catch (err: unknown) {
      view.notes.push(err instanceof Error ? err.message : 'the device did not answer');
      view.tookMs = Date.now() - started;
      return view;
    }

    view.state = view.locked ? 'locked' : 'reachable';

    const [system, sip] = await Promise.allSettled([this.systemStatus(), this.sipStatus()]);
    if (system.status === 'fulfilled') view.system = system.value;
    if (sip.status === 'fulfilled') view.sip = sip.value;

    // Never spend a password attempt on a device that is counting.
    if (view.locked) {
      view.notes.push(
        `The console locked itself after ${view.lock?.invalidAttempts ?? 0} refused logins. It will not take a password for another ${formatWait(view.remainSec)}.`,
      );
      view.tookMs = Date.now() - started;
      return view;
    }

    if (refresh) this.logout();

    try {
      await this.login();
      view.authenticated = true;
      view.state = 'online';
    } catch (err: unknown) {
      const code = err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
      view.state =
        code === 'ata_locked'
          ? 'locked'
          : code === 'ata_auth'
            ? 'auth'
            : code === 'ata_unconfigured'
              ? 'reachable'
              : 'unreachable';
      if (err instanceof AtaLockedError) {
        view.locked = true;
        view.remainSec = err.remainSec;
      }
      view.notes.push(err instanceof Error ? err.message : 'the device refused the session');
      view.tookMs = Date.now() - started;
      return view;
    }

    const identified = await this.identify();
    view.identity = identified.identity;
    view.sources = { ...identified.sources };

    const accounts = await this.#accounts();
    view.accounts = accounts.accounts;
    view.sources.accounts = accounts.source;

    // An FXS page states each port's own configuration, so the ports are
    // derived from it rather than scraped from a table cell somewhere else.
    const ports = accounts.accounts.length
      ? this.#portsFromAccounts(accounts.accounts, this.#hooks())
      : await this.#ports();
    view.ports = ports.ports;
    view.sources.ports = ports.source;

    view.network = await this.#network();

    if (!view.identity.model) {
      view.notes.push('This firmware did not report a model on its information pages.');
    }

    view.tookMs = Date.now() - started;
    return view;
  }

  target(): AtaTarget {
    return { host: this.host, port: this.port, label: this.label };
  }

  /**
   * FXS hooks and registrations, read from whichever page lists them.
   *
   * The old console prints one row per port, sometimes on Status and sometimes
   * on Home, so both are tried and the first that names a port wins.
   */
  async #ports(): Promise<{ ports: AtaPort[]; source: string }> {
    for (const id of ['status', 'home', 'account']) {
      let page: { html: string };
      try {
        page = await this.page(id);
      } catch {
        continue;
      }
      const pairs = labelValuePairs(page.html);
      const ports: AtaPort[] = [];
      for (let n = 1; n <= 2; n += 1) {
        const label = new RegExp(`(?:fxs|port|line)\\s*${n}\\b`, 'i');
        const hook = pairs.find((pair) => label.test(pair.label) && /hook|on hook|off hook|idle|busy/i.test(pair.value));
        const registration = pairs.find(
          (pair) => label.test(pair.label) && /regist|sip/i.test(pair.label + pair.value),
        );
        const user = pick(pairs, [`sip user id ${n}`, `user id ${n}`, `account ${n} sip user id`]);
        if (!hook && !registration && !user) continue;
        ports.push({
          port: n,
          enabled: null,
          hook: hook?.value ?? null,
          registration: registration?.value ?? null,
          sipUser: user ?? null,
        });
      }
      if (ports.length) return { ports, source: id };
    }
    return { ports: [], source: 'none' };
  }

  /** Handset state per port, as the status table on the landing page reports it. */
  #hooks(): Map<number, string> {
    const hooks = new Map<number, string>();
    for (const pair of labelValuePairs(this.landing)) {
      const match = /^fxs\s*(\d+)$/i.exec(pair.label.trim());
      if (match && /hook|idle|busy|ring/i.test(pair.value)) hooks.set(Number(match[1]), pair.value);
    }
    return hooks;
  }

  /** The SIP account per port, as the console would show it on its own page. */
  /** Ports described by the FXS configuration pages. */
  #portsFromAccounts(
    accounts: AtaAccount[],
    hooks: Map<number, string> = new Map(),
  ): { ports: AtaPort[]; source: string } {
    return {
      source: 'fxs',
      ports: accounts.map((account) => ({
        port: account.port,
        enabled: account.active === null ? null : account.active === '1',
        // The configuration pages say nothing about the handset, but the status
        // table on the landing page does, so it is carried over when present.
        hook: hooks.get(account.port) ?? null,
        // Configuration, not live registration: the console does not say.
        registration: account.user
          ? account.active === '1'
            ? 'configured'
            : 'disabled'
          : 'no SIP user',
        sipUser: account.user,
      })),
    };
  }

  async #accounts(): Promise<{ accounts: AtaAccount[]; source: string }> {
    // This firmware publishes its FXS tabs and their P-numbers, so read those
    // pages directly; the table scraping below is only for consoles that don't.
    const fxs = this.nav.filter((link) => /fxs\s*port/i.test(link.label));
    if (fxs.length) {
      const accounts: AtaAccount[] = [];
      // One page at a time: this firmware keeps a single session, and parallel
      // reads made it drop one, which then shifted the port numbering below.
      for (const [index, link] of fxs.entries()) {
        let html: string;
        try {
          html = (await this.open(link.href)).html;
        } catch {
          continue;
        }
        // The first tab is labelled "FXS PORT" with no digit; the others carry
        // theirs. The position in the published list is the fallback, so a page
        // that fails cannot renumber the ones that follow.
        const number = Number(/fxs\s*port\s*(\d+)/i.exec(link.label)?.[1] ?? index + 1) || index + 1;
        const server = inputValue(html, `P${number === 1 ? 47 : 747}`);
        const user = inputValue(html, `P${number === 1 ? 35 : 735}`);
        const authId = inputValue(html, `P${number === 1 ? 36 : 736}`);
        const active = inputValue(html, `P${number === 1 ? 271 : 401}`);
        const localPort = inputValue(html, `P${number === 1 ? 40 : 740}`);
        // A port with nothing configured is still a port: it is reported with
        // nulls so the console can say "no SIP user" rather than omit it.
        accounts.push({ port: number, server, user, name: authId, active, localPort });
      }
      if (accounts.length) return { accounts, source: 'fxs' };
    }

    let page: { html: string };
    try {
      page = await this.page('account');
    } catch {
      return { accounts: [], source: 'unavailable' };
    }
    const pairs = labelValuePairs(page.html);
    const accounts: AtaAccount[] = [];
    for (let n = 1; n <= 2; n += 1) {
      const server = pick(pairs, [`sip server ${n}`, `primary sip server ${n}`, 'sip server']);
      const user = pick(pairs, [`sip user id ${n}`, `authenticate id ${n}`, 'sip user id']);
      const name = pick(pairs, [`name ${n}`, `display name ${n}`, `account name ${n}`]);
      const active = pick(pairs, [`account active ${n}`, 'account active']);
      const localPort = pick(pairs, [`local sip port ${n}`, 'local sip port']);
      if (!server && !user && !name) continue;
      accounts.push({ port: n, server, user, name, active, localPort });
    }
    return { accounts, source: accounts.length ? 'account' : 'none' };
  }

  async #network(): Promise<AtaNetwork | null> {
    for (const id of ['network', 'status', 'information']) {
      let page: { html: string };
      try {
        page = await this.page(id);
      } catch {
        continue;
      }
      const pairs = labelValuePairs(page.html);
      const network: AtaNetwork = {
        ip: pick(pairs, ['ip address', 'ipv4 address']),
        mask: pick(pairs, ['subnet mask', 'netmask']),
        gateway: pick(pairs, ['default gateway', 'gateway']),
        dns: pick(pairs, ['dns server 1', 'primary dns', 'dns server']),
        mac: pick(pairs, ['mac address']),
        dhcp: pick(pairs, ['dhcp', 'ip setting', 'address type']),
      };
      if (Object.values(network).some(Boolean)) return network;
    }
    return null;
  }

  /** Ask the device to restart. The console loses its session either way. */
  async reboot(): Promise<{ status: number; accepted: boolean }> {
    await this.login();
    const res = await this.send('POST', '/cgi-bin/reboot', { form: { reboot: '1' } });
    this.logout();
    return { status: res.status, accepted: res.status >= 200 && res.status < 400 };
  }
}

export default Ht802;
