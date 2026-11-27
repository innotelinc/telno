/**
 * A parallel ring must not dial a desk phone that is not there.
 *
 * Every extension gets a desk endpoint and an AOR whether or not a handset ever
 * registers. Dialing `PJSIP/<num>` unconditionally asks chan_pjsip for a request
 * URI on an AOR with no contacts, and it falls back to the container's own
 * hostname, which does not resolve — so every inbound call logged
 * `getaddrinfo("telno")` and "No route to destination" before ringing the
 * browser. `PJSIP_DIAL_CONTACTS` is empty until a handset registers, so the desk
 * leg is only dialed when there is something to ring.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-ring-legs-'));
process.env.SESSION_SECRET = 'test-only-session-secret';

const { db_, newId } = await import('../src/db/index.js');
const { generateConfigs } = await import('../src/telephony/provision.js');

db_.run(
  'INSERT INTO extensions (id, extension, display_name, enabled) VALUES (?, ?, ?, 1)',
  [newId('ext_'), '101', 'Ring test line']
);

const dialLines = () =>
  generateConfigs()['extensions.conf']
    .split('\n')
    .filter((line) => line.includes('Dial(') && line.includes('webrtc-101'));

test('the desk leg is guarded by its registered contacts', () => {
  const lines = dialLines();
  assert.ok(lines.length >= 1, 'the extension is rang');

  for (const line of lines) {
    assert.match(line, /PJSIP_DIAL_CONTACTS\(101\)/, line);
    // The bug: an unconditional lead `PJSIP/101&` that Asterisk always dials.
    assert.equal(/Dial\(PJSIP\/101&/.test(line), false, line);
    // The browser leg is still dialed, so a browser-only extension stays reachable.
    assert.match(line, /PJSIP\/webrtc-101/, line);
  }
});

test('the generic extension pattern is guarded the same way', () => {
  const generic = generateConfigs()['extensions.conf']
    .split('\n')
    .find((line) => line.startsWith('exten => _1XX,1,Dial('));
  assert.ok(generic, 'the fallback pattern exists');
  assert.match(generic, /PJSIP_DIAL_CONTACTS\(\$\{EXTEN\}\)/, generic);
  assert.equal(/Dial\(PJSIP\/\$\{EXTEN\}&/.test(generic), false, generic);
});
