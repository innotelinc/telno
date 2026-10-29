import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { parseResponse, cookiesFrom } from '../src/ata/raw.js';
import { decodeEntities, formFields, Ht802, labelValuePairs, pick } from '../src/ata/ht802.js';
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
function fakeHt802(password: string) {
  const requests: string[] = [];
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

      const send = (text: string) => socket.end(text);

      if (path === '/') {
        return send(
          'HTTP/1.0 200 OK\r\nHTTP/1.1 200 OK\nContent-Type: text/html\r\n\r\n' +
            '<form action="dologin"><input name="gnkey" value="abc123"></form>',
        );
      }
      if (path === '/cgi-bin/api-get_lockouts') {
        return send(
          'HTTP/1.0 200 OK\r\n#!/bin/ash\nContent-Type: application/json\r\n\r\n' +
            '{"results":[{"locked":"false","remain":-3,"accessattempt":2,"invalidattempt":0}]}',
        );
      }
      if (path === '/cgi-bin/dologin') {
        const p2 = new URLSearchParams(body).get('P2') ?? '';
        const ok = Buffer.from(p2, 'base64').toString('utf8') === password;
        return ok
          ? send('HTTP/1.0 200 OK\r\nSet-Cookie: session_id=deadbeef; Path=/\r\n\r\n{"ok":1}')
          : send('HTTP/1.0 200 OK\r\n\r\nRemaining Attempts: 2');
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
  return { server, requests };
}

describe('HT802 session against a fake device', () => {
  it('signs in with the base64 P2 form and reports what it read', async () => {
    const { server, requests } = fakeHt802('s3cret');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 's3cret', timeoutMs: 2000 });
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

  it('reports a refused password without spending the last attempts', async () => {
    const { server } = fakeHt802('s3cret');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const device = new Ht802({ host: '127.0.0.1', port, password: 'wrong', timeoutMs: 2000 });
      const view = await device.overview();
      expect(view.authenticated).toBe(false);
      expect(view.state).toBe('auth');
      expect(view.notes.join(' ')).toMatch(/2 attempts left/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
