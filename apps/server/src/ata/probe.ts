import { adaptorRefusal, clearAdaptorRefusal, rememberAdaptorRefusal } from '../db.js';
import { env } from '../env.js';
import { AtaDevice } from './device.js';
import type { RefusalGuard } from './ht802.js';
import type { AtaOverview } from './types.js';

/**
 * Probing an adaptor costs several sockets to real hardware, and the console
 * asks for its state every time the detail view opens. Results are therefore
 * held briefly and a manual refresh bypasses the cache.
 */
const CACHE_MS = 20_000;

const cache = new Map<string, { at: number; view: AtaOverview }>();

const keyFor = (host: string, port: number): string => `${host}:${port}`;

/**
 * Refusals live in the database, not in this process.
 *
 * Five refused passwords cost fifteen minutes of the adaptor's console, and the
 * cost is paid by whoever owns the box — so the count must survive a restart or
 * a second process opening its own connection. In-memory state would let each
 * new process start from zero and spend the last attempts again.
 */
const refusalGuard: RefusalGuard = {
  get: (host) => adaptorRefusal(host),
  set: (host, value) => rememberAdaptorRefusal(host, value.at, value.count, value.key),
  clear: (host) => clearAdaptorRefusal(host),
};

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
    guard: refusalGuard,
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
    guard: refusalGuard,
  }).reboot();
  forgetAdaptor(target.host, port);
  return result;
}
