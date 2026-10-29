/**
 * CIDR matching for the console allowlist.
 *
 * Deliberately dependency-free and family-aware: an address is only compared
 * against networks of its own family, so an IPv4 entry can never accidentally
 * match an IPv6 caller. IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`, which is
 * how a dual-stack Node socket reports an IPv4 client) are normalised down to
 * IPv4 first.
 */

export type Family = 4 | 6;

export interface ParsedNetwork {
  family: Family;
  /** Network address, right-aligned in a 32- or 128-bit integer. */
  base: bigint;
  prefix: number;
  text: string;
}

const V4_BITS = 32n;
const V6_BITS = 128n;

function ipv4ToBigInt(input: string): bigint | null {
  const parts = input.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(input: string): bigint | null {
  const text = input.split('%')[0] ?? '';
  if (!text.includes(':')) return null;

  // An embedded IPv4 tail (::ffff:192.168.1.1) becomes two hextets.
  let expanded = text;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    expanded = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = expanded.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** Returns the address as an integer plus its family, or null if it is not an IP. */
export function parseAddress(input: string): { family: Family; value: bigint } | null {
  const text = input.trim().replace(/^\[|\]$/g, '');
  if (!text) return null;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  if (mapped) {
    const v4 = ipv4ToBigInt(mapped[1]!);
    return v4 === null ? null : { family: 4, value: v4 };
  }

  if (text.includes(':')) {
    const v6 = ipv6ToBigInt(text);
    return v6 === null ? null : { family: 6, value: v6 };
  }

  const v4 = ipv4ToBigInt(text);
  return v4 === null ? null : { family: 4, value: v4 };
}

export function parseNetwork(input: string): ParsedNetwork | null {
  const text = input.trim();
  if (!text) return null;
  const [addressPart, prefixPart] = text.split('/');
  const parsed = parseAddress(addressPart ?? '');
  if (!parsed) return null;

  const maxPrefix = parsed.family === 4 ? 32 : 128;
  const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;

  const bits = parsed.family === 4 ? V4_BITS : V6_BITS;
  // Clear the host bits so 192.168.1.17/24 and 192.168.1.0/24 are the same network.
  const shift = bits - BigInt(prefix);
  const base = (parsed.value >> shift) << shift;

  return { family: parsed.family, base, prefix, text };
}

export interface NetworkList {
  valid: ParsedNetwork[];
  invalid: string[];
}

export function parseNetworkList(raw: string | string[] | undefined): NetworkList {
  const entries =
    raw === undefined
      ? []
      : Array.isArray(raw)
        ? raw
        : raw.split(',');
  const valid: ParsedNetwork[] = [];
  const invalid: string[] = [];

  for (const entry of entries) {
    const text = String(entry).trim();
    if (!text) continue;
    const network = parseNetwork(text);
    if (network) valid.push(network);
    else invalid.push(text);
  }

  return { valid, invalid };
}

/** True only when the address falls inside one of the listed networks. */
export function isTrustedAddress(
  address: string | undefined | null,
  networks: ParsedNetwork[],
): boolean {
  if (!address || networks.length === 0) return false;
  const parsed = parseAddress(address);
  if (!parsed) return false;

  const bits = parsed.family === 4 ? V4_BITS : V6_BITS;
  for (const network of networks) {
    if (network.family !== parsed.family) continue;
    const shift = bits - BigInt(network.prefix);
    if ((parsed.value >> shift) << shift === network.base) return true;
  }
  return false;
}
