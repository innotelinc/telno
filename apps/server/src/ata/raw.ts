import net from 'node:net';

/**
 * A deliberately literal HTTP client for Grandstream analog adaptors.
 *
 * Ported from the Telno container stack, where it was measured against a live
 * HT802 (mini_httpd 1.30, firmware 1.0.x). The device does not speak HTTP as a
 * client library understands it:
 *
 *   HTTP/1.0 200 OK\r\n
 *   HTTP/1.1 200 OK\n          <- a second status line inside the response
 *   Content-Type: text/html; charset=utf-8\n
 *   Server: Grandstream/1.10\n
 *   \n
 *   \n
 *   <html>...
 *
 * and on the JSON endpoints the CGI's own shebang line is emitted where a
 * header belongs:
 *
 *   HTTP/1.0 200 OK\r\n
 *   #!/bin/ash
 *   Cache-Control: no-cache, must-revalidate\r\n
 *   Content-Type: application/json\r\n
 *
 * Undici (and therefore `fetch`), curl and every mainstream client reject that
 * as a protocol error: curl reports "Header without colon" and hands back an
 * empty body, which is exactly how a working login looks like a broken device.
 * So the only reliable way to talk to this box is to read the bytes and parse
 * them forgivingly: mixed CRLF/LF, repeated status lines, header-shaped junk,
 * no Content-Length, and truncation handled by the socket closing.
 *
 * Everything here is intentionally the smallest thing that survives that: one
 * request per connection, a hard deadline, and a parser that keeps what it can.
 */

/** Raised when the device cannot be reached at all, as opposed to answering badly. */
export class AtaTransportError extends Error {
  override readonly name = 'AtaTransportError';
  readonly code = 'ata_unreachable';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  /** Header-shaped lines that were not headers — the leaked shebang lands here. */
  junk: string[];
  body: string;
}

export interface RawRequest {
  host: string;
  port?: number;
  method?: 'GET' | 'POST';
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

const STATUS = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/;

/**
 * Split a raw response into status, headers and body.
 *
 * The header block ends at the first blank line under either line ending. A
 * line that is shaped like a status line replaces the current status (the last
 * one wins, which is the device's own CGI rather than mini_httpd's wrapper). A
 * line with a colon is a header; anything else — the leaked shebang — is
 * recorded under `junk` instead of being thrown away, because it is evidence
 * about the firmware and costs nothing to keep.
 */
export function parseResponse(text: string): RawResponse {
  const crlfEnd = text.indexOf('\r\n\r\n');
  const lfEnd = text.indexOf('\n\n');
  let headerEnd: number;
  let bodyStart: number;
  if (crlfEnd === -1 && lfEnd === -1) {
    headerEnd = text.length;
    bodyStart = text.length;
  } else if (crlfEnd === -1) {
    headerEnd = lfEnd;
    bodyStart = lfEnd + 2;
  } else if (lfEnd === -1) {
    headerEnd = crlfEnd;
    bodyStart = crlfEnd + 4;
  } else if (crlfEnd <= lfEnd) {
    headerEnd = crlfEnd;
    bodyStart = crlfEnd + 4;
  } else {
    headerEnd = lfEnd;
    bodyStart = lfEnd + 2;
  }

  const headerBlock = text.slice(0, headerEnd);
  const body = text.slice(bodyStart);

  let status = 0;
  let statusText = '';
  const headers: Record<string, string | string[]> = {};
  const junk: string[] = [];

  for (const line of headerBlock.split(/\r?\n/)) {
    if (!line) continue;
    const statusMatch = STATUS.exec(line);
    if (statusMatch) {
      status = Number(statusMatch[1]);
      statusText = statusMatch[2] ?? '';
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      const existing = headers[name];
      if (existing === undefined) headers[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else headers[name] = [existing, value];
      continue;
    }
    junk.push(line);
  }

  return { status, statusText, headers, junk, body };
}

/** Every Set-Cookie value, whether the server repeated the header or not. */
export function cookiesFrom(headers: RawResponse['headers']): string[] {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((line) => line.split(';')[0]?.trim() ?? '')
    .filter(Boolean);
}

type Connector = {
  connect(options: { host: string; port: number }): net.Socket;
};

/**
 * One request, one connection, one deadline.
 *
 * `latin1` is not an oversight: the device labels pages `utf-8` but writes
 * Windows-1252 widget names and firmware strings, and decoding those as UTF-8
 * would replace the bytes with U+FFFD before anything could quote them.
 */
export function request(
  { host, port = 80, method = 'GET', path = '/', headers = {}, body = '', timeoutMs = 6000 }: RawRequest,
  socketImpl: Connector = net,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];

    const socket = socketImpl.connect({ host, port });
    let deadline: NodeJS.Timeout;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        socket.destroy();
      } catch {
        /* the socket may already be gone */
      }
      if (err) reject(err);
      else resolve(parseResponse(Buffer.concat(chunks).toString('latin1')));
    };

    deadline = setTimeout(
      () => finish(new AtaTransportError(`${host}:${port} did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.on('connect', () => {
      const payload = Buffer.from(body, 'latin1');
      const lines = [
        `${method} ${path} HTTP/1.0`,
        `Host: ${host}`,
        'Connection: close',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ];
      if (payload.length) lines.push(`Content-Length: ${payload.length}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
      if (payload.length) socket.write(payload);
    });
    socket.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.on('error', (err: Error) =>
      finish(new AtaTransportError(`${host}:${port} refused or reset the connection`, err)),
    );
    socket.on('close', () => finish());
  });
}

export default request;
