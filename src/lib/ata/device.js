import { Ht802 } from './ht802.js';
import { AtaV2 } from './v2.js';

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
 * Detection runs once per request object and the answer decides everything after.
 */

export const FIRMWARE = { v1: 'v1', v2: 'v2' };

export class AtaUnsupported extends Error {
  constructor(message) {
    super(message);
    this.name = 'AtaUnsupported';
    this.code = 'ata_unsupported';
  }
}

export class AtaDevice {
  constructor({ host, port = 80, username = 'admin', password = '', timeoutMs = 6000 } = {}) {
    if (!host) throw new Error('An ATA needs a host address');
    this.host = host;
    this.port = Number(port) || 80;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.impl = null;
    this.firmware = null;
    this.detecting = null;
  }

  /** V2 first: it is the only one that speaks TLS on 443. */
  async detect() {
    if (this.impl) return this.impl;
    if (this.detecting) return this.detecting;
    this.detecting = (async () => {
      const v2 = new AtaV2({ host: this.host, port: 443, username: this.username, password: this.password, timeoutMs: this.timeoutMs });
      let isV2 = false;
      try {
        isV2 = await v2.detect();
      } catch {
        isV2 = false;
      }
      if (isV2) {
        this.impl = v2;
        this.firmware = FIRMWARE.v2;
      } else {
        this.impl = new Ht802({ host: this.host, port: this.port, username: this.username, password: this.password, timeoutMs: this.timeoutMs });
        this.firmware = FIRMWARE.v1;
      }
      return this.impl;
    })().finally(() => {
      this.detecting = null;
    });
    return this.detecting;
  }

  async overview(opts = {}) {
    const impl = await this.detect();
    return { ...(await impl.overview(opts)), firmware: this.firmware };
  }

  /** Configuration pages exist only on the V1 console; the V2 has an API instead. */
  async page(id) {
    const impl = await this.detect();
    if (this.firmware === FIRMWARE.v2) {
      throw new AtaUnsupported('This firmware has no configuration pages to read; it exposes its values through the API instead.');
    }
    return impl.page(id);
  }

  async reboot() {
    const impl = await this.detect();
    if (this.firmware === FIRMWARE.v2) {
      throw new AtaUnsupported('Reboot is not wired for this firmware yet: its restart lives behind a numeric console operation that has not been verified.');
    }
    return impl.reboot();
  }
}

export default AtaDevice;
