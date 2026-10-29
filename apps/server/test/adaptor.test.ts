import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { parseResponse, cookiesFrom } from '../src/ata/raw.js';
import {
  credentialKey,
  decodeEntities,
  formFields,
  Ht802,
  labelValuePairs,
  pick,
} from '../src/ata/ht802.js';
import { ACCOUNT_BLOCK, ACCOUNT_SLOTS, AtaV2, accountFields, accountSlot } from '../src/ata/v2.js';
import { voiceProfileFor } from '../src/voice.js';

/**
 * These tests cover the two things that were learned from real hardware and are
 * easy to "clean up" into being wrong: the malformed HTTP the box writes, and
 * the fact that an analog adaptor cannot be handed a cantus profile.
 */

describe('raw response parsing', () => {
  it('takes the device CGI status when two status lines are present', () => {
    const res = parseResponse(
      'HTTP/1.0 200 OK\r\nHTTP/1.1 404 Not Found\nContent-Type: text/html\r\n\r\n<html>body</html>',
    );
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Not Found');
    expect(res.body).toBe('<html>body</html>');
  });

  it('keeps the leaked CGI shebang as evidence instead of failing the request', () => {
    const res = parseResponse(
      'HTTP/1.0 200 OK\r\n#!/bin/ash\nContent-Type: application/json\r\n\r\n{"results":[{"locked":"false"}]}',
    );
    expect(res.status).toBe(200);
    expect(res.junk).toEqual(['#!/bin/ash']);
    expect(JSON.parse(res.body).results[0].locked).toBe('false');
  });

  it('accepts a header block terminated by bare line feeds', () => {
    const res = parseResponse('HTTP/1.0 301 Moved\nLocation: /cgi-bin/home\n\n');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/cgi-bin/home');
  });

  it('collects every Set-Cookie, repeated or not', () => {
    expect(cookiesFrom({ 'set-cookie': 'a=1; Path=/' })).toEqual(['a=1']);
    expect(cookiesFrom({ 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] })).toEqual(['a=1', 'b=2']);
    expect(cookiesFrom({})).toEqual([]);
  });
});

describe('page scraping', () => {
  it('reads two-cell rows and inline labels without duplicating them', () => {
    const pairs = labelValuePairs(
      '<tr><td>Product Model</td><td>HT802</td></tr><b>SIP User ID 1:</b> 201',
    );
    expect(pick(pairs, ['product model'])).toBe('HT802');
    expect(pick(pairs, ['sip user id 1'])).toBe('201');
  });

  it('decodes entities the old console writes', () => {
    expect(decodeEntities('A &amp; B &lt;c&gt;')).toBe('A & B <c>');
  });

  it('matches a label whose punctuation differs', () => {
    const pairs = labelValuePairs('<tr><td>Software Version:</td><td>1.0.1.33</td></tr>');
    expect(pick(pairs, ['software version'])).toBe('1.0.1.33');
  });

  it('omits buttons, which a save would not send back', () => {
    const fields = formFields(
      '<input name="P2" value="secret"><input type="submit" name="save" value="Save">',
    );
    expect(fields).toEqual({ P2: 'secret' });
  });
});

const settings = {
  domain: 'telno.local',
  timezone: 'Europe/London',
  ntp: 'pool.ntp.org',
  voiceNode: 'voice.telno.local',
  voicePort: 7443,
  relay: 'relay.telno.local:7443',
  documentId: 'doc-1',
  routingRevision: 3,
};

describe('voice profile per model', () => {
  it('gives the desk phone cantus, unchanged', () => {
    const voice = voiceProfileFor('t750', settings);
    expect(voice.transport).toBe('cantus/1');
    expect(voice.transport === 'cantus/1' && voice.node).toBe('voice.telno.local');
  });

  it('gives the analog adaptor SIP, because it has no cantus stack', () => {
    const voice = voiceProfileFor('ht802', settings);
    expect(voice.transport).toBe('sip');
    expect(voice.transport === 'sip' && voice.codecs).toEqual(['pcmu/8000', 'pcma/8000']);
  });

  it('points the adaptor at the SIP edge when one is configured', () => {
    const voice = voiceProfileFor('ht802', { ...settings, sipEdge: 'edge.telno.local', sipPort: 5061 });
    if (voice.transport !== 'sip') throw new Error('expected a SIP profile');
    expect(voice.server).toBe('edge.telno.local');
    expect(voice.port).toBe(5061);
    expect(voice.note).toContain('edge.telno.local');
  });

  it('falls back to the domain and says so when no edge exists', () => {
    const voice = voiceProfileFor('ht802', settings);
    if (voice.transport !== 'sip') throw new Error('expected a SIP profile');
    expect(voice.server).toBe('telno.local');
    expect(voice.port).toBe(5060);
    expect(voice.note).toMatch(/no sip edge/i);
  });
});

