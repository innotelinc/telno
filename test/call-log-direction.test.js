/**
 * A carrier call is not an internal call, whatever context it walks through.
 *
 * The gateway's edge endpoint carries `context=from-internal` — the one context
 * that can ring a line by extension number — so an answered DID used to land in
 * `calls` as `direction: internal` with the dialplan's `PJSIP/webrtc-101,25,tT`
 * in the trunk column. The leg is what settles it: the call arrived on
 * `PJSIP/cantus-edge-…`, so it is inbound and the trunk column says
 * `cantus-edge`. These are the three directions the log has, driven by the
 * channel names the switch actually emits.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { directionFor, legFromChannel, mergeFields, trunkForChannel } = await import(
  '../src/telephony/call-log.js'
);

test('a carrier call through the edge is inbound, and names the edge', () => {
  // The live channel from the answered DID: the edge endpoint, eight-digit
  // sequence number and all, in the context the dialplan then uses.
  const channel = 'PJSIP/cantus-edge-0000002a';

  assert.equal(legFromChannel(channel), 'cantus-edge');
  assert.equal(directionFor('from-internal', channel), 'inbound');
  assert.equal(trunkForChannel(channel), 'cantus-edge');

  // A carrier leg that reaches the switch directly (no gateway) is inbound on
  // its context alone, and its trunk is named.
  assert.equal(directionFor('from-trunk'), 'inbound');
  assert.equal(trunkForChannel('PJSIP/trunk-voipms-0000002b'), 'voipms');
});

test('an outbound call is outbound, and names the trunk it left through', () => {
  assert.equal(directionFor('outbound'), 'outbound');
  assert.equal(directionFor('outbound', 'PJSIP/trunk-voipms-0000002c'), 'outbound');
  assert.equal(trunkForChannel('PJSIP/trunk-voipms-0000002c'), 'voipms');

  // An outbound call is never mistaken for inbound because it is on a trunk
  // leg: the context decides that, not the channel.
  assert.equal(directionFor('outbound', 'PJSIP/webrtc-101-0000002d'), 'outbound');
});

test('a call between two lines is internal, and has no trunk', () => {
  const channel = 'PJSIP/webrtc-101-0000002e';

  assert.equal(legFromChannel(channel), 'webrtc-101');
  assert.equal(directionFor('internal', channel), 'internal');
  assert.equal(trunkForChannel(channel), '');
  // A line's own leg is not a trunk, so it must not lend the column its name.
  assert.equal(trunkForChannel('PJSIP/webrtc-102-0000002f'), '');
});

test('the inbound leg wins the merge, whichever leg is heard first', () => {
  const edge = {
    direction: directionFor('from-internal', 'PJSIP/cantus-edge-00000030'),
    trunk: trunkForChannel('PJSIP/cantus-edge-00000030'),
    from_number: '4132642700',
    to_number: '101',
  };
  const line = {
    direction: directionFor('internal', 'PJSIP/webrtc-101-00000031'),
    trunk: trunkForChannel('PJSIP/webrtc-101-00000031'),
  };

  // Either arrival order must produce the same row: inbound, cantus-edge.
  for (const [first, second] of [
    [line, edge],
    [edge, line],
  ]) {
    const merged = mergeFields(first, second);
    assert.equal(merged.direction, 'inbound');
    assert.equal(merged.trunk, 'cantus-edge');
    assert.equal(merged.from_number, '4132642700');
    assert.equal(merged.to_number, '101');
  }
});
