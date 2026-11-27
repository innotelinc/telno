/**
 * The relay's loopback source and the gateway peer's identify must not collide.
 *
 * chan_pjsip decides who a request is by source address before it looks at the
 * username, and this switch tells it to trust `identify 127.0.0.1` as the Cantus
 * gateway. The browser softphone reaches the switch through the app's relay on
 * loopback, so that relay takes a *second* loopback address (`127.0.0.2`); from
 * `127.0.0.1` every REGISTER is challenged as the gateway trunk and fails as
 * "Failed to authenticate" with a perfectly good line password.
 *
 * Two independent files have to keep agreeing for that to hold — the relay that
 * picks the source address and the provisioning that writes `match=` for the
 * edge. Either one drifting back is silent in production: registration just
 * stops, and nothing says why. This renders the real configuration, reads the
 * addresses the switch will actually claim, and requires the relay's source to be
 * outside all of them.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-pjsip-identify-'));
process.env.SESSION_SECRET = 'test-only-session-secret';
// The deployment's edge: the gateway registers and delivers DIDs from loopback.
process.env.CANTUS_SIP_EDGE = '127.0.0.1:5060';
process.env.CANTUS_EDGE_SECRET = 'test-only-edge-secret';

const { generateConfigs } = await import('../src/telephony/provision.js');
const { relaySourceFor, relayTarget } = await import('../src/telephony/wssRelay.js');

const toInt = (address) =>
  address.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;

/** Does an identify `match=` value claim `address`? */
const claims = (match, address) => {
  const [network, bits] = String(match).split('/');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(network) && /^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const size = bits === undefined ? 32 : Number(bits);
    const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
    return (toInt(network) & mask) === (toInt(address) & mask);
  }
  // Hostnames resolve before matching, and neither of the names loopback carries
  // is a different address from 127.0.0.1.
  const loopback = new Set(['localhost', '127.0.0.1']);
  return loopback.has(network) ? loopback.has(address) : network === address;
};

/** Every `match=` the edge's identify section puts in pjsip.conf. */
const edgeMatches = (pjsip) => {
  const matches = [];
  let section = null;
  for (const raw of pjsip.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    const match = line.match(/^match\s*=\s*(.+)$/);
    if (match && section === 'cantus-edge-identify') matches.push(match[1].trim());
  }
  return matches;
};

test('the relay reaches the switch from an address the gateway peer does not claim', () => {
  const matches = edgeMatches(generateConfigs()['pjsip.conf']);

  // The gateway keeps working: its identify is still the loopback address the
  // edge actually sends from.
  assert.deepEqual(matches, ['127.0.0.1'], 'the edge identify still names the gateway address');

  const source = relaySourceFor(relayTarget());
  assert.ok(source, 'the relay target is loopback, so the relay pins a loopback source');

  for (const match of matches) {
    assert.equal(
      claims(match, source),
      false,
      `the relay sources from ${source}, which identify match=${match} claims as the gateway`
    );
  }
});

test('the check would catch a widened identify, so passing means something', () => {
  const source = relaySourceFor(relayTarget());
  assert.equal(claims('127.0.0.1', source), false);
  // The ways this collision comes back: the peer claims all of loopback, or it
  // claims exactly the address the relay picked.
  assert.equal(claims('127.0.0.0/8', source), true);
  assert.equal(claims(`${source}/32`, source), true);
});
