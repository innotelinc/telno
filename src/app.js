import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { installAuth } from './plugins/auth.js';
import { errorHandler, forbidden, paymentRequired } from './lib/errors.js';
import { registerRoutes } from './routes/index.js';
import { registerWssRelay } from './telephony/wssRelay.js';
import { registerProvisioning } from './routes/provisioning.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'web', 'dist');

/**
 * The policy for the marketing page at the site root.
 *
 * It is not the console's policy: the page pulls its typeface from Google Fonts
 * and carries three inline scripts, and the console's `script-src 'self'` would
 * silently stop the year and the theme switch from running. The inline scripts
 * are allowed by the hash of their own text — computed here from the file that
 * is served, so it cannot drift from the markup — rather than by
 * `'unsafe-inline'`. The page renders no request data, so there is nothing on it
 * for markup injection to reach.
 *
 * Line endings are normalized before hashing, because that is what the browser
 * hashes: the HTML parser turns CRLF into LF while reading the document. Hashing
 * the file's raw Windows newlines instead produced hashes that matched nothing,
 * and the page loaded with its inline scripts silently refused.
 */
function landingPolicy(html) {
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].replace(/\r\n?/g, '\n'))
    .filter((body) => body.trim());
  const hashes = inline.map(
    (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
  );
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    `script-src 'self'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    "connect-src 'self'",
    "media-src 'self' blob: data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; ');
}

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProd ? 'warn' : 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Keep-alive has to outlast whatever is in front of this process. Node
    // closes an idle connection after 5 seconds by default, while nginx — and
    // Nginx Proxy Manager in particular — holds its upstream connections for
    // 90 seconds and reuses them. Every connection the proxy reuses just after
    // Node closed it is a request that dies as `recv() failed (104: Connection
    // reset by peer) while reading response header from upstream`, which the
    // browser sees as an intermittent 502 on a site that is otherwise healthy.
    // These sit above nginx's 90s so the proxy always decides first.
    keepAliveTimeout: 95_000,
  });
  // Fastify forwards keepAliveTimeout but drops headersTimeout, so the header
  // window is set on the server itself: headers have to be able to arrive for
  // as long as a keep-alive connection may live.
  app.server.headersTimeout = 96_000;

  await app.register(cookie, { secret: config.sessionSecret });
  // Softphone presence/intent channel. Registered at the root because the
  // upgrade happens before any route prefix is applied.
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  // Per-route limits only: the public directory must stay fast and cheap.
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // Audio and attachments arrive as a raw request body. The type decides the
  // stored extension, so only formats the platform understands are accepted.
  app.addContentTypeParser(
    ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/mp4', 'application/pdf', 'image/png', 'image/jpeg', 'image/tiff'],
    { parseAs: 'buffer', bodyLimit: config.mediaMaxBytes },
    (request, body, done) => done(null, body)
  );

  installAuth(app);

  // Baseline security headers. CSP is applied only for the built SPA so the
  // Vite dev server and its HMR websocket keep working.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    // The softphone needs the microphone and camera, and neither leaves the
    // page: geolocation stays off.
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(self), display-capture=(self)');
    // A response that already carries a policy keeps it: the site root serves
    // the marketing page, whose policy is not this one.
    if (config.isProd && !reply.hasHeader('content-security-policy')) {
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
          // wss: is the switch's secure WebSocket; a TURN relay is reached over
          // UDP by the peer connection, not by fetch, so nothing else opens up.
          "script-src 'self'; connect-src 'self' wss:; font-src 'self' data:; " +
          "media-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'self'"
      );
    }
    return payload;
  });

  app.setErrorHandler(errorHandler);

  await app.register(registerRoutes, { prefix: '/api' });

  // SIP over this origin. Registered at the root, before the static handler and
  // its wildcard, because the softphone connects here and not to the switch's
  // own port — see the module for why.
  registerWssRelay(app);

  // Desk phones fetch their config by MAC with no session. Root, before the
  // static handler, because Option 66 points at http://telno.tel itself.
  await registerProvisioning(app);

  if (existsSync(dist)) {
    // The marketing page from `web/landing` ships inside the image and is served
    // here, because the repository is private and GitHub Pages cannot publish a
    // private repository on a free plan — that is what took it offline. It does
    // not take over `/`: the install's own public site (pricing, signup, the
    // registry search) already answers there, and a static page would replace a
    // shop window with a brochure. Read once at boot: it is a file in this
    // image, and its inline scripts are hashed from the exact bytes served.
    const landingPath = join(dist, 'landing.html');
    const landingHtml = existsSync(landingPath) ? readFileSync(landingPath, 'utf8') : '';
    if (landingHtml) {
      const landingCsp = landingPolicy(landingHtml);
      const serveLanding = async (request, reply) => {
        reply.header('Content-Security-Policy', landingCsp);
        return reply.type('text/html').sendFile('landing.html', dist);
      };
      app.get('/landing', serveLanding);
      app.get('/landing/', serveLanding);
    }

    // `wildcard: true` matters: with per-file routes a hashed asset built after
    // startup is not registered, and the SPA fallback would answer a .js request
    // with index.html — the browser then refuses it as a bad MIME type.
    await app.register(fastifyStatic, { root: dist, wildcard: true, index: ['index.html'] });

    // The release image, for the installer the quickstart curls. A registry is
    // the better home for it and the installer prefers one when TELNO_IMAGE is
    // set, but a public registry can rate-limit the push — and an install path
    // that depends on somebody else's quota is not an install path. Releases
    // live on the data volume, outside the image (which would otherwise contain
    // a copy of itself), and are served with range support so a download
    // resume works.
    // Created at boot rather than left to whoever uploads a release: the gate
    // has to answer the same way on an install with no archive yet, so an
    // anonymous request is refused by the gate instead of falling through to a
    // 404 that depends on what happens to be on the volume.
    const releases = join(config.dataDir, 'releases');
    mkdirSync(releases, { recursive: true });
    // Behind the console, not public. The archive is the application itself —
    // source included — and the repository it is built from is private, so a URL
    // anyone could fetch would hand out the backend. A staff session or a key
    // minted for installs is required, and the check runs before the file is
    // looked up, so an anonymous request learns nothing about what is there.
    await app.register(
      async (scoped) => {
        scoped.addHook('preHandler', async (request) => {
          const account = app.readSession(request);
          if (account) {
            // Deliberately not the console's onboarding gate: fetching the
            // installer is how a second machine gets set up, and an operator
            // halfway through the wizard still needs it. Suspension applies.
            if (account.suspended_at) {
              throw paymentRequired('This account is suspended for non-payment');
            }
            if ((account.account_kind || 'staff') !== 'staff') {
              throw forbidden('The release archive is for the operator of this install');
            }
            return;
          }
          await app.authenticateAny(request, 'install');
        });
        await scoped.register(fastifyStatic, {
          root: releases,
          decorateReply: false,
          index: false,
          list: false,
        });
      },
      { prefix: '/download/' }
    );

    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
      }
      if (request.method !== 'GET') {
        return reply.status(405).send({ error: { code: 'method_not_allowed', message: 'Method not allowed' } });
      }
      // A stale page asking for an old hashed asset must get a 404, never
      // index.html: the browser rejects the HTML as a module script. Scoped to
      // /assets/ because /d/<host> paths legitimately end in a TLD. A release
      // that is not there is the same kind of answer: the installer has to be
      // told "no archive" rather than handed a page and told to load it.
      if (request.url.startsWith('/assets/') || request.url.startsWith('/download/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Unknown endpoint' } });
      }
      return reply
        .status(404)
        .type('text/plain')
        .send('UI not built yet. Run `npm run build`, or use `npm run dev:web` for the dev server.');
    });
  }

  app.get('/healthz', async () => ({ ok: true, uptime: Math.round(process.uptime()) }));

  return app;
}
