import { cookiesFrom, request as rawRequest } from './raw.js';

/**
 * The Telno HT8022026 — a Grandstream HT802 running the 1.0.x firmware.
 *
 * What this firmware actually is, measured on a unit rather than read from a
 * data sheet:
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
 *
 * Everything the client reports is therefore labelled with where it came from:
 * a `sources` map, so the console can say "this firmware does not report a
 * serial" rather than showing a blank that looks like a bug.
 */

/** The console is locked out and counting; do not send another password. */
export class AtaLockedError extends Error {
  constructor(remainSec, invalidAttempts) {
    super(
      `The device is locked out after too many failed logins. It will accept a password again in ${formatWait(remainSec)}.`
    );
    this.name = 'AtaLockedError';
    this.code = 'ata_locked';
    this.remainSec = remainSec;
    this.invalidAttempts = invalidAttempts;
  }
}

/** The password was refused, or the session it produced was not accepted. */
export class AtaAuthError extends Error {
  constructor(message = 'The device refused the admin password') {
    super(message);
    this.name = 'AtaAuthError';
    this.code = 'ata_auth';
  }
}

export function formatWait(seconds) {
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
];

/**
 * How long a refused password is remembered, per device.
 *
 * Without this, a wrong `ATA_PASSWORD` is not one mistake but one per page load:
 * the console probes on render, the box counts every probe, and five of them cost
 * fifteen minutes. Refusals are therefore cached process-wide and no password is
 * re-sent until the cooldown passes — a console that is being looked at cannot
 * lock the hardware it is reporting on.
 */
const AUTH_COOLDOWN_MS = 5 * 60 * 1000;
/** Each further refusal waits longer, and the third stops the attempts entirely. */
const AUTH_BACKOFF = [5 * 60 * 1000, 15 * 60 * 1000];
const authFailures = new Map();

const rememberRefusal = (label) => {
  const previous = authFailures.get(label);
  authFailures.set(label, { at: Date.now(), count: (previous?.count || 0) + 1 });
};

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

const stripTags = (html) => decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Pull `label → value` pairs out of a page.
 *
 * The old console is a grid of two-cell rows and a pile of inline `<b>` labels,
 * and the same field is marked up differently on different pages, so this
 * accepts all three shapes it uses and de-duplicates by label.
 */
export function labelValuePairs(html) {
  const pairs = [];
  const add = (label, value) => {
    const cleanLabel = stripTags(label).replace(/[:*]+$/, '').trim();
    const cleanValue = stripTags(value);
    if (!cleanLabel || !cleanValue) return;
    if (cleanLabel.length > 64) return;
    if (cleanValue === cleanLabel) return;
    pairs.push({ label: cleanLabel, value: cleanValue });
  };

  // <td>Label</td><td>Value</td>, with any attributes or nested markup.
  const cells = /<td\b[^>]*>([\s\S]*?)<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(cells)) add(match[1], match[2]);

  // <b>Label:</b> value  /  <span>Label</span>: value
  const inline = /<(b|strong|span|label)\b[^>]*>([^<]{2,64}):?\s*<\/\1>\s*[:：]?\s*([^<\n]{1,120})/gi;
  for (const match of html.matchAll(inline)) add(match[2], match[3]);

  return pairs;
}

