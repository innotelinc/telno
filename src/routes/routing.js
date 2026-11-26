import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { routingDocument } from '../lib/routing.js';

/** Constant-time equality, because a token compared with `===` leaks its length. */
function sameToken(sent, expected) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(expected || ''));
  if (!a.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The routing document, for the machine that places the calls.
 *
 * There is one reader: the Cantus gateway, configured with `ROUTING_TOKEN` on
 * both sides. It is not a user and has no session, so a token is the honest
 * credential — an API key with the `routing:read` scope still works for anything
 * else that needs to read the same rules, but the gateway does not depend on the
 * key-hash machinery to place a call.
 *
 * `ETag` and `no-store` together are deliberate: the gateway polls on its own
 * clock and a proxy must never answer from a cache, but the digest lets a
 * caller tell "same rules" from "rules changed" without diffing the body.
 */
export default async function routingRoutes(app) {
  app.get(
    '/routing/document',
    {
      preHandler: async (request) => {
        if (config.routingToken && sameToken(request.headers['x-routing-token'], config.routingToken)) {
          request.apiKey = { label: 'cantus-gateway', scope: 'routing:read' };
          return;
        }
        return app.authenticateAny(request, 'routing:read');
      },
    },
    async (request, reply) => {
      const document = routingDocument();
      // The digest is over the rules, never over `generated_at`: a document
      // that says "read at 10:00:01" is not a different set of rules from the
      // same document at 10:00:31, and a cache that cannot tell them apart is
      // a poll that always looks like a change.
      const etag = `"${createHash('sha256')
        .update(JSON.stringify({ version: document.version, default: document.default, routes: document.routes }))
        .digest('hex')
        .slice(0, 32)}"`;
      reply.header('cache-control', 'no-store');
      reply.header('etag', etag);
      if (request.headers['if-none-match'] === etag) {
        reply.code(304);
        return '';
      }
      return document;
    }
  );
}
