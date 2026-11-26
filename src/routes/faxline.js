import http from 'node:http';
import { URL } from 'node:url';
import { db_, now } from '../db/index.js';
import { unauthorized } from '../lib/errors.js';

/**
 * Faxline is a separate process; the console is the only door to it.
 *
 * Two things live here. `/faxline/*` reverse-proxies the workspace behind this
 * app's session, so there is one sign-in and a fax page is not a second login;
 * the proxy strips its own prefix and adds a shared token, and the upstream
 * refuses everything without that token. `/api/faxline/numbers` is the other
 * direction: the registry's fax-capable DIDs, in the shape the workspace reads,
 * so a number's capabilities come from one row rather than two inventories.
 */

const PREFIX = '/faxline';

export async function registerFaxlineProxy(app) {
  const token = (process.env.FAXLINE_TOKEN || '').trim();
  const upstream = new URL(process.env.FAXLINE_URL || 'http://127.0.0.1:4322');

  // Called by the Faxline process, never by a browser: the token is compared
  // here and never leaves the two servers.
  app.get('/api/faxline/numbers', async (request) => {
    if (!token || request.headers['x-faxline-token'] !== token) {
      throw unauthorized('The fax workspace presents its console token to read numbers');
    }
    const rows = db_.all(
      "SELECT * FROM numbers WHERE fax_mode IN ('fax', 'auto') ORDER BY e164",
    );
    return {
      numbers: rows.map((row) => ({
        id: row.id,
        e164: row.e164,
        label: row.label || row.region || 'Telno number',
        region: row.region || '',
        country: row.country || '',
        status: row.status,
        // The registry's answer, in the words the workspace shows: 'auto'
        // answers voice and hands a T.38 call to the fax receiver, 'fax' is a
        // fax-only DID. Both send and receive.
        faxMode: row.fax_mode,
        provider: row.provider || '',
        monthlyCostCents: row.monthly_cost_cents || 0,
      })),
      generatedAt: now(),
    };
  });

  const proxy = async (request, reply) => {
    try {
      await app.authenticate(request);
    } catch {
      // A browser asking for the page gets the console's login; an API caller
      // gets an answer it can parse.
      if (String(request.headers.accept || '').includes('text/html')) {
        return reply.redirect('/login');
      }
      return reply.code(401).send({ error: 'Sign in to the Telno console to open the fax workspace' });
    }

    // Strip the mount prefix: the workspace is written to be served at its own
    // root and the token tells it that the console vouches for this request.
    const path = request.raw.url.replace(PREFIX, '') || '/';
    const headers = {
      ...request.headers,
      host: upstream.host,
      'x-faxline-token': token,
      'x-forwarded-prefix': PREFIX,
      'x-forwarded-host': request.headers.host || '',
      'x-forwarded-proto': request.protocol || 'http',
    };

    reply.hijack();
    const proxied = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path,
        method: request.method,
        headers,
      },
      (response) => {
        reply.raw.writeHead(response.statusCode || 502, response.headers);
        response.pipe(reply.raw);
      },
    );
    proxied.on('error', () => {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      reply.raw.end('The fax workspace is not answering on the console host.');
    });
    if (request.raw.readableEnded) proxied.end();
    else request.raw.pipe(proxied);
    return reply;
  };

  app.all(PREFIX, (request, reply) => reply.redirect(`${PREFIX}/`));
  app.all(`${PREFIX}/*`, proxy);
}

export default registerFaxlineProxy;
