import https from 'node:https';

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
const ACCOUNT_BLOCK = { user: 4060, authId: 4090, secret: 4120, name: 4180 };
const ACCOUNT_STATUS = 4921;
const STATUS_TEXT = { 1: 'registered', 2: 'not registered' };

/** `P4060` for account 1, `P4061` for account 2, … */
const slot = (block, index) => `P${block + index}`;

const IDENTITY_FIELDS = [
  'P68', // software version
  'P199', // uptime, as the unit reports it (` 02:29:04 up 27 days`)
  'serial_number',
  'phone_model',
];

const PROFILE_FIELDS = [1, 2, 3, 4].map((n) => `profile.${n}.sip.server.1.address`);

const accountFields = () => {
  const names = [...IDENTITY_FIELDS, ...PROFILE_FIELDS];
  for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
    names.push(slot(ACCOUNT_BLOCK.user, i), slot(ACCOUNT_BLOCK.authId, i), slot(ACCOUNT_BLOCK.name, i));
    names.push(`account.${i + 1}.sip.profile_id`, `P${ACCOUNT_STATUS + i}`);
  }
  // The password is never read: the API answers it in clear text, and nothing
  // in this view needs it.
  return names;
};

/** Named parameters read at idle speed; kept as a list so callers can extend it. */
const DEFAULT_FIELDS = accountFields();

export class AtaV2Error extends Error {
  constructor(message, code = 'ata_v2') {
    super(message);
    this.name = 'AtaV2Error';
    this.code = code;
  }
}

function call({ host, port, method, path, headers = {}, body = '', timeoutMs = 6000 }) {
  return new Promise((resolve, reject) => {
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
          ...(payload.length ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode || 0, headers: response.headers, text })
        );
      }
    );
    request.on('timeout', () => request.destroy(new AtaV2Error(`${host}:${port} did not answer in time`, 'ata_unreachable')));
    request.on('error', (err) => reject(err instanceof AtaV2Error ? err : new AtaV2Error(`${host}:${port} refused the connection`, 'ata_unreachable')));
    if (payload.length) request.write(payload);
    request.end();
  });
}

const json = (text) => {
  try {
    return JSON.parse(String(text || '').trim());
  } catch {
    return null;
  }
};

export class AtaV2 {
  constructor({ host, port = 443, username = 'admin', password = '', timeoutMs = 6000 } = {}) {
    this.host = host;
    this.port = Number(port) || 443;
    this.username = username || 'admin';
    this.password = password || '';
    this.timeoutMs = timeoutMs;
    this.cookie = '';
    this.sid = '';
  }

  get label() {
    return `${this.host}:${this.port}`;
  }

  /** Is this the TLS/GWT console rather than the old mini_httpd one? */
  async detect() {
    try {
      const res = await call({ host: this.host, port: this.port, method: 'GET', path: '/', timeoutMs: this.timeoutMs });
      return /Loading Web Application|webapp\.nocache\.js|lighttpd/i.test(res.text) || res.status === 200;
    } catch {
      return false;
    }
  }

