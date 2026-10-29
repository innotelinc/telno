import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { env, repoRoot } from './env.js';
import { registerRoutes } from './routes.js';
import { recordEvent } from './db.js';
import { trustedNetworkText } from './security.js';

const app = Fastify({
  logger: {
    level: env.isProduction ? 'info' : 'warn',
    transport: undefined,
  },
  bodyLimit: 1024 * 1024,
  // Only the local terminator may set X-Forwarded-*: a client reaching the app
  // directly cannot spoof its own address and walk past the console allowlist.
  trustProxy: '127.0.0.1',
});

await app.register(cookie);

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'same-origin');
  return payload;
});

app.setErrorHandler((error, req, reply) => {
  req.log.error({ err: error }, 'request failed');
  if (reply.sent) return;
  const err = error as { statusCode?: number; message?: string };
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  reply.code(status).send({
    error: status === 500 ? 'internal error' : (err.message ?? 'request failed'),
  });
});

await app.register(registerRoutes);

// The console is a static build; in development Vite serves it on its own port
// and proxies /api and /prov here.
//
// Served by hand rather than with a static plugin: the surface is tiny, and a
// resolved-path containment check is easier to audit than a dependency.
const consoleDist = resolve(repoRoot, 'apps/console/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

if (existsSync(consoleDist)) {
  app.get('/*', async (req, reply) => {
    const url = (req.raw.url ?? '/').split('?')[0]!;
    if (url.startsWith('/api') || url.startsWith('/prov')) {
      return reply.code(404).send({ error: 'not found' });
    }

    let requested: string;
    try {
      requested = decodeURIComponent(url);
    } catch {
      return reply.code(400).send({ error: 'bad request' });
    }

    const relative = requested.replace(/^\/+/, '');
    const candidate = resolve(consoleDist, relative);
    const inside = candidate === consoleDist || candidate.startsWith(consoleDist + sep);

    if (inside && relative !== '' && existsSync(candidate) && statSync(candidate).isFile()) {
      reply.header('content-type', MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream');
      reply.header(
        'cache-control',
        relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return reply.send(createReadStream(candidate));
    }

    // Any other path is a console route: hand back the app shell.
    reply.header('content-type', MIME['.html']!);
    reply.header('cache-control', 'no-cache');
    return reply.send(createReadStream(resolve(consoleDist, 'index.html')));
  });
}

const shutdown = async (signal: string) => {
  app.log.warn(`received ${signal}, closing`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: env.port, host: env.host });
  recordEvent('system', 'success', `Control plane listening on http://${env.host}:${env.port}.`);

  // Settings are authoritative after first boot, so an edited .env silently
  // stops applying. Say so instead of leaving the operator with a stale list.
  const stored = trustedNetworkText();
  if (env.trustedNetworksExplicit && stored !== env.trustedNetworks) {
    console.warn(
      `Console allowlist: the saved setting (${stored}) differs from TELNO_TRUSTED_NETWORKS ` +
        `(${env.trustedNetworks}). Settings win — update it in Settings, or reset the database.`,
    );
  }
  console.log(`Telno control plane → http://${env.host}:${env.port}`);
  console.log(`Console build      → ${existsSync(consoleDist) ? consoleDist : 'not built (use the Vite dev server)'}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