/**
 * A stand-in for the real box, reproducing the two things that break normal
 * clients: a doubled status line and a CGI shebang where a header belongs.
 * This is what makes the login handshake testable without hardware.
 */
function fakeHt802(password: string, remaining = 4, legacy = false) {
  const requests: string[] = [];
  const bodies: string[] = [];
  const sessionToken = 'tok123';
  const gnkey = 'abc123';
  const loginForm = legacy
    ? `<form action="/cgi-bin/dologin" method="post" name="loginForm">
         <input name="P2" type="password" id="input-password">
         <input type="submit" name="Login" value="Login">
         <input name="gnkey" type="hidden" value="${gnkey}"></form>`
    : `<form action="dologin" method="post" name="loginForm">
         <input type="hidden" name="session_token" value="${sessionToken}">
         <input name="username" type="text" value="admin">
         <input name="P2" type="password" id="input-password">
         <input type="submit" name="Login" value="Login">
         <input name="gnkey" type="hidden" value="${gnkey}"></form>`;

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headEnd = buffer.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const head = buffer.slice(0, headEnd);
      const [, method = '', path = ''] = /^(\w+) (\S+)/.exec(head) ?? [];
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
      if (buffer.length < headEnd + 4 + length) return;
      const body = buffer.slice(headEnd + 4, headEnd + 4 + length);
      requests.push(`${method} ${path}`);
      if (body) bodies.push(body);

      const send = (text: string) => socket.end(text);
      const page = (html: string) =>
        send('HTTP/1.0 200 OK\r\nHTTP/1.1 200 OK\nContent-Type: text/html\r\n\r\n' + html);

      if (path === '/cgi-bin/login') {
        return legacy ? send('HTTP/1.0 404 Not Found\r\n\r\n') : page(loginForm);
      }
      if (path === '/') return page(loginForm);
      if (path === '/cgi-bin/api-get_lockouts') {
        return send(
          'HTTP/1.0 200 OK\r\n#!/bin/ash\nContent-Type: application/json\r\n\r\n' +
            '{"results":[{"locked":"false","remain":-3,"accessattempt":2,"invalidattempt":0}]}',
        );
      }
      if (path === '/cgi-bin/dologin') {
        const params = new URLSearchParams(body);
        const passwordOk = Buffer.from(params.get('P2') ?? '', 'base64').toString('utf8') === password;
        // The 1.0.x console rejects the short form even when the password is
        // right, which is exactly the failure this client has to reproduce.
        const formOk =
          legacy || (params.get('username') === 'admin' && params.get('session_token') === sessionToken);
        return passwordOk && formOk
          ? send('HTTP/1.0 200 OK\r\nSet-Cookie: session_id=deadbeef; Path=/\r\n\r\n{"ok":1}')
          : send(`HTTP/1.0 200 OK\r\n\r\nRemaining Attempts: ${remaining}`);
      }
      if (path === '/cgi-bin/api-get_system_status') {
        return send('HTTP/1.0 200 OK\r\n\r\n{"results":[{"vsz":"16480","command":"ata"}]}');
      }
      if (path === '/cgi-bin/api-get_sip') {
        return send('HTTP/1.0 200 OK\r\n\r\n{"results":[{"exist":"true"}]}');
      }
      if (path === '/cgi-bin/information') {
        return send(
          'HTTP/1.0 200 OK\r\n\r\n' +
            '<tr><td>Product Model</td><td>HT802</td></tr>' +
            '<tr><td>Software Version</td><td>1.0.1.33</td></tr>' +
            '<tr><td>Serial Number</td><td>000B82123456</td></tr>' +
            '<tr><td>MAC Address</td><td>00:0B:82:12:34:56</td></tr>',
        );
      }
      if (path === '/cgi-bin/status' || path === '/cgi-bin/account') {
        return send('HTTP/1.0 301 Moved\r\n\r\n');
      }
      return send('HTTP/1.0 404 Not Found\r\n\r\n');
    });
  });
  return { server, requests, bodies };
}