  async #post(path, form) {
    const res = await call({
      host: this.host,
      port: this.port,
      method: 'POST',
      path,
      body: form,
      headers: this.cookie ? { Cookie: this.cookie } : {},
      timeoutMs: this.timeoutMs,
    });
    const cookies = [].concat(res.headers['set-cookie'] || []).map((line) => line.split(';')[0].trim()).filter(Boolean);
    if (cookies.length) this.cookie = cookies.join('; ');
    return { status: res.status, text: res.text, json: json(res.text) };
  }

  async login() {
    if (!this.password) throw new AtaV2Error('No admin password is configured for this device', 'ata_auth');
    const body = `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`;
    const res = await this.#post('/cgi-bin/dologin', body);
    const payload = res.json;
    if (payload?.response === 'success' && payload.body?.sid) {
      this.sid = String(payload.body.sid);
      return { ok: true, role: payload.body.role || null, defaultAuth: Boolean(payload.body.defaultAuth) };
    }
    // `wrongN` carries the attempts left, which is the one number worth passing on.
    const detail = typeof payload?.body === 'string' ? payload.body : '';
    const left = /^wrong(\d+)$/i.exec(detail)?.[1];
    throw new AtaV2Error(
      left
        ? `The device did not recognise that admin password (${left} attempt${left === '1' ? '' : 's'} left before a lockout)`
        : 'The device did not open a session for that password',
      'ata_auth'
    );
  }

  /** Read named parameters. Empty values are re-read once with a fresh session. */
  async values(names = DEFAULT_FIELDS) {
    const read = async () => {
      const form = `request=${names.join(':')}&sid=${encodeURIComponent(this.sid)}`;
      const res = await this.#post('/cgi-bin/api.values.get', form);
      return res.json?.body && typeof res.json.body === 'object' ? res.json.body : null;
    };

    // A stale session answers success with blanks, and it does so *partially*:
    // observed reads returned the firmware string while every port field came
    // back empty. So the test is not "is everything blank" but "are the fields
    // that cannot be blank". P68 and the serial number exist on every unit.
    const blind = (body) =>
      !body || (body.P68 !== undefined && body.P68 === '') || (body.serial_number !== undefined && body.serial_number === '');

    if (!this.sid) await this.login();
    let body = await read();
    if (blind(body)) {
      await this.login();
      body = await read();
    }
    return { values: body || {}, stale: blind(body) };
  }

  async overview() {
    const started = Date.now();
    const view = {
      target: { host: this.host, port: this.port, label: this.label },
      firmware: 'v2',
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
      sources: { api: 'values.get' },
      notes: [],
      tookMs: 0,
      checkedAt: new Date().toISOString(),
    };

    try {
      await this.login();
      view.reachable = true;
      view.authenticated = true;
    } catch (err) {
      view.reachable = err.code !== 'ata_unreachable';
      view.state = err.code === 'ata_auth' ? 'auth' : 'unreachable';
      view.notes.push(err.message);
      view.tookMs = Date.now() - started;
      return view;
    }

    const { values, stale } = await this.values();
    if (stale) {
      view.state = 'stale';
      view.notes.push('The device accepted the session but returned no values at all, twice. Its console is running but its configuration is not readable in this state.');
      view.tookMs = Date.now() - started;
      return view;
    }

    view.state = 'online';
    // Trim before testing emptiness. The unit pads some values with spaces
    // (` 02:29:04 up 27 days`), and a value of " " is truthy — which briefly
    // made a port with no SIP user report as "configured" here.
    const value = (key) => {
      const raw = values[key];
      if (raw === undefined || raw === null) return null;
      const text = String(raw).trim();
      return text === '' ? null : text;
    };

    view.identity = {
      // Reported, not assumed. This unit answers `DP750` — a DECT base with ten
      // account slots and no FXS ports at all — and saying "HT802" here made a
      // whole console read as if it had two analog ports that never existed.
      model: value('phone_model') || 'unknown',
      firmware: value('P68'),
      serial: value('serial_number'),
      mac: null,
      // The unit reports ` 02:29:04 up 27 days`. Keep the part a person cares
      // about; the clock reading is noise in a stat card.
      uptime: (() => {
        const raw = value('P199');
        if (!raw) return null;
        const since = /\bup\s+(.+)$/i.exec(String(raw));
        return since ? since[1].trim() : String(raw).trim();
      })(),
      ip: this.host,
    };

    const profileServers = {};
    for (const n of [1, 2, 3, 4]) {
      const address = value(`profile.${n}.sip.server.1.address`);
      if (address) profileServers[String(n)] = address;
    }

    // One row per account the unit actually holds. An empty user id is an empty
    // slot, not a broken port: this box has ten of them and ships with two used.
    const ports = [];
    const accounts = [];
    for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
      const user = value(slot(ACCOUNT_BLOCK.user, i));
      if (!user) continue;
      const authId = value(slot(ACCOUNT_BLOCK.authId, i));
      const name = value(slot(ACCOUNT_BLOCK.name, i));
      const code = value(`P${ACCOUNT_STATUS + i}`);
      const profileId = value(`account.${i + 1}.sip.profile_id`);
      const registered = code === '1';
      const registration = STATUS_TEXT[code] || (code ? `state ${code}` : 'not registered');
      ports.push({
        port: i + 1,
        label: `Line ${i + 1}`,
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
        server: profileId === null ? null : profileServers[String(Number(profileId) + 1)] || null,
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
  async setAccount({ account, user, authId, secret, name } = {}) {
    const index = Number(account) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= ACCOUNT_SLOTS) {
      throw new AtaV2Error(`Account must be 1–${ACCOUNT_SLOTS}`, 'ata_account');
    }
    const id = String(user ?? '').trim();
    if (!id) throw new AtaV2Error('A SIP user id is required: it is what the line registers as', 'ata_account');

    if (!this.sid) await this.login();

    const fields = [
      [slot(ACCOUNT_BLOCK.user, index), id],
      [slot(ACCOUNT_BLOCK.authId, index), String(authId ?? id).trim() || id],
    ];
    if (name !== undefined && name !== null) fields.push([slot(ACCOUNT_BLOCK.name, index), String(name)]);
    if (secret) fields.push([slot(ACCOUNT_BLOCK.secret, index), String(secret)]);

    const form = [...fields.map(([key, val]) => `${key}=${encodeURIComponent(val)}`), `sid=${encodeURIComponent(this.sid)}`].join('&');
    const res = await this.#post('/cgi-bin/api.values.post', form);
    if (res.json?.response !== 'success') {
      throw new AtaV2Error(`The device refused the account write (${String(res.json?.body ?? res.status)})`, 'ata_account');
    }

    // A write is acknowledged before it is applied, so give the config a moment
    // and then read the numbers back rather than trusting the acknowledgement.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const keys = [slot(ACCOUNT_BLOCK.user, index), slot(ACCOUNT_BLOCK.authId, index), slot(ACCOUNT_BLOCK.name, index), `P${ACCOUNT_STATUS + index}`];
    const { values } = await this.values([...IDENTITY_FIELDS, ...keys]);
    const read = (key) => {
      const text = String(values[key] ?? '').trim();
      return text === '' ? null : text;
    };

    const applied =
      read(slot(ACCOUNT_BLOCK.user, index)) === id && read(slot(ACCOUNT_BLOCK.authId, index)) === (String(authId ?? id).trim() || id);
    return {
      account: index + 1,
      applied,
      user: read(slot(ACCOUNT_BLOCK.user, index)),
      authId: read(slot(ACCOUNT_BLOCK.authId, index)),
      name: read(slot(ACCOUNT_BLOCK.name, index)),
      registration: STATUS_TEXT[read(`P${ACCOUNT_STATUS + index}`)] || 'not registered',
      note: applied
        ? 'The unit holds the new identity. It re-registers on its own; no reboot is needed.'
        : 'The device acknowledged the write but did not store it. Its configuration is likely locked by provisioning.',
    };
  }
}

export default AtaV2;