/** Every named input and its current value, which is what a save would send. */
export function formFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (!name) continue;
    const type = (/(?:^|\s)type\s*=\s*["']?([a-z]+)/i.exec(attrs)?.[1] || 'text').toLowerCase();
    // Buttons carry no state; a save would not send them back.
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /\bvalue\s*=\s*'([^']*)'/i.exec(attrs)?.[1] ?? '';
    fields[name] = decodeEntities(value);
  }
  for (const match of html.matchAll(/<select\b[^>]*\bname\s*=\s*["']?([^"'\s>]+)[^>]*>([\s\S]*?)<\/select>/gi)) {
    const [, name, inner] = match;
    const selected = /<option\b[^>]*\bselected\b[^>]*\bvalue\s*=\s*["']?([^"'\s>]*)/i.exec(inner);
    fields[name] = selected ? decodeEntities(selected[1]) : '';
  }
  return fields;
}

/** First label whose name matches any of the keys, case and punctuation aside. */
export function pick(pairs, keys) {
  const normalize = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

/**
 * A device session.
 *
 * The client is deliberately not a general HTTP wrapper: it knows the two
 * things that make this box different (the base64 login and the lockout
 * counter), and it never retries a password. One attempt per session, and the
 * caller sees the failure.
 */
export class Ht802 {
  constructor({ host, port = 80, password = '', username = 'admin', timeoutMs = 6000, transport = rawRequest } = {}) {
    if (!host) throw new Error('An ATA needs a host address');
    this.host = host;
    this.port = Number(port) || 80;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.cookie = '';
    this.sessionAt = 0;
    this.sessionPromise = null;
  }

  get label() {
    return `${this.host}:${this.port}`;
  }

  get authenticated() {
    return Boolean(this.cookie);
  }

  send(method, path, { headers = {}, form = null, authenticated = true } = {}) {
    const body = form ? new URLSearchParams(form).toString() : '';
    const merged = {
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
  async lockout() {
    const res = await this.send('GET', '/cgi-bin/api-get_lockouts', { authenticated: false });
    const data = parseJson(res.body);
    const row = data?.results?.[0] || {};
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
  async systemStatus() {
    const res = await this.send('GET', '/cgi-bin/api-get_system_status', { authenticated: false });
    const row = parseJson(res.body)?.results?.[0] || null;
    return row ? { voiceImage: row.vsz ?? null, role: row.command ?? null } : null;
  }

  /** Whether a SIP profile exists at all, without a session. */
  async sipStatus() {
    const res = await this.send('GET', '/cgi-bin/api-get_sip', { authenticated: false });
    const row = parseJson(res.body)?.results?.[0] || null;
    return row ? { exists: String(row.exist) === 'true' } : null;
  }

  /**
   * Sign in once.
   *
   * Two refusals never reach the password field: a locked device (the counter
   * would just grow) and a device with no password configured (which is a
   * deployment mistake, not a login attempt). The result is cached for the
   * life of the object; `logout()` drops it.
   */
  async login({ force = false } = {}) {
    if (this.cookie && !force) return { ok: true, reused: true };
    if (this.sessionPromise) return this.sessionPromise;
    this.sessionPromise = this.#login()
      .catch((err) => {
        if (err.code === 'ata_auth' && !err.cooldown) {
          // The device counts down in the page text. Once two attempts are left
          // they belong to a human: gambling them locks the hardware for
          // fifteen minutes, and a wrong credential is a deployment problem, not
          // something more requests can fix.
          if (typeof err.remaining === 'number' && err.remaining <= 2) {
            authFailures.set(this.label, { at: Date.now(), count: AUTH_BACKOFF.length + 1 });
          } else {
            rememberRefusal(this.label);
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
  async #login() {
    if (!this.password) throw new AtaAuthError('No admin password is configured for this device');

    const refusal = authFailures.get(this.label);
    if (refusal && refusal.count > AUTH_BACKOFF.length) {
      // Three refused cycles is not a transient problem, it is a wrong
      // credential. Attempting again would only lock the hardware in a loop, so
      // the password has to change (a deployment edit restarts the process).
      const wrong = new AtaAuthError(
        'This deployment\'s ATA_PASSWORD was refused repeatedly, so no further attempts are being made. Correct the password and restart the platform.'
      );
      wrong.cooldown = true;
      throw wrong;
    }
    if (refusal && Date.now() - refusal.at < (AUTH_BACKOFF[refusal.count - 1] ?? AUTH_COOLDOWN_MS)) {
      const wait = Math.ceil(((AUTH_BACKOFF[refusal.count - 1] ?? AUTH_COOLDOWN_MS) - (Date.now() - refusal.at)) / 1000);
      const cooling = new AtaAuthError(
        `The device refused this deployment's password and is counting failed attempts; it will be tried again in ${formatWait(wait)}.`
      );
      // Marked so the catch in login() does not restart the cooldown on the
      // cooldown's own error, which would never expire.
      cooling.cooldown = true;
      throw cooling;
    }

    const lock = await this.lockout();
    if (lock.locked) throw new AtaLockedError(lock.remainSec, lock.invalidAttempts);

    const encoded = Buffer.from(this.password, 'utf8').toString('base64');
    const page = await this.send('GET', '/', { authenticated: false });
    const gnkey = /\bgnkey\b[^>]*\bvalue\s*=\s*["']?([0-9a-fA-F]+)/i.exec(page.body)?.[1] || '';

    let res = await this.send('POST', '/cgi-bin/dologin', {
      form: { P2: encoded, ...(gnkey ? { gnkey } : {}) },
      authenticated: false,
    });
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
            : 'The device did not open a session for that password'
        );
        if (Number.isFinite(remaining)) err.remaining = remaining;
        throw err;
      }

      res = await this.send('POST', '/cgi-bin/dologin', { form: { P2: encoded, session_token: token }, authenticated: false });
      session = cookiesFrom(res.headers).find((entry) => /^session_id=/i.test(entry));
    }

    if (!session) {
      const remaining = Number(/Remaining\s+Attempts:\s*(\d+)/i.exec(res.body)?.[1]);
      const err = new AtaAuthError(
        Number.isFinite(remaining)
          ? `The device did not recognise that admin password (${remaining} attempt${remaining === 1 ? '' : 's'} left before a 15-minute lockout)`
          : 'The device did not open a session for that password'
      );
      if (Number.isFinite(remaining)) err.remaining = remaining;
      throw err;
    }

    this.cookie = session;
    this.sessionAt = Date.now();
    authFailures.delete(this.label);
    return { ok: true, reused: false };
  }

  logout() {
    this.cookie = '';
    this.sessionAt = 0;
  }

  /** Fetch a console page, signing in first if that is what it takes. */
  async page(id) {
    await this.login();
    const res = await this.send('GET', `/cgi-bin/${id}`);
    if (res.status === 301 || res.status === 302) {
      // A redirect is this firmware's only way of saying "no session".
      this.logout();
      throw new AtaAuthError(`The device refused the session for /cgi-bin/${id}`);
    }
    return { status: res.status, html: res.body, headers: res.headers, junk: res.junk };
  }

  /** Model, firmware, serial, MAC and uptime, from whichever page carries them. */
  async identify() {
    const sources = {};
    const identity = {
      model: null,
      firmware: null,
      hardware: null,
      bootloader: null,
      serial: null,
      mac: null,
      uptime: null,
      ip: null,
    };

    const wanted = [
      ['model', ['product model', 'model']],
      ['firmware', ['software version', 'firmware version', 'program version']],
      ['hardware', ['hardware version']],
      ['bootloader', ['boot version', 'bootloader version']],
      ['serial', ['serial number']],
      ['mac', ['mac address']],
      ['uptime', ['system up time', 'up time', 'uptime']],
      ['ip', ['ip address', 'ip']],
    ];

    for (const id of ['information', 'device_info', 'status', 'home']) {
      let page;
      try {
        page = await this.page(id);
      } catch (err) {
        sources[id] = err.code || 'error';
        if (err.code === 'ata_auth') break;
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
  async overview({ refresh = false } = {}) {
    const started = Date.now();
    const view = {
      target: { host: this.host, port: this.port, label: this.label },
      state: 'unreachable',
      reachable: false,
      locked: false,
      remainSec: 0,
      authenticated: false,
      lock: null,
      system: null,
      sip: null,
      identity: null,
      ports: [],
      accounts: [],
      network: null,
      sources: {},
      notes: [],
      tookMs: 0,
      checkedAt: new Date().toISOString(),
    };

    try {
      view.lock = await this.lockout();
      view.reachable = true;
      view.locked = view.lock.locked;
      view.remainSec = view.lock.remainSec;
    } catch (err) {
      view.notes.push(err.message);
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
        `The console locked itself after ${view.lock.invalidAttempts} refused logins. It will not take a password for another ${formatWait(view.remainSec)}.`
      );
      view.tookMs = Date.now() - started;
      return view;
    }

    if (refresh) this.logout();

    try {
      await this.login();
      view.authenticated = true;
      view.state = 'online';
    } catch (err) {
      view.state = err.code === 'ata_locked' ? 'locked' : err.code === 'ata_auth' ? 'auth' : 'unreachable';
      if (err.code === 'ata_locked') {
        view.locked = true;
        view.remainSec = err.remainSec || 0;
      }
      view.notes.push(err.message);
      view.tookMs = Date.now() - started;
      return view;
    }

    const identified = await this.identify();
    view.identity = identified.identity;
    view.sources = { ...identified.sources };

    const ports = await this.#ports();
    view.ports = ports.ports;
    view.sources.ports = ports.source;

    const accounts = await this.#accounts();
    view.accounts = accounts.accounts;
    view.sources.accounts = accounts.source;

    view.network = await this.#network();

    if (!view.identity.model) {
      view.notes.push('This firmware did not report a model on its information pages.');
    }

    view.tookMs = Date.now() - started;
    return view;
  }

  /**
   * FXS hooks and registrations, read from whichever page lists them.
   *
   * The old console prints one row per port, sometimes on Status and sometimes
   * on Home, so both are tried and the first that names a port wins.
   */
  async #ports() {
    for (const id of ['status', 'home', 'account']) {
      let page;
      try {
        page = await this.page(id);
      } catch {
        continue;
      }
      const pairs = labelValuePairs(page.html);
      const ports = [];
      for (let n = 1; n <= 2; n += 1) {
        const label = new RegExp(`(?:fxs|port|line)\\s*${n}\\b`, 'i');
        const hook = pairs.find((pair) => label.test(pair.label) && /hook|on hook|off hook|idle|busy/i.test(pair.value));
        const registration = pairs.find((pair) => label.test(pair.label) && /regist|sip/i.test(pair.label + pair.value));
        const user = pick(pairs, [`sip user id ${n}`, `user id ${n}`, `account ${n} sip user id`]);
        if (!hook && !registration && !user) continue;
        ports.push({
          port: n,
          hook: hook?.value ?? null,
          registration: registration?.value ?? null,
          sipUser: user ?? null,
        });
      }
      if (ports.length) return { ports, source: id };
    }
    return { ports: [], source: 'none' };
  }

  /** The SIP account per port, as the console would show it on its own page. */
  async #accounts() {
    let page;
    try {
      page = await this.page('account');
    } catch {
      return { accounts: [], source: 'unavailable' };
    }
    const pairs = labelValuePairs(page.html);
    const accounts = [];
    for (let n = 1; n <= 2; n += 1) {
      const server = pick(pairs, [`sip server ${n}`, `primary sip server ${n}`, `sip server`]);
      const user = pick(pairs, [`sip user id ${n}`, `authenticate id ${n}`, `sip user id`]);
      const name = pick(pairs, [`name ${n}`, `display name ${n}`, `account name ${n}`]);
      const active = pick(pairs, [`account active ${n}`, `account active`]);
      const localPort = pick(pairs, [`local sip port ${n}`, `local sip port`]);
      if (!server && !user && !name) continue;
      accounts.push({ port: n, server, user, name, active, localPort });
    }
    return { accounts, source: accounts.length ? 'account' : 'none' };
  }

  async #network() {
    for (const id of ['network', 'status', 'information']) {
      let page;
      try {
        page = await this.page(id);
      } catch {
        continue;
      }
      const pairs = labelValuePairs(page.html);
      const network = {
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
  async reboot() {
    await this.login();
    const res = await this.send('POST', '/cgi-bin/reboot', { form: { reboot: '1' } });
    this.logout();
    return { status: res.status, accepted: res.status >= 200 && res.status < 400 };
  }
}

function parseJson(body) {
  try {
    return JSON.parse(String(body || '').trim());
  } catch {
    return null;
  }
}

export default Ht802;
