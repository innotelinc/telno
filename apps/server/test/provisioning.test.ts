import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { canonicalJson, signConfig } from '../src/provisioning.js';
import {
  buildRoutingDocument,
  validateLocally,
} from '../src/cantus.js';
import type { Line } from '@telno/shared';

describe('canonical JSON', () => {
  it('is independent of key order and nesting', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('drops undefined members so an omitted field cannot change the signature', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps array order significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('config signature', () => {
  it('is stable for the same body and key', () => {
    const key = Buffer.from('a'.repeat(32));
    const body = { version: 2, device: { serial: 'T750-2026-000418' } };
    expect(signConfig(body, key)).toBe(signConfig({ device: { serial: 'T750-2026-000418' }, version: 2 }, key));
  });

  it('matches an independent HMAC over the canonical form', () => {
    const key = Buffer.from('b'.repeat(32));
    const body = { z: 1, a: 'two' };
    const expected = createHmac('sha256', key).update('{"a":"two","z":1}').digest('hex');
    expect(signConfig(body, key)).toBe(expected);
  });

  it('changes when the body changes', () => {
    const key = Buffer.from('c'.repeat(32));
    expect(signConfig({ version: 1 }, key)).not.toBe(signConfig({ version: 2 }, key));
  });

  it('changes when the key changes', () => {
    expect(signConfig({ v: 1 }, Buffer.from('k1'))).not.toBe(signConfig({ v: 1 }, Buffer.from('k2')));
  });
});

const line = (over: Partial<Line>): Line => ({
  id: 'l1',
  extension: '101',
  aor: 'reception@telno.local',
  displayName: 'Reception',
  deviceId: 'd1',
  accountSlot: 1,
  routingMode: 'business-hours',
  forwardTo: null,
  businessHours: { start: '09:00', end: '17:00', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  enabled: true,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('routing document generation', () => {
  it('answers in hours and falls back after hours', () => {
    const doc = buildRoutingDocument({ lines: [line({})], domain: 'telno.local' });
    expect(doc.version).toBe(1);
    const names = doc.routes.map((r) => r.name);
    expect(names).toEqual(['101-business-hours', '101-after-hours']);
    expect(doc.routes[0]!.when).toMatchObject({
      to: 'reception@telno.local',
      verified: true,
      time: '09:00-17:00',
    });
    // No forward target: after hours rejects as UNAVAILABLE (reason 4).
    expect(doc.routes[1]!.then).toEqual([{ reject: 4 }]);
    expect(validateLocally(doc)).toEqual([]);
  });

  it('forwards to voicemail when asked', () => {
    const doc = buildRoutingDocument({
      lines: [line({ routingMode: 'voicemail' })],
      domain: 'telno.local',
    });
    expect(doc.routes[0]!.then).toEqual([{ forward: { to: 'voicemail@telno.local' } }]);
  });

  it('rejects unknown destinations with NOT_FOUND (reason 2)', () => {
    const doc = buildRoutingDocument({ lines: [], domain: 'telno.local' });
    expect(doc.default).toEqual({ reject: 2 });
    expect(doc.routes).toEqual([]);
  });

  it('skips disabled lines', () => {
    const doc = buildRoutingDocument({ lines: [line({ enabled: false })], domain: 'telno.local' });
    expect(doc.routes).toEqual([]);
  });

  it('rejects a document with a vendor-only predicate', () => {
    const errors = validateLocally({
      version: 1,
      routes: [{ name: 'x', when: { dialplan: 's' }, then: [{ answer: {} }] }],
    });
    expect(errors.join(' ')).toContain("unknown predicate 'dialplan'");
  });

  it('rejects an action that is not a single-key object', () => {
    const errors = validateLocally({
      version: 1,
      routes: [{ name: 'x', when: {}, then: [{ answer: {}, reject: 1 }] }],
    });
    expect(errors.join(' ')).toContain('single-key');
  });
});
