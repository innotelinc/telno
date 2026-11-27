/**
 * A call answered in the browser has to be joinable to the leg that delivered it.
 *
 * The softphone endpoint used to list `opus` first. Chrome answered with opus,
 * and the gateway delivered the DID as ulaw, so the bridge had no translation
 * path — "No path to translate from PJSIP/webrtc-101 to PJSIP/cantus-edge", the
 * call dropped after the ring timeout with nobody hearing anything. The image
 * ships res_format_attr_opus but not codec_opus, so there is no transcode to
 * fall back on: a codec this switch cannot reach must not be offered, or
 * answering a call appears to work and produces silence.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-softphone-codec-'));
process.env.SESSION_SECRET = 'test-only-session-secret';
process.env.CANTUS_SIP_EDGE = '127.0.0.1:5060';
process.env.CANTUS_EDGE_SECRET = 'test-only-edge-secret';

const { db_, newId } = await import('../src/db/index.js');
const { generateConfigs } = await import('../src/telephony/provision.js');

db_.run(
  'INSERT INTO extensions (id, extension, display_name, enabled) VALUES (?, ?, ?, 1)',
  [newId('ext_'), '101', 'Codec test line']
);

/**
 * pjsip.conf as section name → its setting lines. A name can appear more than
 * once (`[webrtc-101]` is both the endpoint and its AOR), and those are separate
 * sections to Asterisk, so their settings are collected together here.
 */
const sections = (pjsip) => {
  const out = new Map();
  let current = null;
  for (const raw of pjsip.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      current = header[1];
      if (!out.has(current)) out.set(current, []);
      continue;
    }
    if (current) out.get(current).push(line);
  }
  return out;
};

const allows = (lines = []) =>
  lines.filter((line) => line.startsWith('allow=')).map((line) => line.slice('allow='.length).trim());

const VIDEO = new Set(['vp8', 'vp9', 'h264', 'h263', 'h263p', 'mpeg4']);

test('the browser endpoint offers only audio the gateway leg can bridge', () => {
  const pjsip = generateConfigs()['pjsip.conf'];
  const sectionsByName = sections(pjsip);

  const audio = allows(sectionsByName.get('webrtc-101')).filter((codec) => !VIDEO.has(codec));
  const gateway = allows(sectionsByName.get('cantus-edge'));

  assert.ok(audio.length > 0, 'the softphone endpoint allows audio');
  assert.ok(gateway.length > 0, 'the gateway endpoint allows audio');
  for (const codec of audio) {
    assert.ok(
      gateway.includes(codec),
      `webrtc-101 offers ${codec}, which the gateway leg (${gateway.join('/')}) cannot bridge`
    );
  }
  // The specific regression: opus has an SDP attribute module here but no
  // codec module, so offering it silently wins the negotiation and loses the
  // call.
  assert.equal(audio.includes('opus'), false, 'no opus without codec_opus in the image');
});
