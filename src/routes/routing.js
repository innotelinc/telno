import { createHash } from 'node:crypto';
import { routingDocument } from '../lib/routing.js';

/**
 * The routing document, for the machine that places the calls.
 *
 * This is the one endpoint the Cantus gateway reads. It is guarded like any
 * other machine surface — an API key with the `routing:read` scope, or a staff
 * session — because the document says which numbers this platform owns and
 * where each one goes, which is a map of the phone system.
 *
 * `ETag` and `no-store` together are deliberate: the gateway polls on its own
 * clock and a proxy must never answer from a cache, but the digest lets a caller
 * tell "same rules" from "rules changed" without diffing the body.
 */
export default async function routingRoutes(app) {
  app.get(
    '/routing/document',
    { preHandler: (request) => app.authenticateAny(request, 'routing:read') },
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
