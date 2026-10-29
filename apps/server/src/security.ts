import { getSetting, setSetting } from './db.js';
import { env } from './env.js';
import { isTrustedAddress, parseNetworkList, type ParsedNetwork } from './networks.js';

/**
 * Console access control.
 *
 * The allowlist governs who may talk to the *console* API. It deliberately does
 * not govern `/prov`, because devices legitimately live on the network this
 * list restricts; they authenticate with their own bearer token instead.
 *
 * The list lives in settings (seeded from the environment) so an operator can
 * tighten it from the UI without a restart.
 */

export const TRUSTED_KEY = 'security.trustedNetworks';

export function trustedNetworkText(): string {
  return getSetting(TRUSTED_KEY, env.trustedNetworks);
}

export function trustedNetworks(): ParsedNetwork[] {
  return parseNetworkList(trustedNetworkText()).valid;
}

export function isTrusted(address: string | undefined | null): boolean {
  return isTrustedAddress(address, trustedNetworks());
}

export interface AllowlistUpdate {
  ok: boolean;
  error?: string;
  value?: string;
}

/** Validates before storing: an unparsable or empty list would lock everyone out. */
export function setTrustedNetworks(raw: string): AllowlistUpdate {
  const parsed = parseNetworkList(raw);
  if (parsed.invalid.length) {
    return { ok: false, error: `Not a network: ${parsed.invalid.join(', ')}` };
  }
  if (parsed.valid.length === 0) {
    return { ok: false, error: 'Keep at least one allowed network' };
  }
  const value = parsed.valid.map((network) => network.text).join(',');
  setSetting(TRUSTED_KEY, value);
  return { ok: true, value };
}

/** Convenience for the console: is this list effectively "anywhere"? */
export function allowsEverything(networks: ParsedNetwork[]): boolean {
  return networks.some((network) => network.prefix === 0);
}
