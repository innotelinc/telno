/**
 * The relay must not arrive at the switch from the gateway's address.
 *
 * chan_pjsip decides identity by address before it looks at the username, and a
 * switch with a gateway peer is told to trust `identify 127.0.0.1`. A relay that
 * connects from that same address is therefore challenged as the trunk, and the
 * phone's REGISTER fails as "Failed to authenticate" with a correct password.
 *
 *   npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'telno-wss-relay-'));
process.env.SESSION_SECRET = 'test-only-session-secret';

const { relaySourceFor } = await import('../src/telephony/wssRelay.js');
const { WebSocket } = await import('ws');

test('a loopback switch is reached from a different loopback address', () => {
  const source = relaySourceFor('wss://127.0.0.1:8089/ws');
  assert.equal(source, '127.0.0.2');
  // Anything the gateway's identify could claim is the bug we are avoiding.
  assert.notEqual(source, '127.0.0.1');
  assert.equal(relaySourceFor('wss://localhost:8089/ws'), '127.0.0.2');
  assert.equal(relaySourceFor('wss://[::1]:8089/ws'), '127.0.0.2');
});

test('a switch on another host is reached from this host as usual', () => {
  assert.equal(relaySourceFor('wss://switch.example.com:8089/ws'), undefined);
  assert.equal(relaySourceFor('not a url'), undefined);
});

test('the switch sees the relay on the address the peer does not own', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const seen = new Promise((resolve) => {
    server.once('connection', (socket, request) => {
      resolve(request.socket.remoteAddress);
      socket.close();
    });
  });

  const url = `ws://127.0.0.1:${port}/ws`;
  const client = new WebSocket(url, ['sip'], { localAddress: relaySourceFor(url) });
  client.on('error', () => {});

  assert.equal(await seen, '127.0.0.2');
  client.terminate();
  await new Promise((resolve) => server.close(resolve));
});