describe('HT802 session against a fake device', () => {
  it('signs in with the base64 P2 form and reports what it read', async () => {
    const { server, requests } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      const view = await device.overview();

      expect(view.state).toBe('online');
      expect(view.identity?.model).toBe('HT802');
      expect(view.identity?.serial).toBe('000B82123456');
      expect(view.system?.voiceImage).toBe('16480');
      expect(view.sip?.exists).toBe(true);
      expect(view.lock?.locked).toBe(false); // locked=true with a negative timer means the window passed
      expect(requests).toContain('POST /cgi-bin/dologin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends the username and per-page token the 1.0.x console asks for', async () => {
    const { server, bodies } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      expect((await device.overview()).authenticated).toBe(true);
      const login = bodies.find((body) => body.includes('P2=')) ?? '';
      // Posting only P2 + gnkey is rejected as a wrong password on this
      // firmware, so the token and username must travel with it.
      expect(login).toContain('username=admin');
      expect(login).toContain('session_token=tok123');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('signs in to the older console that asks for P2 and gnkey alone', async () => {
    const { server } = fakeHt802(FIXTURE_PASSWORD, 4, true);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      expect((await device.overview()).authenticated).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a refused password without spending the last attempts', async () => {
    const { server } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 2000 });
      const view = await device.overview();
      expect(view.authenticated).toBe(false);
      expect(view.state).toBe('auth');
      expect(view.notes.join(' ')).toMatch(/4 attempts left/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('refused passwords are not retried', () => {
  const guardFor = () => {
    const rows = new Map<string, { at: number; count: number; key?: string }>();
    return {
      rows,
      get: (host: string) => rows.get(host),
      set: (host: string, value: { at: number; count: number; key?: string }) => {
        rows.set(host, value);
      },
      clear: (host: string) => {
        rows.delete(host);
      },
    };
  };

  it('records which credential was refused', async () => {
    const { server } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = guardFor();

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 2000, guard });
      await device.overview();
      const stored = guard.rows.get(`127.0.0.1:${port}`);
      expect(stored?.count).toBe(1);
      expect(stored?.key).toBe(credentialKey('wrong'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops entirely once the device says only two attempts remain', async () => {
    const { server } = fakeHt802(FIXTURE_PASSWORD, 2);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = guardFor();

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 2000, guard });
      await device.overview();
      // One more refusal would cost fifteen minutes of that console, so the
      // remaining attempts belong to a human, not to a retry loop.
      expect(guard.rows.get(`127.0.0.1:${port}`)?.count).toBe(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('never counts a missing password as a refusal', async () => {
    const { server, requests } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = guardFor();

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: '', timeoutMs: 2000, guard });
      const view = await device.overview();
      // Reachable but unsignable: no credential, so nothing was rejected.
      expect(view.state).toBe('reachable');
      expect(guard.rows.size).toBe(0);
      expect(requests).not.toContain('POST /cgi-bin/dologin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends no password while that same credential is cooling down', async () => {
    const { server, requests } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = guardFor();
    guard.set(`127.0.0.1:${port}`, { at: Date.now(), count: 1, key: credentialKey('wrong') });

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 2000, guard });
      const view = await device.overview();
      expect(view.authenticated).toBe(false);
      expect(view.notes.join(' ')).toMatch(/counting failed attempts/);
      expect(requests).not.toContain('POST /cgi-bin/dologin');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('lets a corrected password through, even after attempts were exhausted', async () => {
    const { server, requests } = fakeHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const guard = guardFor();
    // Three refused cycles would normally stop every further attempt.
    guard.set(`127.0.0.1:${port}`, { at: Date.now(), count: 3, key: credentialKey('outdated') });

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000, guard });
      const view = await device.overview();
      expect(view.authenticated).toBe(true);
      expect(requests).toContain('POST /cgi-bin/dologin');
      expect(guard.rows.get(`127.0.0.1:${port}`)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * Firmware 1.0.21.4: the login POST answers with the status page itself, the
 * FXS tabs are `config_a1`/`config_a2`, and each port's SIP account is a pile of
 * `P<n>` inputs. This is the shape measured on the real unit at 192.168.1.45.
 */
function fakeModernHt802(password: string) {
  const requests: string[] = [];
  const session = 'modern-session';
  const landing =
    '<table>' +
    '<tr><td align=right><b>MAC Address: </b></td><td>&nbsp; C0:74:AD:3E:D8:20 </td></tr>' +
    '<tr><td>Product Model</td><td>HT802</td></tr>' +
    '<tr><td>Serial Number</td><td>207GHQYM103ED820</td></tr>' +
    '<tr><td>Software Version</td><td>Program -- 1.0.21.4</td></tr>' +
    '<tr><td align=right>Port</td><td align=center>Hook</td><td>User ID</td></tr>' +
    '<tr><td>FXS 1</td><td>On Hook</td><td>15000</td></tr>' +
    '</table>' +
    '<a href="config2">BASIC SETTINGS</a>' +
    '<a href="config_a1">FXS PORT</a>' +
    '<a href="config_a2">FXS PORT2</a>';
  const fxs = (server: string, user: string, localPort: string, active: string, offset: boolean) =>
    '<form>' +
    `<input type="text" name="P${offset ? 735 : 35}" value="${user}">` +
    `<input type="text" name="P${offset ? 740 : 40}" value="${localPort}">` +
    `<input type="text" name="P${offset ? 747 : 47}" value="${server}">` +
    `<input type="text" name="P${offset ? 401 : 271}" value="${active}">` +
    '</form>';

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const headEnd = buffer.indexOf('\r\n\r\n');
      if (headEnd === -1) return;
      const head = buffer.slice(0, headEnd);
      const [, method = '', path = ''] = /^(\w+) (\S+)/.exec(head) ?? [];
      const cookie = /cookie:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '';
      requests.push(`${method} ${path}`);
      const send = (text: string) => socket.end(text);
      const page = (html: string) => send(`HTTP/1.0 200 OK\r\nContent-Type: text/html\r\n\r\n${html}`);

      if (path === '/cgi-bin/api-get_lockouts') {
        return send(
          'HTTP/1.0 200 OK\r\n#!/bin/ash\n\r\n' +
            '{"results":[{"locked":"false","remain":877,"accessattempt":5,"invalidattempt":0}]}',
        );
      }
      if (path === '/cgi-bin/api-get_system_status') {
        return send('HTTP/1.0 200 OK\r\n\r\n{"results":[{"vsz":"16472","command":"ata"}]}');
      }
      if (path === '/cgi-bin/api-get_sip') {
        return send('HTTP/1.0 200 OK\r\n\r\n{"results":[{"exist":"false"}]}');
      }
      if (path === '/' || path === '/cgi-bin/login') {
        return page(
          `<form action="dologin" method="post"><input type="hidden" name="session_token" value="tok"><input name="username" value="admin"><input name="P2" type="password"><input name="gnkey" value="0b82"></form>`,
        );
      }
      if (path === '/cgi-bin/dologin') {
        const body = buffer.slice(headEnd + 4);
        const params = new URLSearchParams(body);
        const ok = Buffer.from(params.get('P2') ?? '', 'base64').toString('utf8') === password;
        return ok
          ? send(`HTTP/1.0 200 OK\r\nSet-Cookie: session_id=${session}; Path=/\r\n\r\n${landing}`)
          : send('HTTP/1.0 200 OK\r\n\r\nRemaining Attempts: 4');
      }
      // Without the cookie this console answers a bare redirect, exactly as the
      // real unit does when its single session is taken by another request.
      if (path === '/cgi-bin/config_a1' && cookie.includes(session)) {
        return page(fxs('192.168.1.30', '15000', '5060', '1', false));
      }
      if (path === '/cgi-bin/config_a2' && cookie.includes(session)) {
        return page(fxs('', '', '5061', '0', true));
      }
      return send('HTTP/1.0 301 Moved\r\n\r\n');
    });
  });
  return { server, requests };
}

describe('HT802 firmware 1.0.21.4, as measured on the real unit', () => {
  it('reads the MAC row that neighbouring-cell scraping used to drop', async () => {
    const { server } = fakeModernHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      const view = await device.overview();
      expect(view.state).toBe('online');
      expect(view.identity?.serial).toBe('207GHQYM103ED820');
      expect(view.identity?.mac).toBe('C0:74:AD:3E:D8:20');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports both FXS ports from their P-values, in the order the console lists them', async () => {
    const { server } = fakeModernHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      const view = await device.overview();
      expect(view.accounts.map((account) => account.port)).toEqual([1, 2]);
      expect(view.accounts[0]).toMatchObject({
        server: '192.168.1.30',
        user: '15000',
        active: '1',
        localPort: '5060',
      });
      expect(view.accounts[1]).toMatchObject({ server: null, user: null, active: '0' });
      expect(view.ports[0]).toMatchObject({ port: 1, enabled: true, sipUser: '15000', hook: 'On Hook' });
      expect(view.ports[1]).toMatchObject({ port: 2, enabled: false, registration: 'no SIP user' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('signs in again when the console answers a page with a bare redirect', async () => {
    const { server, requests } = fakeModernHt802(FIXTURE_PASSWORD);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: FIXTURE_PASSWORD, timeoutMs: 2000 });
      await device.login();
      // A stale cookie: the next page read is redirected, and the client has to
      // recover rather than silently report a port that does not exist.
      (device as unknown as { cookie: string }).cookie = 'session_id=stale';
      const page = await device.open('config_a1');
      expect(page.status).toBe(200);
      expect(page.html).toContain('P35');
      expect(requests.filter((entry) => entry === 'POST /cgi-bin/dologin')).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/**
 * The account block is the part that took the longest to get right, because the
 * firmware accepts writes to the dotted names and silently ignores them. These
 * tests pin the parameters that were read off the real unit.
 */
describe('the account block the TLS firmware writes', () => {
  it('maps line 1 and line 2 onto the parameter numbers read from the unit', () => {
    expect(accountSlot(ACCOUNT_BLOCK.user, 0)).toBe('P4060');
    expect(accountSlot(ACCOUNT_BLOCK.user, 1)).toBe('P4061');
    expect(accountSlot(ACCOUNT_BLOCK.authId, 0)).toBe('P4090');
    expect(accountSlot(ACCOUNT_BLOCK.secret, 1)).toBe('P4121');
    expect(accountSlot(ACCOUNT_BLOCK.name, 0)).toBe('P4180');
  });

  it('asks for the live registration state of every slot', () => {
    const fields = accountFields();
    for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
      expect(fields).toContain(`P${4921 + i}`);
    }
  });

  it('never asks the device for a password, which it would answer in clear text', () => {
    const fields = accountFields();
    for (let i = 0; i < ACCOUNT_SLOTS; i += 1) {
      expect(fields).not.toContain(`P${4120 + i}`);
    }
  });

  it('refuses a line the unit does not have before spending a login attempt', async () => {
    const device = new AtaV2({ host: '127.0.0.1', password: 'x' });
    await expect(device.setAccount({ account: ACCOUNT_SLOTS + 1, user: '201' })).rejects.toThrow(/1–10/);
    await expect(device.setAccount({ account: 0, user: '201' })).rejects.toThrow(/1–10/);
  });

  it('refuses an empty user id rather than writing a blank identity', async () => {
    const device = new AtaV2({ host: '127.0.0.1', password: 'x' });
    await expect(device.setAccount({ account: 1, user: '   ' })).rejects.toThrow(/SIP user id is required/);
  });
});

/*
 * What the fakes answer to and the drivers sign in with. Generated per run
 * rather than written down: a literal here is a password-shaped string in a
 * committed file that secret scanning reports on every branch touching this
 * test, and no test needs it to be a fixed value. Fake and driver read the same
 * constant, so they still agree on the password.
 */
const FIXTURE_PASSWORD = crypto.randomUUID();
