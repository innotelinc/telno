import { env } from '../env.js';
import { AtaDevice } from './device.js';
import type { AtaOverview } from './types.js';

/**
 * Probing an adaptor costs several sockets to real hardware, and the console
 * asks for its state every time the detail view opens. Results are therefore
 * held briefly and a manual refresh bypasses the cache.
 */
const CACHE_MS = 20_000;

const cache = new Map<string, { at: number; view: AtaOverview }>();

const keyFor = (host: string, port: number): string => `${host}:${port}`;

export interface AdaptorTarget {
  host: string;
  port?: number;
  password?: string;
  username?: string;
}

/** Drop the cached view, e.g. after a reboot the box is definitely not as it was. */
export function forgetAdaptor(host: string, port = 80): void {
  cache.delete(keyFor(host, port));
}

export async function probeAdaptor(
  target: AdaptorTarget,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<AtaOverview & { cached: boolean }> {
  const port = target.port ?? 80;
  const key = keyFor(target.host, port);
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) {
    return { ...hit.view, cached: true };
  }

  const view = await new AtaDevice({
    host: target.host,
    port,
    username: target.username ?? env.ataUser,
    password: target.password ?? env.ataPassword,
    timeoutMs: env.ataTimeoutMs,
  }).overview({ refresh });

  cache.set(key, { at: Date.now(), view });
  return { ...view, cached: false };
}

/** Reboot, and forget the cached view because the device is going down. */
export async function rebootAdaptor(
  target: AdaptorTarget,
): Promise<{ status: number; accepted: boolean }> {
  const port = target.port ?? 80;
  const result = await new AtaDevice({
    host: target.host,
    port,
    username: target.username ?? env.ataUser,
    password: target.password ?? env.ataPassword,
    timeoutMs: env.ataTimeoutMs,
  }).reboot();
  forgetAdaptor(target.host, port);
  return result;
}
