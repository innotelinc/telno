import { describe, expect, it } from 'vitest';
import {
  isTrustedAddress,
  parseAddress,
  parseNetwork,
  parseNetworkList,
} from '../src/networks.js';

const list = (raw: string) => parseNetworkList(raw).valid;
const trusted = (ip: string, raw: string) => isTrustedAddress(ip, list(raw));

describe('address parsing', () => {
  it('accepts IPv4 and gets the family right', () => {
    expect(parseAddress('192.168.1.17')).toEqual({ family: 4, value: 0xc0a80111n });
  });

  it('rejects malformed IPv4', () => {
    expect(parseAddress('192.168.1.256')).toBeNull();
    expect(parseAddress('192.168.1')).toBeNull();
    expect(parseAddress('not-an-ip')).toBeNull();
  });

  it('normalises IPv4-mapped IPv6 down to IPv4', () => {
    expect(parseAddress('::ffff:127.0.0.1')).toEqual({ family: 4, value: 0x7f000001n });
    expect(parseAddress('::ffff:192.168.1.5')).toEqual({ family: 4, value: 0xc0a80105n });
  });

  it('understands IPv6 including the loopback form', () => {
    expect(parseAddress('::1')).toEqual({ family: 6, value: 1n });
    expect(parseAddress('fe80::1')).toEqual({ family: 6, value: 0xfe800000000000000000000000000001n });
  });
});

describe('network parsing', () => {
  it('clears host bits so the same prefix is one network', () => {
    const a = parseNetwork('192.168.1.17/24');
    const b = parseNetwork('192.168.1.0/24');
    expect(a?.base).toBe(b?.base);
  });

  it('defaults to a single host when no prefix is given', () => {
    expect(parseNetwork('10.1.2.3')?.prefix).toBe(32);
    expect(parseNetwork('::1')?.prefix).toBe(128);
  });

  it('refuses out-of-range prefixes', () => {
    expect(parseNetwork('10.0.0.0/33')).toBeNull();
    expect(parseNetwork('10.0.0.0/-1')).toBeNull();
    expect(parseNetwork('10.0.0.0/oops')).toBeNull();
  });

  it('reports unparsable entries rather than dropping them silently', () => {
    const parsed = parseNetworkList('127.0.0.1/32, nonsense ,192.168.1.0/24');
    expect(parsed.valid).toHaveLength(2);
    expect(parsed.invalid).toEqual(['nonsense']);
  });
});

describe('allowlist matching', () => {
  const configured = '127.0.0.1/32,::1/128,192.168.1.0/24';

  it('allows loopback', () => {
    expect(trusted('127.0.0.1', configured)).toBe(true);
    expect(trusted('::1', configured)).toBe(true);
  });

  it('allows an address inside the subnet, including the edges', () => {
    expect(trusted('192.168.1.17', configured)).toBe(true);
    expect(trusted('192.168.1.1', configured)).toBe(true);
    expect(trusted('192.168.1.254', configured)).toBe(true);
  });

  it('refuses the neighbouring subnet', () => {
    expect(trusted('192.168.2.17', configured)).toBe(false);
    expect(trusted('192.168.0.17', configured)).toBe(false);
  });

  it('refuses public addresses and link-local addresses', () => {
    expect(trusted('203.0.113.9', configured)).toBe(false);
    expect(trusted('8.8.8.8', configured)).toBe(false);
    expect(trusted('169.254.1.1', configured)).toBe(false);
  });

  it('does not let an IPv4 rule match an IPv6 caller', () => {
    expect(trusted('2001:db8::1', '0.0.0.0/0')).toBe(false);
    expect(trusted('2001:db8::1', '::/0')).toBe(true);
  });

  it('fails closed for empty or absent input', () => {
    expect(trusted('127.0.0.1', '')).toBe(false);
    expect(isTrustedAddress(undefined, list(configured))).toBe(false);
    expect(isTrustedAddress('127.0.0.1', [])).toBe(false);
  });

  it('treats IPv4-mapped peers as IPv4', () => {
    expect(trusted('::ffff:192.168.1.17', configured)).toBe(true);
    expect(trusted('::ffff:10.9.9.9', configured)).toBe(false);
  });
});
