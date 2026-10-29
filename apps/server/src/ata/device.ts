import { Ht802, memoryGuard, type RefusalGuard } from './ht802.js';
import { AtaV2 } from './v2.js';
import type { AtaFirmware, AtaOverview } from './types.js';

/**
 * One adaptor, whichever firmware is actually installed.
 *
 * Two HT802s were measured for this product and they do not share a protocol:
 *
 *   V1  1.0.x   mini_httpd, base64 `P2` login, JSON on `/cgi-bin/api-get_*`,
 *               responses with two status lines that no HTTP client accepts.
 *   V2  1.0.21  lighttpd over TLS, `username`/`password` login, a `sid` session
 *               and `/cgi-bin/api.values.get` with colon-separated P-numbers.
 *
 * Rather than ask an installer which one they plugged in, the platform asks the
 * box: the V2 console answers on 443 with a GWT shell, the V1 has no TLS at all.
 * Detection runs once per device object and the answer decides everything after.
 */

export class AtaUnsupported extends Error {
  override readonly name = 'AtaUnsupported';
  readonly code = 'ata_unsupported';

  constructor(message: string) {
    super(message);
  }
}

export interface AtaDeviceOptions {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  timeoutMs?: number;
  /** Durable store for refused passwords; the server passes a database-backed one. */
  guard?: RefusalGuard;
}

export class AtaDevice {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  private readonly guard: RefusalGuard;
  private impl: Ht802 | AtaV2 | null = null;
  private firmware: AtaFirmware | null = null;
  private detecting: Promise<Ht802 | AtaV2> | null = null;

  constructor({
    host,
    port = 80,
    username = 'admin',
    password = '',
    timeoutMs = 6000,
    guard = memoryGuard,
  }: AtaDeviceOptions) {
    if (!host) throw new Error('An ATA needs a host address');
    this.host = host;
    this.port = Number(port) || 80;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.guard = guard;
  }

  /** V2 first: it is the only one that speaks TLS on 443. */
  async detect(): Promise<Ht802 | AtaV2> {
    if (this.impl) return this.impl;
    if (this.detecting) return this.detecting;
    this.detecting = (async () => {
      const v2 = new AtaV2({
        host: this.host,
        port: 443,
        username: this.username,
        password: this.password,
        // Detection is a hint, not the read: a dead box must not cost two full
        // timeouts before the console can say it is unreachable.
        timeoutMs: Math.min(this.timeoutMs, 2500),
      });
      let isV2 = false;
      try {
        isV2 = await v2.detect();
      } catch {
        isV2 = false;
      }
      if (isV2) {
        this.impl = v2;
        this.firmware = 'v2';
      } else {
        this.impl = new Ht802({
          host: this.host,
          port: this.port,
          username: this.username,
          password: this.password,
          timeoutMs: this.timeoutMs,
          guard: this.guard,
        });
        this.firmware = 'v1';
      }
      return this.impl;
    })().finally(() => {
      this.detecting = null;
    });
    return this.detecting;
  }

  async overview({ refresh = false }: { refresh?: boolean } = {}): Promise<AtaOverview> {
    const impl = await this.detect();
    const view: AtaOverview =
      impl instanceof AtaV2 ? await impl.overview() : await impl.overview({ refresh });
    return { ...view, firmware: this.firmware ?? view.firmware };
  }

  /** Configuration pages exist only on the V1 console; the V2 has an API instead. */
  async page(id: string): Promise<{ status: number; html: string; headers: Record<string, string | string[]>; junk: string[] }> {
    const impl = await this.detect();
    if (impl instanceof AtaV2) {
      throw new AtaUnsupported(
        'This firmware has no configuration pages to read; it exposes its values through the API instead.',
      );
    }
    return impl.page(id);
  }

  async reboot(): Promise<{ status: number; accepted: boolean }> {
    const impl = await this.detect();
    if (impl instanceof AtaV2) {
      throw new AtaUnsupported(
        'Reboot is not wired for this firmware yet: its restart lives behind a numeric console operation that has not been verified.',
      );
    }
    return impl.reboot();
  }
}

export default AtaDevice;
