import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { env, repoRoot } from './env.js';
import { registerRoutes } from './routes.js';
import { recordEvent } from './db.js';
import { trustedNetworkText } from './security.js';
import { requireSession } from './auth.js';
import { parseRange, resolveRelease } from './releases.js';

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

// The install surface: the installer a fresh host curls, the compose file it
// starts from, and the .env template. Public on purpose — none of the three is
// a secret — and served out of this image, because a host with nothing on it
// cannot read them out of a repository it does not have.
//
// install.sh carries a @VERSION@ placeholder so the copy served here names the
// release this platform actually is, rather than the one the file was written
// beside in the tree.
const INSTALL_FILES: Record<string, { file: string; type: string }> = {
  '/install.sh': { file: 'deploy/install.sh', type: 'text/plain; charset=utf-8' },
  '/docker-compose.yml': { file: 'docker-compose.yml', type: 'text/yaml; charset=utf-8' },
  '/docker-compose.desktop.yml': {
    file: 'docker-compose.desktop.yml',
    type: 'text/yaml; charset=utf-8',
  },
  '/env.example': { file: '.env.example', type: 'text/plain; charset=utf-8' },
};
const releaseVersion =
  (JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version?: string }).version ??
  '';

for (const [url, served] of Object.entries(INSTALL_FILES)) {
  app.get(url, async (_req, reply) => {
    const file = resolve(repoRoot, served.file);
    if (!existsSync(file)) return reply.code(404).send({ error: `not found: ${served.file}` });
    reply.header('content-type', served.type);
    // An installer is fetched by a host that has none, so a cached copy from a
    // previous version would install the version it was cached at.
    reply.header('cache-control', 'no-cache');
    // LF even when the tree was checked out on Windows: this lands in a shell
    // script and in compose's .env parser, both of which read a stray CR as
    // part of the line.
    return reply.send(
      readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replaceAll('@VERSION@', releaseVersion),
    );
  });
}

// The release image, for an installer that fetches it from a running install
// instead of a registry. Releases live on the data volume, outside the image
// (which would otherwise contain a copy of itself), and are served with range
// support so an interrupted download resumes.
//
// Created at boot rather than left to whoever uploads a release: the gate has
// to answer the same way on an install with no archive yet, so an anonymous
// request is refused by the gate rather than falling through to a 404 that
// depends on what happens to be on the volume.
const releasesDir = resolve(env.releasesDir);
mkdirSync(releasesDir, { recursive: true });

// Registered twice rather than as an array: Fastify's shorthand takes one path,
// and `/download` with no trailing slash has to answer the same way as a path
// under it instead of falling through to the console shell.
const sendRelease = async (req: FastifyRequest, reply: FastifyReply) => {
  // Behind the console, not public — and the session is checked before the
  // path is resolved, so an anonymous caller cannot probe which releases
  // exist. The allowlist applies as it does to every console route: the
  // machine fetching an archive has to be able to reach the console.
  if (!requireSession(req, reply)) return reply;

  const release = resolveRelease(releasesDir, req.raw.url ?? '');
  if (!release) return reply.code(404).send({ error: 'no release archive at that path' });

  const range = parseRange(req.headers.range, release.size);
  // Answered before the archive headers go on: a 416 carries a JSON body, and
  // an octet-stream content type would make Fastify refuse to send it.
  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .header('content-range', `bytes */${release.size}`)
      .send({ error: 'range not satisfiable' });
  }

  reply.header('content-type', 'application/octet-stream');
  reply.header('accept-ranges', 'bytes');
  // The archive is bytes, not a page: a stale link must never be answered with
  // the console shell and a browser told to load it as a script.
  reply.header('cache-control', 'no-store');
  reply.header('content-disposition', `attachment; filename="${basename(release.file)}"`);

  if (range) {
    reply.code(206);
    reply.header('content-range', `bytes ${range.start}-${range.end}/${release.size}`);
    reply.header('content-length', String(range.end - range.start + 1));
    return reply.send(createReadStream(release.file, { start: range.start, end: range.end }));
  }
  reply.header('content-length', String(release.size));
  return reply.send(createReadStream(release.file));
};

app.get('/download', sendRelease);
app.get('/download/*', sendRelease);

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
